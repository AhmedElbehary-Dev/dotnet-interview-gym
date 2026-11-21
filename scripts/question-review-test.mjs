import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { questionFingerprint, readJson } from './build-question-index.mjs';
import { planGeneration } from './plan-question-generation.mjs';
import { reviewBatch, reviewDimensions } from './review-question-candidates.mjs';
import { allowedDocumentationUrl, inspectDocumentation, publicAddress, readDocumentation, verifyDocumentation } from './review-documentation.mjs';

const root = process.cwd();
const model = 'openai/gpt-oss-20b';
const key = 'gsk_mock_key_never_write_this';
const source = 'https://learn.microsoft.com/dotnet/csharp/language-reference/operators/type-testing-and-cast';
const quote = 'The is operator checks if the runtime type of an expression result is compatible with a given type.';
const learnHtml = `<main id="main">
  <nav><p>A navigation passage about runtime type compatibility.</p></nav>
  <ul><li>The <code>is</code> operator checks if the runtime type of an expression result is compatible with a given type.</li></ul>
  <table><tr><td>Use <code>&#x69;s</code> to test type compatibility.</td></tr></table>
</main>`;
const resolver = { resolve4: async () => ['93.184.216.34'] };
const documentationResponse = (statusCode, html = '', headers = {}) => (_url, _options, callback) => {
  const req = new EventEmitter();
  req.end = () => {
    const res = Object.assign(new EventEmitter(), {
      statusCode, headers: { 'content-type': 'text/html', ...headers }, destroy() {}
    });
    callback(res);
    res.emit('data', Buffer.from(html));
    res.emit('end');
  };
  return req;
};
const env = { GROQ_API_KEY: key, GROQ_REVIEW_FREE_PLAN: '1', QUESTION_REVIEW_CODE_POLICY: 'hold-unverified' };
const fullPlan = planGeneration(root, { date: '2026-11-21', seed: 'review' });
const positive = () => ({
  verdict: 'approve', actualAnswer: 0,
  findings: {
    ...Object.fromEntries(reviewDimensions.map(name => [name, { status: 'pass', reason: 'The evidence supports this finding.' }])),
    documentation: { status: 'pass', reason: 'The passage supports the answer.', evidence: 'sufficient' }
  },
  citations: [{ source: 0, quote }]
});
const completion = (review = positive(), reportedModel = model) => Response.json({
  model: reportedModel, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(review) } }]
});

function fixture(t, count = 1, mutate = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'interview-gym-review-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const plan = structuredClone({ ...fullPlan, targets: fullPlan.targets.slice(0, count) });
  const candidates = plan.targets.map((target, i) => {
    const q = {
      ...target, q: `What does the type compatibility check test in case ${i}?`,
      options: ['Runtime type compatibility', 'Value equality', 'Object identity', 'Reference count'],
      answer: 0, hint: 'راجع نوع القيمة', why: 'الاختبار بيحدد إذا كان النوع وقت التشغيل متوافق مع النوع المذكور في السؤال.',
      sourceUrls: [source]
    };
    return { ...q, fingerprint: questionFingerprint(q), batchDate: plan.date,
      generation: { provider: 'groq', requestedModel: 'qwen/qwen3.8-27b', reportedModel: 'qwen/qwen3.8-27b', seed: plan.seed },
      sourceVerification: 'unverified' };
  });
  const batch = { schemaVersion: 1, status: 'complete', plan, candidates };
  mutate(batch);
  const input = join(directory, 'candidates.json');
  writeFileSync(input, JSON.stringify(batch));
  const run = options => reviewBatch(root, input, {
    env, fetchImpl: async () => completion(), documentReader: async () => [quote],
    outputParent: directory, ...options
  });
  return { directory, input, run, batch };
}

