import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateBatch, readGenerationArgs, requestCompletion, validateCandidates } from './generate-question-candidates.mjs';
import { test } from 'node:test';
import { buildQuestionIndex, questionFingerprint, readJson } from './build-question-index.mjs';
import { analyzeCoverage } from './analyze-coverage.mjs';
import { planGeneration } from './plan-question-generation.mjs';

const root = process.cwd();

test('coverage distinguishes exclusions and counts curated concepts', () => {
  const report = analyzeCoverage(buildQuestionIndex(), readJson(root, 'scripts/coverage-targets.json'));
  assert(report.excluded.some(g => g.category === 'أساسيات C#' && g.label === 'متقدم'));
  assert(!report.gaps.some(g => g.category === 'أساسيات C#' && g.label === 'متقدم'));
  assert(report.conceptCoverage.some(c => c.observed > 0));
  assert(report.conceptCoverage.some(c => c.status === 'gap'));
  assert(report.conceptCoverage.some(c => c.status === 'unknown'));
});

test('fingerprints preserve case and whitespace inside snippets', () => {
  const q = { q: 'What is printed?', code: { lang: 'C#', code: 'Console.Write("A  B");\n' } };
  assert.equal(questionFingerprint(q), questionFingerprint({ ...q, q: ' WHAT IS PRINTED? ', code: { ...q.code, code: q.code.code.replace('\n', '\r\n') } }));
  for (const snippet of ['Console.Write("A B");\n', 'Console.Write("a  B");\n']) {
    assert.notEqual(questionFingerprint(q), questionFingerprint({ ...q, code: { ...q.code, code: snippet } }));
  }
});

test('offline plan is deterministic and spans concepts, categories, skills and difficulties', () => {
  const options = { date: '2026-11-21', seed: 'review' };
  const plan = planGeneration(root, options);
  assert.deepEqual(plan, planGeneration(root, options));
  assert.equal(plan.targets.length, 10);
  for (const [field, count] of [['conceptId', 10], ['category', 7], ['skill', 3], ['difficulty', 3]]) {
    assert(new Set(plan.targets.map(t => t[field])).size >= count, field);
  }
  assert.throws(() => planGeneration(root, { ...options, date: '2026-02-30' }), /date/i);
});

function mockCandidates(plan) {
  return plan.targets.map((target, i) => ({
    ...target,
    q: `Which statement applies to practice case ${i + 1}?`,
    options: ['First option', 'Second option', 'Third option', 'Fourth option'],
    answer: i % 4,
    hint: 'راجع المثال',
    why: 'بص على المثال وشوف إزاي الاختيار ده بيشرح السلوك المطلوب خطوة بخطوة.',
    sourceUrls: ['https://learn.microsoft.com/dotnet/']
  }));
}

const apiKey = 'sk-or-v1-mock-secret';
const batchOptions = { date: '2026-11-21', seed: 'review' };
const config = { OPENROUTER_API_KEY: apiKey };
const completion = candidates => Response.json({
  model: 'example/free:free',
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ candidates }) } }]
});

test('uses five bounded two-candidate requests and stages a complete batch outside the checkout', async t => {
  const bankFiles = ['questions/manifest.json', 'questions/index.json',
    ...readJson(root, 'questions/manifest.json').files.map(f => f.path)];
  const before = bankFiles.map(file => readFileSync(file));
  const plan = planGeneration(root, batchOptions);
  const raw = mockCandidates(plan);
  raw[0].code = { lang: 'C#', prompt: 'Which branch runs?', code: 'Console.WriteLine("Hello");' };
  let calls = 0;
  const path = await generateBatch(root, batchOptions, { env: config, fetchImpl: async (url, request) => {
    calls++;
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(request.headers.Authorization, `Bearer ${apiKey}`);
    const payload = JSON.parse(request.body);
    assert.equal(payload.model, 'openrouter/free');
    assert(!Object.hasOwn(payload, 'models'));
    assert(!Object.hasOwn(payload, 'response_format'));
    assert(payload.max_tokens <= 3200);
    assert(request.body.length < 10000);
    assert(!request.body.includes(apiKey));
    const expected = plan.targets.slice((calls - 1) * 2, calls * 2);
    const briefs = JSON.parse(payload.messages[1].content);
    assert.deepEqual(briefs.map(({ category, conceptId, difficulty, skill }) => ({ category, conceptId, difficulty, skill })), expected);
    return completion(raw.slice((calls - 1) * 2, calls * 2));
  } });
  t.after(() => rmSync(dirname(path), { recursive: true }));
  assert.equal(calls, 5);
  assert.equal(dirname(dirname(path)), dirname(root));
  assert.deepEqual(bankFiles.map(file => readFileSync(file)), before);
  const batch = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(batch.status, 'complete');
  assert.equal(batch.candidates.length, 10);
  assert.deepEqual(batch.candidates[0].code, raw[0].code);
  assert.equal(batch.candidates[0].batchDate, batchOptions.date);
  assert.equal(batch.candidates[0].sourceVerification, 'unverified');
  assert.equal(batch.candidates[0].generation.requestedModel, 'openrouter/free');
  assert(batch.candidates.every(c => !Object.hasOwn(c, 'id')));
});

