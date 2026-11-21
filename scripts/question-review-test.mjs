import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { questionFingerprint, readJson } from './build-question-index.mjs';
import { planGeneration } from './plan-question-generation.mjs';
import { reviewBatch, reviewDimensions } from './review-question-candidates.mjs';
import { allowedDocumentationUrl, publicAddress, readDocumentation, verifyDocumentation } from './review-documentation.mjs';

const root = process.cwd();
const model = 'openai/gpt-oss-20b';
const key = 'gsk_mock_key_never_write_this';
const source = 'https://learn.microsoft.com/dotnet/csharp/language-reference/operators/type-testing-and-cast';
const quote = 'The is operator checks if the runtime type of an expression result is compatible with a given type.';
const env = { GROQ_API_KEY: key, GROQ_REVIEW_FREE_PLAN: '1', QUESTION_REVIEW_CODE_POLICY: 'hold-unverified' };
const fullPlan = planGeneration(root, { date: '2026-11-21', seed: 'review' });
const positive = () => ({
  verdict: 'approve', actualAnswer: 0,
  findings: Object.fromEntries(reviewDimensions.map(name => [name, { status: 'pass', reason: 'The evidence supports this finding.' }])),
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
    assert.equal(Object.hasOwn(JSON.parse(payload.messages[1].content).question, 'answer'), false);
    return completion();
  } });
  assert(path.startsWith(directory));
  assert.deepEqual(JSON.parse(readFileSync(path)), report);
  const [entry] = report.entries;
  assert.equal(entry.decision, 'approved');
  assert.deepEqual(entry.candidate, batch.candidates[0]);
  assert.equal(entry.reviewModel, model);
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
  review.citations = [];
  const missing = await run({ documentReader: async () => [], fetchImpl: async () => completion(review) });
  assert.equal(missing.report.entries[0].reason, 'documentation_unverified');
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
  assert.deepEqual(await verifyDocumentation(q, async () => []), [{ source: 0, passages: [] }]);
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