test('approves a documented candidate and atomically stages provenance without changing the input or bank', async t => {
  const { run, batch, input, directory } = fixture(t);
  const bank = readdirSync('questions').map(file => [file, readFileSync(join('questions', file))]);
  const original = readFileSync(input);
  const { path, report } = await run({ fetchImpl: async (_url, { body }) => {
    const payload = JSON.parse(body);
    assert.equal(payload.model, model);
    assert.equal(payload.response_format.type, 'json_schema');
    const { strict, schema } = payload.response_format.json_schema;
    assert.equal(strict, true);
    function checkClosedObjects(node) {
      if (node.type === 'object') {
        assert.equal(node.additionalProperties, false);
        assert.deepEqual(node.required, Object.keys(node.properties));
        Object.values(node.properties).forEach(checkClosedObjects);
      }
      if (node.items) checkClosedObjects(node.items);
      node.anyOf?.forEach(checkClosedObjects);
    }
    checkClosedObjects(schema);
    assert.equal(Object.hasOwn(JSON.parse(payload.messages[1].content).question, 'answer'), false);
    return completion();
  } });
  assert(path.startsWith(directory));
  assert.equal(basename(path), 'review.json');
  assert.deepEqual(readdirSync(dirname(path)), ['review.json']);
  assert.deepEqual(JSON.parse(readFileSync(path)), report);
  const [entry] = report.entries;
  assert.equal(entry.decision, 'approved');
  assert.deepEqual(entry.candidate, batch.candidates[0]);
  assert.equal(entry.reviewModel, model);
  assert.equal(entry.diagnostics[0].finishReason, 'stop');
  assert.equal(entry.diagnostics[0].failureCategory, null);
  assert.ok(entry.reviewedAt);
  assert.deepEqual(entry.gates.documentation, 'passed');
  assert.deepEqual(readFileSync(input), original);
  for (const [file, content] of bank) assert.deepEqual(readFileSync(join('questions', file)), content);
});

for (const [name, mutate, decision, reason] of [
  ['incorrect answer', r => { r.actualAnswer = 1; r.verdict = 'reject'; r.findings.answer.status = 'fail'; }, 'rejected', 'reviewer_rejected'],
  ['ambiguous question', r => { r.verdict = 'uncertain'; r.findings.ambiguity.status = 'uncertain'; }, 'needs_review', 'reviewer_uncertain'],
  ['incorrect explanation', r => { r.verdict = 'reject'; r.findings.explanation.status = 'fail'; }, 'rejected', 'reviewer_rejected'],
  ['unsupported source claim', r => { r.citations[0].quote = 'A quote never supplied to the reviewer.'; }, 'needs_review', 'unsupported_citation'],
  ['semantic duplicate', r => { r.verdict = 'reject'; r.findings.duplication.status = 'fail'; }, 'rejected', 'reviewer_rejected'],
  ['invalid reviewer metadata', r => { r.candidateId = 'fabricated'; }, 'needs_review', 'invalid_review'],
  ['conflicting positive verdict', r => { r.actualAnswer = 1; }, 'needs_review', 'answer_disagreement']
]) {
  test(name, async t => {
    const { run } = fixture(t);
    const review = positive();
    mutate(review);
    const { report } = await run({ fetchImpl: async () => completion(review) });
    assert.equal(report.entries[0].decision, decision);
    assert.equal(report.entries[0].reason, reason);
  });
}

const reviewEnvelope = content => ({
  model, choices: [{ finish_reason: 'stop', message: { content } }],
  usage: { prompt_tokens: 321, completion_tokens: 123, total_tokens: 444 }
});
const extraField = 'question_or_provider_text_must_not_appear';
const invalidShape = { ...positive(), [extraField]: key.slice(4) };
const missingField = positive();
delete missingField.findings.code.reason;
const invalidReason = positive();
invalidReason.findings.code.reason = 'short';