test('rejects invalid shape, mismatched targets and within-batch and bank duplicates', () => {
  const plan = planGeneration(root, batchOptions);
  const candidates = mockCandidates(plan);
  const fingerprints = new Set();
  const validate = list => validateCandidates(list, plan, fingerprints);
  assert.equal(validate(candidates).length, 10);
  for (const patch of [
    { id: 123 }, { answer: 4 }, { options: ['Same', ' same ', 'C', 'D'] },
    { hint: 'English only' }, { sourceUrls: ['file:///private'] }, { conceptId: 'wrong.concept' },
    { code: { lang: 'C#', prompt: 'Missing snippet' } }
  ]) {
    assert.throws(() => validate([{ ...candidates[0], ...patch }, ...candidates.slice(1)]), /candidate/i);
  }
  assert.throws(() => validate([{ ...candidates[0], q: candidates[1].q }, ...candidates.slice(1)]), { category: 'duplicate_fingerprint' });
  fingerprints.add(questionFingerprint(candidates[0]));
  assert.throws(() => validate(candidates), { category: 'duplicate_fingerprint' });
});

test('missing and invalid credentials fail before any request', async () => {
  for (const env of [{}, { OPENROUTER_API_KEY: 'bad\r\nsecret' }]) {
    await assert.rejects(generateBatch(root, batchOptions, { env, fetchImpl: () => assert.fail('unexpected fetch') }),
      /OPENROUTER_API_KEY/);
  }
});

test('handles provider errors and retries transient responses within budget', async () => {
  for (const [statuses, expectedAttempts, error] of [
    [[401], 1, /authentication.*401/], [[403], 1, /authentication.*403/], [[402], 1, /402/], [[429, 502, 429], 3, /429/], [[400], 1, /400/]
  ]) {
    let attempts = 0;
    await assert.rejects(requestCompletion({}, config, {
      fetchImpl: async () => new Response(apiKey, { status: statuses[attempts++] }),
      delay: async () => {}
    }), error);
    assert.equal(attempts, expectedAttempts);
  }
  let attempts = 0;
  const result = await requestCompletion({}, config, {
    fetchImpl: async () => ++attempts === 1 ? new Response(null, { status: 429 }) :
      completion(mockCandidates(planGeneration(root, batchOptions))),
    delay: async () => {}
  });
  assert.equal(attempts, 2);
  assert.equal(result.candidates.length, 10);
});

