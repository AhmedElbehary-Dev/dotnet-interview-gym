import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateBatch, requestCompletion, validateCandidates } from './generate-question-candidates.mjs';
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

test('uses a single bounded request and stages a complete batch outside the checkout', async t => {
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
    assert(payload.max_tokens <= 8000);
    assert(request.body.length < 10000);
    assert(!request.body.includes(apiKey));
    return completion(raw);
  } });
  t.after(() => rmSync(dirname(path), { recursive: true }));
  assert.equal(calls, 1);
  assert.equal(dirname(dirname(path)), dirname(root));
  assert.deepEqual(bankFiles.map(file => readFileSync(file)), before);
  const batch = JSON.parse(readFileSync(path, 'utf8'));
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
  assert.throws(() => validate([{ ...candidates[0], q: candidates[1].q }, ...candidates.slice(1)]), /duplicate/i);
  fingerprints.add(questionFingerprint(candidates[0]));
  assert.throws(() => validate(candidates), /duplicate/i);
});

test('missing and invalid credentials fail before any request', async () => {
  for (const env of [{}, { OPENROUTER_API_KEY: 'bad\r\nsecret' }]) {
    await assert.rejects(generateBatch(root, batchOptions, { env, fetchImpl: () => assert.fail('unexpected fetch') }),
      /OPENROUTER_API_KEY/);
  }
});

test('handles provider errors and retries transient responses within budget', async () => {
  for (const [statuses, expectedAttempts, error] of [
    [[401], 1, /401/], [[402], 1, /402/], [[429, 502, 429], 3, /429/], [[400], 1, /400/]
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
  }), /Expected 10 candidates/);
  await assert.rejects(generateBatch(root, batchOptions, {
    env: config, fetchImpl: async () => new Response(null, { status: 429, headers: { 'Retry-After': '60' } }),
    delay: () => assert.fail('retry wait exceeds budget')
  }), /429/);
  assert.deepEqual(staging(), directories);
  assert.deepEqual(bankFiles.map(file => readFileSync(file)), before);
});