for (const [label, response, reason, field, rule, finish] of [
  ['malformed response envelope', () => new Response('{'), 'invalid_json', '$', 'json_envelope', null],
  ['invalid completion JSON', () => Response.json(reviewEnvelope('{')), 'invalid_json', '$.choices[0].message.content', 'json_output', 'stop'],
  ['empty completion', () => Response.json(reviewEnvelope(' ')), 'empty_output', '$.choices[0].message.content', 'nonempty', 'stop'],
  ['empty response envelope', () => new Response(null), 'empty_response', '$', 'nonempty', null],
  ['missing nested finding property', () => completion(missingField), 'missing_review_field', '$.findings.code.reason', 'required', 'stop'],
  ['invalid nested finding value', () => completion(invalidReason), 'invalid_review', '$.findings.code.reason', 'bounded_text', 'stop'],
  ['unexpected reviewer property', () => completion(invalidShape), 'invalid_review', '$', 'unexpected_field', 'stop'],
  ['truncated completion', () => Response.json({ ...reviewEnvelope('{'), choices: [{ finish_reason: 'length' }] }), 'truncated', undefined, undefined, 'length'],
  ['API error envelope', () => Response.json({ error: { message: extraField } }), 'provider_error', undefined, undefined, null],
  ['ordinary HTTP API error', () => Response.json({ error: { message: extraField } }, { status: 400 }), 'http_error', undefined, undefined, null],
  ['unsupported model parameter', () => Response.json({ error: {
    code: 'unsupported_parameter', param: 'response_format', message: extraField + key
  } }, { status: 400 }), 'unsupported_model_parameters', 'request.response_format', 'unsupported_parameter', null],
  ['unsupported Groq parameter in message', () => Response.json({ error: {
    message: 'reasoning_effort is not supported with this model. ' + extraField
  } }, { status: 422 }), 'unsupported_model_parameters', 'request.reasoning_effort', 'unsupported_parameter', null]
]) {
  test(`strict review diagnoses ${label} without exposing response data`, async t => {
    const { run, batch } = fixture(t);
    const logs = [];
    const { report, path } = await run({ fetchImpl: async () => response(), log: event => logs.push(event) });
    const [entry] = report.entries;
    assert.equal(entry.reason, reason);
    assert.equal(entry.decision, 'needs_review');
    assert.equal(entry.findings, null);
    assert.equal(logs.length, 1);
    assert.deepEqual(entry.diagnostics, logs);
    assert.equal(logs[0].failureCategory, reason);
    assert.equal(logs[0].requestedModel, model);
    assert.equal(logs[0].finishReason, finish);
    assert.deepEqual(logs[0].validation, field ? { field, rule } : undefined);
    if (reason === 'invalid_json' && finish === 'stop') {
      assert.equal(logs[0].reportedModel, model);
      assert.deepEqual(logs[0].usage, { prompt_tokens: 321, completion_tokens: 123, total_tokens: 444 });
    }
    assert(!readFileSync(path, 'utf8').includes(extraField));
    for (const privateValue of [extraField, key, batch.candidates[0].q]) {
      assert(!JSON.stringify(logs).includes(privateValue));
    }
  });
}

test('strict Groq review holds a positive response without supporting documentation', async t => {
  const { run } = fixture(t);
  const review = { ...positive(), citations: [] };
  const { report } = await run({ fetchImpl: async () => completion(review) });
  assert.equal(report.entries[0].reason, 'unsupported_citation');
  assert.equal(report.entries[0].decision, 'needs_review');
  assert.equal(report.entries[0].gates.documentation, 'evidence_retrieved');
});

test('Microsoft Learn list and table text supports an exact quotation through review', async t => {
  const { run } = fixture(t);
  const documentReader = url => readDocumentation(url, { resolver, requestImpl: documentationResponse(200, learnHtml) });
  const passages = await documentReader(source);
  assert.deepEqual(passages, [quote, 'Use is to test type compatibility.']);
  const events = [];
  const { report } = await run({
    documentReader: url => inspectDocumentation(url, { resolver, requestImpl: documentationResponse(200, learnHtml) }),
    logDocumentation: event => events.push(event)
  });
  const [entry] = report.entries;
  assert.equal(entry.decision, 'approved');
  assert.deepEqual(events, [{
    candidate: 1, source: 0, httpStatus: 200, outcome: 'evidence_retrieved',
    passageCount: 2, suppliedPassageCount: 2, failureCategory: null
  }]);
  assert.deepEqual(entry.documentationDiagnostics, events);
});

test('a changed quotation retains validated findings and the citation diagnostic', async t => {
  const { run } = fixture(t);
  const review = positive();
  review.citations[0].quote = quote.replace('checks', 'verifies');
  const { report, path } = await run({ fetchImpl: async () => completion(review) });
  const [entry] = report.entries;
  assert.equal(entry.reason, 'unsupported_citation');
  assert.equal(entry.decision, 'needs_review');
  assert.deepEqual(entry.findings.findings, review.findings);
  assert.deepEqual(entry.findings.citations, []);
  assert.equal(entry.diagnostics[0].httpStatus, 200);
  assert.equal(entry.diagnostics[0].finishReason, 'stop');
  assert.equal(entry.diagnostics[0].failureCategory, 'unsupported_citation');
  assert.deepEqual(entry.diagnostics[0].validation, { field: '$.citations[0].quote', rule: 'retrieved_passage' });
  assert(!readFileSync(path, 'utf8').includes(review.citations[0].quote));
});

