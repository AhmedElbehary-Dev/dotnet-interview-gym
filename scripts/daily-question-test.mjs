import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cairoDate, runDailyQuestions } from './daily-question-engine.mjs';
import { analyzeCoverage } from './analyze-coverage.mjs';
import { buildQuestionIndex, questionFingerprint, readJson } from './build-question-index.mjs';
import { generateBatch } from './generate-question-candidates.mjs';
import { approvedQuestions, reviewBatch, reviewDimensions } from './review-question-candidates.mjs';

const day = '2099-11-21';
const source = 'https://learn.microsoft.com/dotnet/csharp/language-reference/operators/type-testing-and-cast';
const extra = 'https://learn.microsoft.com/dotnet/csharp/language-reference/operators/patterns';
const quote = 'The is operator checks if the runtime type of an expression result is compatible with a given type.';
const generator = 'qwen/qwen3.8-27b';
const reviewer = 'openai/gpt-oss-20b';
const dailyPrompt = i => `Which type test is most appropriate in the fresh daily case ${i + 1}?`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gym-daily-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['questions', 'reports']) cpSync(dir, join(root, dir), { recursive: true });
  mkdirSync(join(root, 'scripts'));
  cpSync('scripts/coverage-targets.json', join(root, 'scripts/coverage-targets.json'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Daily Engine Test');
  git('config', 'user.email', 'test@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'Baseline');
  return { root, git, base: git('rev-parse', 'HEAD') };
}

function mocks({ repair = false, reject = false, uncertain = false, mixed = false, failReview = false, failGeneration = false, duplicate,
  withCode = false, partial = false, signal, log } = {}) {
  const requests = [];
  const options = {
    date: day, limit: partial ? 3 : repair ? 1 : 2, signal, log,
    env: { GROQ_API_KEY: 'gsk_mock_daily_key', GROQ_REVIEW_FREE_PLAN: '1' },
    documentReader: async () => [quote], delay: async () => {},
    fetchImpl: async (url, { body }) => {
      assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
      const payload = JSON.parse(body);
      const data = JSON.parse(payload.messages[1].content);
      requests.push({ model: payload.model, data });
      let content;
      if (payload.model === generator) {
        if (failGeneration) return new Response('untrusted response body', { status: 400 });
        if (partial && requests.length > 1) return new Response(null, { status: 503 });
        content = { candidates: data.map(({ category, conceptId, difficulty, skill }, i) => ({
          category, conceptId, difficulty, skill,
          q: duplicate ?? dailyPrompt(i),
          options: ['Runtime type compatibility', 'Value equality', 'Object identity', 'Reference count'], answer: 0,
          hint: 'راجع نوع القيمة', why: 'الاختبار بيحدد إذا كان النوع وقت التشغيل متوافق مع النوع المذكور في السؤال.',
          sourceUrls: repair ? [source, extra] : [source],
          ...(withCode && { code: { lang: 'C#', prompt: 'What does this print?', code: 'Console.WriteLine(1);' } })
        })) };
      } else {
        assert.equal(payload.model, reviewer);
        assert.equal(payload.response_format.json_schema.strict, true);
        assert.equal(Object.hasOwn(data.question, 'answer'), false);
        if (failReview && requests.length === 3) return Response.json({ error: {
          code: 'invalid_json_schema', type: 'invalid_request_error', message: 'untrusted response body'
        } }, { status: 400 });
        const rejected = reject || (mixed && requests.length === 3);
        const hold = rejected || uncertain;
        content = { verdict: rejected ? 'reject' : uncertain ? 'uncertain' : 'approve', actualAnswer: hold ? null : 0,
          findings: Object.fromEntries(reviewDimensions.map(name => [name, { status: 'pass',
            reason: 'The evidence supports this finding.' }])), citations: [{ source: 0, quote }] };
        content.findings.documentation.evidence = 'sufficient';
        if (hold) content.findings.answer.status = rejected ? 'fail' : 'uncertain';
      }
      return Response.json({ model: payload.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] });
    }
  };
  return { options, requests };
}

test('Cairo days handle standard time, daylight time and both clock changes', () => {
  for (const [instant, expected] of [
    ['2026-01-01T21:59:59Z', '2026-01-01'], ['2026-01-01T22:00:00Z', '2026-01-02'],
    ['2026-07-01T20:59:59Z', '2026-07-01'], ['2026-07-01T21:00:00Z', '2026-07-02'],
    ['2026-04-23T22:00:00Z', '2026-04-24'], ['2026-10-29T21:59:59Z', '2026-10-29'],
    ['2026-10-29T22:00:00Z', '2026-10-30']
  ]) assert.equal(cairoDate(new Date(instant)), expected, instant);
});

test('stages generation, approval and complete artifacts in one commit, then skips the same date', async t => {
  const { root, git, base } = fixture(t);
  const original = readJson(root, 'questions/manifest.json');
  const { options, requests } = mocks();
  const result = await runDailyQuestions(root, options);
  assert.equal(result.published, 2);
  assert.equal(git('rev-parse', 'HEAD'), base);
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(git('rev-parse', `${result.commit}^`), base);
  git('checkout', '-q', '--detach', result.commit);
  const manifest = readJson(root, 'questions/manifest.json');
  const index = readJson(root, 'questions/index.json');
  assert.equal(manifest.total, original.total + 2);
  assert.equal(readJson(root, 'reports/coverage-report.json').totalQuestions, manifest.total);
  assert.equal(index.questions.filter(q => q.publishedOn === day).length, 2);
  for (const { path } of original.files) {
    const legacy = JSON.parse(git('show', `${base}:${path}`)).questions;
    const questions = readJson(root, path).questions;
    assert.deepEqual(questions.slice(0, legacy.length), legacy);
    for (const q of questions.slice(legacy.length)) assert.match(q.id, /^daily-[a-f0-9]{64}$/);
  }
  const repeat = await runDailyQuestions(root, options);
  assert.equal(repeat.status, 'already_published');
  assert.equal(repeat.commit, null);
  assert.equal(requests.length, 3);
});

test('source-only repair goes through a fresh strict independent review before publication', async t => {
  const { root, git } = fixture(t);
  const { options, requests } = mocks({ repair: true });
  const result = await runDailyQuestions(root, options);
  assert.equal(result.published, 1);
  assert.deepEqual(requests.map(request => request.model), [generator, reviewer, reviewer]);
  const [first, second] = requests.slice(1).map(request => request.data.question);
  assert.deepEqual(second, { ...first, sourceUrls: [source] });
  git('checkout', '-q', '--detach', result.commit);
  const { source: shard, id } = readJson(root, 'questions/index.json').questions.find(q => q.publishedOn === day);
  assert.deepEqual(readJson(root, shard).questions.find(q => q.id === id).sourceUrls, [source]);
});

test('an unlanded retry produces the same tree and excludes rejected candidates', async t => {
  const { root, git, base } = fixture(t);
  const { options } = mocks({ mixed: true });
  const first = await runDailyQuestions(root, options);
  const second = await runDailyQuestions(root, mocks({ mixed: true }).options);
  assert.deepEqual(first.decisions, { approved: 1, rejected: 1, needs_review: 0 });
  assert.equal(second.published, 1);
  assert.equal(git('rev-parse', `${first.commit}^{tree}`), git('rev-parse', `${second.commit}^{tree}`));
  assert.equal(git('rev-parse', 'HEAD'), base);
  git('checkout', '-q', '--detach', second.commit);
  const dayQuestions = readJson(root, 'questions/index.json').questions.filter(q => q.publishedOn === day);
  assert.deepEqual(dayQuestions.map(q => q.fingerprint), [questionFingerprint({ q: dailyPrompt(0) })]);
});

test('a bank duplicate is rejected before review and a different question with the same stable ID is rejected before commit', async t => {
  const { root, git, base } = fixture(t);
  const manifest = readJson(root, 'questions/manifest.json');
  const path = manifest.files[0].path;
  const shard = readJson(root, path);
  const original = shard.questions.find(q => !q.code);
  const duplicate = mocks({ duplicate: original.q });
  assert.equal((await runDailyQuestions(root, duplicate.options)).status, 'generation_failed');
  assert.deepEqual(duplicate.requests.map(request => request.model), [generator]);
  assert.equal(git('rev-parse', 'HEAD'), base);

  const write = (file, value) => writeFileSync(join(root, file), JSON.stringify(value));
  shard.questions.push({ ...original, id: `daily-${questionFingerprint({ q: dailyPrompt(0) })}`,
    q: 'Which original example serves as a deliberately different prompt?' });
  manifest.total++;
  manifest.files[0].count++;
  write(path, shard);
  write('questions/manifest.json', manifest);
  const index = buildQuestionIndex(root);
  write('questions/index.json', index);
  write('reports/coverage-report.json', analyzeCoverage(index, readJson(root, 'scripts/coverage-targets.json'),
    readJson(root, 'questions/topic-taxonomy.json')));
  git('commit', '-qam', 'Reserve a conflicting ID');
  const reserved = git('rev-parse', 'HEAD');
  await assert.rejects(runDailyQuestions(root, mocks().options), /conflicts with a bank ID/);
  assert.equal(git('rev-parse', 'HEAD'), reserved);
  assert.equal(git('status', '--porcelain'), '');
});

test('review receipts reject copied, altered and stale approvals, including modified source repairs', async t => {
  const { root } = fixture(t);
  const { options } = mocks({ repair: true });
  const { env, fetchImpl, documentReader } = options;
  const path = await generateBatch(root, { date: day, seed: 'receipt', limit: 1 }, { env, fetchImpl });
  const outputParent = join(path, '..');
  t.after(() => rmSync(outputParent, { recursive: true, force: true }));
  const settings = { env, fetchImpl, documentReader, outputParent, proseOnly: true };
  const approval = { date: day, generator, reviewer };
  const initial = await reviewBatch(root, path, settings);
  const revisedBytes = readFileSync(initial.revisedPath);
  const revised = JSON.parse(revisedBytes);
  revised.candidates[0].why += ' شرح مختلف.';
  writeFileSync(initial.revisedPath, JSON.stringify(revised));
  await assert.rejects(reviewBatch(root, initial.revisedPath, { ...settings, repairFrom: initial }), /Untrusted source repair/);
  writeFileSync(initial.revisedPath, revisedBytes);
  const repaired = await reviewBatch(root, initial.revisedPath, { ...settings, repairFrom: initial });
  assert.equal(approvedQuestions(root, repaired, approval).length, 1);
  assert.throws(() => approvedQuestions(root, { ...repaired }, approval), /Untrusted or stale/);
  assert.throws(() => approvedQuestions(root, repaired, { ...approval, date: '2099-11-22' }), /Untrusted or stale/);
  const reportBytes = readFileSync(repaired.path);
  repaired.report.entries[0].candidate.why += ' شرح مختلف.';
  assert.throws(() => approvedQuestions(root, repaired, approval), /was altered/);
  repaired.report = JSON.parse(reportBytes);
  writeFileSync(repaired.path, '{}');
  assert.throws(() => approvedQuestions(root, repaired, approval), /was altered/);
  writeFileSync(repaired.path, reportBytes);
  const { path: shardPath } = readJson(root, 'questions/manifest.json').files[0];
  const shard = readJson(root, shardPath);
  shard.questions[0].why += ' شرح مختلف.';
  writeFileSync(join(root, shardPath), JSON.stringify(shard));
  assert.throws(() => approvedQuestions(root, repaired, approval), /Untrusted or stale/);
});

for (const [name, setup, status] of [
  ['rejected', { reject: true }, 'zero_approved'], ['uncertain', { uncertain: true }, 'zero_approved'],
  ['executable', { withCode: true }, 'zero_approved'], ['strict HTTP 400 after an approval', { failReview: true }, 'provider_rejected'],
  ['generation HTTP 400', { failGeneration: true }, 'generation_failed'],
  ['partial generation', { partial: true }, 'generation_incomplete']
]) {
  test(`${name} leaves the current bank and branch untouched`, async t => {
    const { root, git, base } = fixture(t);
    const logs = [];
    const result = await runDailyQuestions(root, mocks({ ...setup, log: event => logs.push(event) }).options);
    assert.equal(result.status, status);
    assert.equal(result.commit, null);
    assert.equal(git('rev-parse', 'HEAD'), base);
    assert.equal(git('status', '--porcelain'), '');
    if (setup.failReview) {
      assert(logs.some(event => event.httpStatus === 400 && event.failureCategory === 'invalid_request_schema'));
      assert(!JSON.stringify(logs).includes('untrusted response body'));
    }
    if (setup.failGeneration) {
      assert(logs.some(event => event.phase === 'generation' && event.httpStatus === 400 && event.failureCategory === 'http_error'));
      assert(!JSON.stringify(logs).includes('untrusted response body'));
    }
  });
}

test('interruption and competing branch updates cannot publish a partial or stale tree', async t => {
  const { root, git, base } = fixture(t);
  const cancellation = new AbortController();
  await assert.rejects(runDailyQuestions(root, mocks({ signal: cancellation.signal,
    log: event => { if (event.phase === 'review') cancellation.abort(); } }).options), { name: 'AbortError' });
  assert.equal(git('rev-parse', 'HEAD'), base);
  assert.equal(git('status', '--porcelain'), '');
  const { commit } = await runDailyQuestions(root, mocks().options);
  writeFileSync(join(root, 'competing.txt'), 'Competing validated update');
  git('add', 'competing.txt');
  git('commit', '-qm', 'Competing change');
  const competing = git('rev-parse', 'HEAD');
  assert.throws(() => git('merge', '--ff-only', commit), /fast-forward/);
  assert.equal(git('rev-parse', 'HEAD'), competing);
  assert.equal(readFileSync(join(root, 'competing.txt'), 'utf8'), 'Competing validated update');
});

test('lease-guarded publication is recoverable and a revert consumes the original publication date', async t => {
  const { root, git, base } = fixture(t);
  const remote = mkdtempSync(join(tmpdir(), 'gym-daily-remote-'));
  t.after(() => rmSync(remote, { recursive: true, force: true }));
  git('init', '--bare', '-q', remote);
  git('push', remote, `${base}:refs/heads/main`);
  const { options } = mocks();
  const { commit } = await runDailyQuestions(root, options);
  git('push', `--force-with-lease=refs/heads/main:${base}`, remote, `${commit}:refs/heads/main`);
  assert.equal(git('ls-remote', remote, 'refs/heads/main'), `${commit}\trefs/heads/main`);
  git('checkout', '-q', '--detach', commit);
  assert.equal((await runDailyQuestions(root, options)).status, 'already_published');
  git('revert', '--no-edit', commit);
  const rollback = git('rev-parse', 'HEAD');
  git('push', remote, `${rollback}:refs/heads/main`);
  assert.equal(git('diff', '--name-only', base, rollback), '');
  assert.equal((await runDailyQuestions(root, options)).status, 'already_published');
  assert.throws(() => git('push', `--force-with-lease=refs/heads/main:${base}`, remote, `${commit}:refs/heads/main`), /stale info/);
  assert.equal(git('ls-remote', remote, 'refs/heads/main'), `${rollback}\trefs/heads/main`);
});