test('sanitizes malformed payloads, reflected credentials and transport exceptions', async () => {
  for (const fetchImpl of [
    async () => new Response(apiKey),
    async () => completion([{ q: apiKey }]),
    async () => { throw new Error(apiKey); },
    async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] })
  ]) {
    await assert.rejects(requestCompletion({}, config, { fetchImpl, delay: async () => {} }), error => {
      assert(!String(error).includes(apiKey));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('aborts each timed-out request within the bounded retry count', async () => {
  let attempts = 0;
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(requestCompletion({}, { ...config, OPENROUTER_TIMEOUT_MS: '10' }, {
      fetchImpl: async (_url, { signal }) => {
        attempts++;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
      delay: async () => {}
    }), /timed out/);
    assert.equal(attempts, 3);
  } finally {
    clearInterval(keepAlive);
  }
});

test('does not stage rejected batches or change the bank', async () => {
  const bankFiles = ['questions/manifest.json', 'questions/index.json',
    ...readJson(root, 'questions/manifest.json').files.map(f => f.path)];
  const before = bankFiles.map(file => readFileSync(file));
  const staging = () => readdirSync(dirname(root)).filter(name => name.startsWith('interview-gym-candidate-staging-')).sort();
  const directories = staging();
  await assert.rejects(generateBatch(root, batchOptions, {
    env: config, fetchImpl: async () => completion([])
  }), /Expected 2 candidates/);
  await assert.rejects(generateBatch(root, batchOptions, {
    env: config, fetchImpl: async () => new Response(null, { status: 429, headers: { 'Retry-After': '60' } }),
    delay: () => assert.fail('retry wait exceeds budget')
  }), /429/);
  assert.deepEqual(staging(), directories);
  assert.deepEqual(bankFiles.map(file => readFileSync(file)), before);
});

test('limit 2 selects the deterministic prefix and stages it in one request', async t => {
  const args = [batchOptions.date, batchOptions.seed];
  for (const extra of [['--limit'], ['--limit', '0'], ['--limit', '11'], ['--limit', '2.5'], ['--other', '2']]) {
    assert.throws(() => readGenerationArgs([...args, ...extra]), /Usage/);
  }
  const targets = planGeneration(root, batchOptions).targets.slice(0, 2);
  let calls = 0;
  const path = await generateBatch(root, readGenerationArgs([...args, '--limit', '2']), {
    env: config, fetchImpl: async () => {
      calls++;
      return completion(mockCandidates({ targets }));
    }
  });
  t.after(() => rmSync(dirname(path), { recursive: true }));
  const batch = JSON.parse(readFileSync(path));
  assert.equal(calls, 1);
  assert.equal(batch.status, 'complete');
  assert.deepEqual(batch.plan.targets, targets);
  assert.equal(batch.candidates.length, 2);
});

const providerResponse = (content, finishReason = 'stop', model = 'example/free:free') => Response.json({
  model,
  usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32, extra: 'ignored metadata' },
  choices: [{ finish_reason: finishReason, message: { content } }]
});

test('accepts complete fenced JSON and logs only whitelisted metadata', async () => {
  const log = [];
  const content = '```json\r\n{"candidates":[]}\r\n```';
  const result = await requestCompletion({}, config, {
    fetchImpl: async () => providerResponse(content), log: metadata => log.push(metadata)
  });
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(log, [{
    reportedModel: 'example/free:free', finishReason: 'stop',
    usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 },
    outputLength: content.length, failureCategory: null
  }]);
});

test('classifies truncated, empty, malformed and invalid-schema output without retrying', async () => {
  for (const [respond, category] of [
    [() => providerResponse('{"candidates":[]}', 'length'), 'truncated'],
    [() => new Response(''), 'empty_response'],
    [() => providerResponse('  '), 'empty_response'],
    [() => new Response('garbage'), 'invalid_json'],
    [() => providerResponse('{"candidates":['), 'invalid_json'],
    [() => providerResponse('```json\n{"candidates":[\n```'), 'invalid_json'],
    [() => providerResponse('prefix\n```json\n{"candidates":[]}\n```'), 'invalid_json'],
    [() => providerResponse('{"candidates":{}}'), 'invalid_schema'],
    [() => providerResponse(JSON.stringify({ candidates: [apiKey] }), 'stop', 'example/' + apiKey), 'credentials_in_payload']
  ]) {
    let calls = 0;
    const log = [];
    await assert.rejects(requestCompletion({}, config, {
      fetchImpl: async () => { calls++; return respond(); },
      log: metadata => log.push(metadata)
    }), { category });
    assert.equal(calls, 1);
    assert.equal(log[0].failureCategory, category);
    assert(!JSON.stringify(log).includes(apiKey));
  }
});

test('truncated pairs are split into ordered singles with a smaller token cap', async t => {
  const requests = [];
  const raw = mockCandidates(planGeneration(root, batchOptions));
  const path = await generateBatch(root, { ...batchOptions, limit: 2 }, {
    env: config, fetchImpl: async (_url, { body }) => {
      const payload = JSON.parse(body);
      requests.push(payload);
      return requests.length === 1 ? providerResponse('{"candidates":[', 'length') :
        completion([raw[requests.length - 2]]);
    }
  });
  t.after(() => rmSync(dirname(path), { recursive: true }));
  const batch = JSON.parse(readFileSync(path));
  assert.equal(batch.status, 'complete');
  assert.deepEqual(batch.candidates.map(q => q.q), raw.slice(0, 2).map(q => q.q));
  assert.deepEqual(requests.map(p => JSON.parse(p.messages[1].content).map(q => q.conceptId)),
    [[raw[0].conceptId, raw[1].conceptId], [raw[0].conceptId], [raw[1].conceptId]]);
  assert.deepEqual(requests.map(p => p.max_tokens), [3200, 1600, 1600]);
});

test('shared request budget preserves validated candidates when a later retry is blocked', async t => {
  const raw = mockCandidates(planGeneration(root, batchOptions));
  const responses = [
    () => new Response(null, { status: 429, headers: { 'Retry-After': '1' } }),
    () => providerResponse('{', 'length'),
    () => completion([raw[0]]),
    () => new Response(null, { status: 429 })
  ];
  const waits = [];
  let calls = 0;
  const path = await generateBatch(root, { ...batchOptions, limit: 2 }, {
    env: config, fetchImpl: async () => responses[calls++](),
    delay: async ms => waits.push(ms)
  });
  t.after(() => rmSync(dirname(path), { recursive: true }));
  const batch = JSON.parse(readFileSync(path));
  assert.equal(calls, 4);
  assert.deepEqual(waits, [1000]);
  assert.equal(batch.status, 'incomplete');
  assert.equal(batch.failure.category, 'rate_limit');
  assert.equal(batch.plan.targets.length, 2);
  assert.deepEqual(batch.candidates.map(q => q.q), [raw[0].q]);
});

test('a duplicate from an earlier accepted pair rejects the entire later pair', async t => {
  const raw = mockCandidates(planGeneration(root, batchOptions));
  raw[3].q = raw[0].q;
  const log = [];
  let calls = 0;
  const path = await generateBatch(root, { ...batchOptions, limit: 4 }, {
    env: config, fetchImpl: async () => {
      const start = calls++ * 2;
      return completion(raw.slice(start, start + 2));
    },
    log: metadata => log.push(metadata)
  });
  t.after(() => rmSync(dirname(path), { recursive: true }));
  const batch = JSON.parse(readFileSync(path));
  assert.equal(calls, 2);
  assert.equal(batch.status, 'incomplete');
  assert.deepEqual(batch.candidates.map(q => q.q), raw.slice(0, 2).map(q => q.q));
  assert.equal(batch.failure.category, 'duplicate_fingerprint');
  assert.equal(log[1].failureCategory, 'duplicate_fingerprint');
  const validation = { candidateIndex: 4, field: 'fingerprint', rule: 'unique_fingerprint' };
  assert.deepEqual(log[1].validation, validation);
  assert.deepEqual(batch.failure.validation, validation);
});

test('identifies candidate collection shape and the first missing or extra candidate', () => {
  const plan = { targets: planGeneration(root, batchOptions).targets.slice(0, 1) };
  const [valid] = mockCandidates(plan);
  for (const [input, candidateIndex, rule] of [
    [{}, null, 'array'], [[], 3, 'count'], [[valid, valid], 4, 'count']
  ]) {
    assert.throws(() => validateCandidates(input, plan, new Set(), 2), {
      category: 'invalid_schema', validation: { candidateIndex, field: 'candidates', rule }
    });
  }
});

test('identifies every missing required candidate field and target mismatch', () => {
  const plan = { targets: planGeneration(root, batchOptions).targets.slice(0, 1) };
  const [valid] = mockCandidates(plan);
  for (const field of Object.keys(valid)) {
    const candidate = { ...valid };
    delete candidate[field];
    assert.throws(() => validateCandidates([candidate], plan, new Set()), {
      category: 'invalid_schema', validation: { candidateIndex: 1, field, rule: 'required' }
    });
  }
  for (const field of ['category', 'conceptId', 'difficulty', 'skill']) {
    assert.throws(() => validateCandidates([{ ...valid, [field]: 'wrong target' }], plan, new Set()), {
      category: 'invalid_schema', validation: { candidateIndex: 1, field, rule: 'target_match' }
    });
  }
});

test('identifies invalid candidate, option, answer, URL and code rules by safe path', () => {
  const plan = { targets: planGeneration(root, batchOptions).targets.slice(0, 1) };
  const [valid] = mockCandidates(plan);
  const code = { lang: 'C#', prompt: 'What happens?', code: 'Console.WriteLine(1);' };
  const cases = [
    [null, '$candidate', 'object'],
    [{ ...valid, [apiKey]: 'private value' }, '$candidate', 'unexpected_field'],
    [{ ...valid, q: 3 }, 'q', 'string'],
    [{ ...valid, q: 'Short?' }, 'q', 'length'],
    [{ ...valid, q: '123456789' }, 'q', 'latin_letter'],
    [{ ...valid, q: 'English question سؤال' }, 'q', 'no_arabic_script'],
    [{ ...valid, options: 'wrong' }, 'options', 'array'],
    [{ ...valid, options: valid.options.slice(1) }, 'options', 'length'],
    [{ ...valid, options: ['', ...valid.options.slice(1)] }, 'options[0]', 'length'],
    [{ ...valid, options: ['خيار', ...valid.options.slice(1)] }, 'options[0]', 'no_arabic_script'],
    [{ ...valid, options: ['Same', ' same ', 'C', 'D'] }, 'options[1]', 'unique_normalized'],
    ...[-1, 4, 1.5, '1'].map(answer => [{ ...valid, answer }, 'answer', 'integer_0_to_3']),
    [{ ...valid, hint: 'English only' }, 'hint', 'arabic_script'],
    [{ ...valid, why: 'قصير' }, 'why', 'length'],
    [{ ...valid, why: 'An explanation without any Arabic script whatsoever.' }, 'why', 'arabic_script'],
    [{ ...valid, sourceUrls: 'https://example.com' }, 'sourceUrls', 'array'],
    [{ ...valid, sourceUrls: [] }, 'sourceUrls', 'length'],
    [{ ...valid, sourceUrls: Array(4).fill('https://example.com') }, 'sourceUrls', 'length'],
    [{ ...valid, sourceUrls: [false] }, 'sourceUrls[0]', 'string'],
    [{ ...valid, sourceUrls: ['file:///private'] }, 'sourceUrls[0]', 'http_scheme'],
    [{ ...valid, sourceUrls: ['https://'] }, 'sourceUrls[0]', 'valid_url'],
    [{ ...valid, sourceUrls: ['https://user:secret@example.com'] }, 'sourceUrls[0]', 'no_url_credentials'],
    [{ ...valid, code: null }, 'code', 'object'],
    [{ ...valid, code: { ...code, [apiKey]: true } }, 'code', 'unexpected_field'],
    ...Object.keys(code).map(key => {
      const incomplete = { ...code };
      delete incomplete[key];
      return [{ ...valid, code: incomplete }, 'code.' + key, 'required'];
    }),
    [{ ...valid, code: { ...code, lang: '' } }, 'code.lang', 'length'],
    [{ ...valid, code: { ...code, prompt: 'سؤال' } }, 'code.prompt', 'latin_letter'],
    [{ ...valid, code: { ...code, code: 'x'.repeat(1601) } }, 'code.code', 'length']
  ];
  for (const [candidate, field, rule] of cases) {
    assert.throws(() => validateCandidates([candidate], plan, new Set()), {
      category: 'invalid_schema', validation: { candidateIndex: 1, field, rule }
    }, field + ' ' + rule);
  }
});

test('CLI reports structured validation without echoing model values or credentials', () => {
  const [candidate] = mockCandidates({ targets: planGeneration(root, batchOptions).targets.slice(0, 1) });
  const marker = 'Private generated prose';
  const unexpectedField = 'private-field-value';
  const payload = { candidates: [{ ...candidate, q: marker, [unexpectedField]: 'private' }] };
  const preload = 'globalThis.fetch = async () => Response.json(' + JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }]
  }) + ')';
  const result = spawnSync(process.execPath, [
    '--import', 'data:text/javascript,' + encodeURIComponent(preload),
    'scripts/generate-question-candidates.mjs', batchOptions.date, batchOptions.seed, '--limit', '1'
  ], { cwd: root, env: { ...process.env, ...config, OPENROUTER_MODEL: 'openrouter/free' }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const [metadata, message] = result.stderr.trim().split(/\r?\n/);
  assert.equal(JSON.parse(metadata).failureCategory, 'invalid_schema');
  assert.deepEqual(JSON.parse(metadata).validation, {
    candidateIndex: 1, field: '$candidate', rule: 'unexpected_field'
  });
  assert.match(message, /Candidate 1.*\$candidate.*unexpected_field/);
  for (const sensitive of [marker, unexpectedField, apiKey, 'Authorization']) {
    assert(!result.stderr.includes(sensitive));
  }
});