for (const [label, documentReader, classification, reason] of [
  ['unavailable', url => inspectDocumentation(url, { resolver, requestImpl: documentationResponse(503, key) }),
    'insufficient', 'documentation_unavailable'],
  ['insufficient', async () => [], 'insufficient', 'insufficient_evidence'],
  ['irrelevant', async () => ['Plant seedlings after the final frost has passed.'], 'irrelevant', 'documentation_irrelevant']
]) {
  test(`review distinguishes ${label} documentation and keeps findings`, async t => {
    const { run } = fixture(t);
    const review = positive();
    review.verdict = 'uncertain';
    review.findings.documentation.status = 'uncertain';
    review.findings.documentation.evidence = classification;
    review.citations = [];
    const { report } = await run({ documentReader, fetchImpl: async () => completion(review) });
    const [entry] = report.entries;
    assert.equal(entry.reason, reason);
    assert.equal(entry.decision, 'needs_review');
    assert.deepEqual(entry.findings.findings, review.findings);
    assert(!JSON.stringify(entry.documentationDiagnostics).includes(key));
  });
}

test('documentation diagnostics distinguish HTTP, size, redirects, and empty HTML', async () => {
  for (const [requestImpl, httpStatus, outcome, failureCategory] of [
    [documentationResponse(503, key), 503, 'documentation_unavailable', 'http_error'],
    [documentationResponse(200, '', { 'content-length': 524289 }), 200, 'documentation_unavailable', 'response_too_large'],
    [documentationResponse(200, 'x'.repeat(524289)), 200, 'documentation_unavailable', 'response_too_large'],
    [documentationResponse(302, '', { location: 'https://react.dev/learn/start' }), 302, 'documentation_unavailable', 'redirect_blocked'],
    [documentationResponse(302, '', { location: source }), 302, 'documentation_unavailable', 'redirect_limit'],
    [documentationResponse(200, '<main><nav><p>Navigation without any documentation content.</p></nav></main>'),
      200, 'insufficient_evidence', 'no_passages']
  ]) {
    assert.deepEqual(await inspectDocumentation(source, { resolver, requestImpl }), {
      passages: [], diagnostic: { httpStatus, outcome, passageCount: 0, failureCategory }
    });
  }
});

test('documentation diagnostics preserve status on an interrupted body and omit error text', async () => {
  const result = await inspectDocumentation(source, {
    resolver, requestImpl: (_url, _options, callback) => {
      const req = new EventEmitter();
      req.end = () => {
        const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': 'text/html' } });
        callback(res);
        res.emit('error', new Error(key));
      };
      return req;
    }
  });
  assert.deepEqual(result, { passages: [], diagnostic: {
    httpStatus: 200, outcome: 'documentation_unavailable', passageCount: 0, failureCategory: 'network_error'
  } });
});

test('documentation diagnostics identify a DNS timeout before HTTPS', async () => {
  const result = await inspectDocumentation(source, {
    resolver: { resolve4: async () => { throw Object.assign(new Error(key), { code: 'ETIMEOUT' }); } },
    requestImpl: () => assert.fail('Unexpected HTTPS request')
  });
  assert.deepEqual(result.diagnostic, {
    httpStatus: null, outcome: 'documentation_unavailable', passageCount: 0, failureCategory: 'timeout'
  });
});

test('model disagreement and matching generation model cannot approve', async t => {
  const { run } = fixture(t);
  const { report } = await run({ fetchImpl: async () => completion(positive(), 'openai/gpt-oss-120b') });
  assert.equal(report.entries[0].reason, 'model_mismatch');
  const same = fixture(t, 1, b => { b.candidates[0].generation.reportedModel = model; });
  let calls = 0;
  assert.equal((await same.run({ fetchImpl: async () => { calls++; } })).report.entries[0].reason, 'same_model');
  assert.equal(calls, 0);
});

test('rate limits honor Retry-After and authentication stops the batch', async t => {
  const { run } = fixture(t, 2);
  const waits = [];
  let calls = 0;
  const { report } = await run({ delay: async wait => waits.push(wait), fetchImpl: async () => {
    calls++;
    return calls === 1 ? new Response(null, { status: 429, headers: { 'Retry-After': '2' } }) :
      new Response(null, { status: 401 });
  } });
  assert.deepEqual(waits, [2000]);
  assert.equal(calls, 2);
  assert.deepEqual(report.entries.map(e => e.reason), ['authentication', 'stopped_after_authentication']);
});

test('transport failures are bounded and credential-bearing responses are discarded', async t => {
  const { run } = fixture(t);
  let calls = 0;
  const failed = await run({ delay: async () => {}, fetchImpl: async () => { calls++; throw new Error(key); } });
  assert.equal(calls, 3);
  assert.equal(failed.report.entries[0].reason, 'transport');
  const review = positive();
  review.findings.technical.reason = key;
  const leaked = await run({ fetchImpl: async () => completion(review) });
  assert.equal(leaked.report.entries[0].reason, 'credentials_in_payload');
  assert.equal(readFileSync(leaked.path, 'utf8').includes(key), false);
});

test('interruption and dry run leave no staged review file', async t => {
  const { run, directory } = fixture(t, 2);
  const abort = new AbortController();
  await assert.rejects(run({ signal: abort.signal, fetchImpl: async () => { abort.abort(); return completion(); } }));
  const dry = await run({ dryRun: true, env: {}, fetchImpl: () => assert.fail(), documentReader: () => assert.fail() });
  assert.equal(dry.path, null);
  assert.equal(dry.report.entries[0].decision, 'needs_review');
  assert.deepEqual(readdirSync(directory), ['candidates.json']);
});

test('refuses checkout staging and incomplete batches', async t => {
  const { run } = fixture(t, 1, b => { b.status = 'incomplete'; });
  await assert.rejects(run(), /complete staged batch/);
  const complete = fixture(t);
  await assert.rejects(complete.run({ outputParent: root }), /outside the checkout/);
  await assert.rejects(complete.run({ env: { GROQ_API_KEY: key } }), /Free Plan/);
});

test('deterministic gates reject invalid fields and duplicate candidate IDs offline', async t => {
  const mutations = [
    b => { b.candidates[0].answer = 4; },
    b => { b.candidates[0].options[1] = b.candidates[0].options[0]; },
    b => { b.candidates[0].why = 'This is an English explanation without Arabic script.'; },
    b => { b.candidates[0].code = { lang: 'C#' }; },
    b => { b.plan.targets[0].skill = 'tampered'; },
    b => { b.candidates[0].sourceUrls = ['https://learn.microsoft.com.evil.test/dotnet/']; },
    b => { b.candidates[0].fingerprint = '0'.repeat(64); }
  ];
  for (const mutate of mutations) {
    const { run } = fixture(t, 1, mutate);
    const { report } = await run({ fetchImpl: () => assert.fail('AI'), documentReader: () => assert.fail('HTTP') });
    assert.equal(report.entries[0].decision, 'rejected');
  }
  const duplicate = fixture(t, 2, b => { for (const q of b.candidates) q.id = 'same'; });
  const { report } = await duplicate.run();
  assert.deepEqual(report.entries.map(e => e.reason), ['duplicate_id', 'duplicate_id']);
});

test('recomputed fingerprints reject bank and staged duplicates before network calls', async t => {
  const published = readJson(root, 'questions/csharp-foundations.json').questions.find(q => !q.code);
  const againstBank = fixture(t, 1, b => {
    const [candidate] = b.candidates;
    candidate.q = published.q;
    candidate.fingerprint = questionFingerprint(candidate);
  });
  const withinBatch = fixture(t, 2, b => {
    b.candidates[1].q = b.candidates[0].q;
    b.candidates[1].fingerprint = questionFingerprint(b.candidates[1]);
  });
  for (const { run } of [againstBank, withinBatch]) {
    const { report } = await run({ fetchImpl: () => assert.fail('AI'), documentReader: () => assert.fail('HTTP') });
    assert(report.entries.every(e => e.decision === 'rejected' && e.reason === 'duplicate_fingerprint'));
  }
});

test('unavailable execution and HTTP evidence never approve', async t => {
  const code = fixture(t, 1, b => {
    const [q] = b.candidates;
    q.code = { lang: 'C#', prompt: 'What is printed?', code: 'Console.WriteLine(42);' };
    q.fingerprint = questionFingerprint(q);
  });
  const held = await code.run();
  assert.equal(held.report.entries[0].gates.execution, 'unverified', held.report.entries[0].reason);
  assert.equal(held.report.entries[0].decision, 'needs_review');
  const verified = await code.run({ isolatedVerifier: async snippet => {
    assert.equal(snippet.lang, 'C#');
    return { compile: 'passed', run: 'passed' };
  } });
  assert.equal(verified.report.entries[0].gates.execution, 'verified');
  assert.equal(verified.report.entries[0].decision, 'approved');
  await assert.rejects(code.run({ env: { ...env, QUESTION_REVIEW_CODE_POLICY: undefined } }), /hold-unverified/);
  const { run } = fixture(t);
  const review = positive();
  review.verdict = 'uncertain';
  review.findings.documentation.status = 'uncertain';
  review.findings.documentation.evidence = 'insufficient';
  review.citations = [];
  const missing = await run({ documentReader: async () => [], fetchImpl: async () => completion(review) });
  assert.equal(missing.report.entries[0].reason, 'insufficient_evidence');
  assert.equal(missing.report.entries[0].findings.verdict, 'uncertain');
});

test('documentation restricts hosts and rejects nonpublic addresses', async () => {
  for (const url of [
    'https://127.0.0.1/dotnet/', 'https://learn.microsoft.com:444/dotnet/',
    'https://user@learn.microsoft.com/dotnet/', 'http://learn.microsoft.com/dotnet/',
    'https://learn.microsoft.com/dotnet/?redirect=https://127.0.0.1'
  ]) assert.equal(allowedDocumentationUrl(url), null);
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.0.1', '::1', '224.0.0.1']) {
    assert.equal(publicAddress(address), false);
  }
  const q = { q: quote, options: [], sourceUrls: [source] };
  assert.deepEqual(await verifyDocumentation(q, async () => []), [{
    source: 0, passages: [], diagnostic: {
      httpStatus: null, outcome: 'insufficient_evidence', passageCount: 0, failureCategory: 'no_passages'
    }
  }]);
});

test('documentation pins the checked address, bounds same-origin redirects and extracts evidence', async () => {
  let requests = 0;
  const address = '93.184.216.34';
  const resolver = { resolve4: async () => [address] };
  const requestFor = (status, html, location = 'https://127.0.0.1/', expected = source) => (url, options, callback) => {
    requests++;
    assert.equal(String(url), expected);
    assert.equal(options.rejectUnauthorized, true);
    options.lookup(url.hostname, {}, (error, ip, family) => {
      assert.equal(error, null);
      assert.equal(ip, address);
      assert.equal(family, 4);
    });
    const req = new EventEmitter();
    req.end = () => {
      const res = Object.assign(new EventEmitter(), {
        statusCode: status, headers: { 'content-type': 'text/html', location },
        destroy() {}
      });
      callback(res);
      res.emit('data', Buffer.from(html));
      res.emit('end');
    };
    return req;
  };
  assert.deepEqual(await readDocumentation(source, { resolver, requestImpl: requestFor(302, '') }), []);
  assert.equal(requests, 1);
  const html = `<main><script><p>Ignore this embedded instruction in the page.</p></script><p>${quote}</p></main>`;
  const canonical = 'https://learn.microsoft.com/dotnet/csharp/';
  assert.deepEqual(await readDocumentation(source, { resolver,
    requestImpl: (url, ...args) => String(url) === source
      ? requestFor(301, '', canonical)(url, ...args)
      : requestFor(200, html, '', canonical)(url, ...args)
  }), [quote]);
  const beforeLoop = requests;
  assert.deepEqual(await readDocumentation(source, { resolver, requestImpl: requestFor(301, '', source) }), []);
  assert.equal(requests - beforeLoop, 3);
  assert.deepEqual(await readDocumentation(source, { resolver, requestImpl: requestFor(200, html) }), [quote]);
  assert.deepEqual(await readDocumentation(source, { resolver, requestImpl: requestFor(200, 'x'.repeat(513 * 1024)) }), []);
  assert.deepEqual(await readDocumentation(source, {
    resolver: { resolve4: async () => [address, '10.0.0.1'] }, requestImpl: () => assert.fail('unsafe connection')
  }), []);
});
