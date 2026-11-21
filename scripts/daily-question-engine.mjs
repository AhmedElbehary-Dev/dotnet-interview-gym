import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { analyzeCoverage } from './analyze-coverage.mjs';
import { buildQuestionIndex, compareText, isCalendarDate, readJson } from './build-question-index.mjs';
import { GenerationError, generateBatch } from './generate-question-candidates.mjs';
import { isMain } from './plan-question-generation.mjs';
import { approvedQuestions, reviewBatch, reviewContextFiles } from './review-question-candidates.mjs';
import { validateQuestions } from './validate-questions.mjs';

const generator = 'qwen/qwen3.8-27b';
const reviewer = 'openai/gpt-oss-20b';
const manifestPath = 'questions/manifest.json';
const indexPath = 'questions/index.json';
const coveragePath = 'reports/coverage-report.json';
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const cairoFormat = new Intl.DateTimeFormat('en', { timeZone: 'Africa/Cairo', calendar: 'gregory',
  numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' });

export function cairoDate(instant = new Date()) {
  const { year, month, day } = Object.fromEntries(cairoFormat.formatToParts(instant).map(({ type, value }) => [type, value]));
  return `${year}-${month}-${day}`;
}

function git(root, args, { input, index } = {}) {
  try {
    return execFileSync('git', args, { cwd: root, input,
      env: index ? { ...process.env, GIT_INDEX_FILE: index } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch {
    throw new Error(`Could not prepare publication (${args[0]}).`);
  }
}

function snapshotBank(root, base, stage) {
  const tree = git(root, ['ls-tree', '-rz', base, '--', 'questions', coveragePath, 'scripts/coverage-targets.json'])
    .toString().split('\0');
  const blobs = new Map(tree.flatMap(line => {
    const match = /^100644 blob ([a-f0-9]+)\t(.+)$/.exec(line);
    return match ? [[match[2], match[1]]] : [];
  }));
  const copy = path => {
    if (!blobs.has(path)) throw new Error(`Invalid or missing bank file: ${path}`);
    const target = join(stage, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, git(root, ['cat-file', 'blob', blobs.get(path)]));
  };
  for (const path of reviewContextFiles) {
    if (path !== 'questions/concept-map.json' || blobs.has(path)) copy(path);
  }
  const manifest = readJson(stage, manifestPath);
  for (const { path } of manifest.files) {
    if (!/^questions\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.json$/i.test(path) || reviewContextFiles.includes(path)) {
      throw new Error('Invalid bank shard path.');
    }
    copy(path);
  }
  return manifest;
}

function writePublication(stage, manifest, index, candidates, date) {
  const knownIds = new Set(index.questions.map(q => String(q.id)));
  const fingerprints = new Set(index.questions.map(q => q.fingerprint));
  const shards = new Map();
  for (const { fingerprint, ...candidate } of candidates) {
    const id = `daily-${fingerprint}`;
    if (knownIds.has(id) || fingerprints.has(fingerprint)) throw new Error('Publication conflicts with a bank ID or question.');
    const entry = manifest.files.find(file => file.category === candidate.category);
    if (!entry) throw new Error('No compatible question shard.');
    const shard = shards.get(entry.path) ?? readJson(stage, entry.path);
    shard.questions.push({ id, ...candidate, publishedOn: date });
    shards.set(entry.path, shard);
    entry.count++;
    knownIds.add(id);
    fingerprints.add(fingerprint);
  }
  manifest.total += candidates.length;
  manifest.updated = date;
  const files = new Map([...shards, [manifestPath, manifest]]);
  for (const [path, value] of files) writeFileSync(join(stage, path), json(value));
  const updated = buildQuestionIndex(stage);
  const coverage = analyzeCoverage(updated, readJson(stage, 'scripts/coverage-targets.json'),
    readJson(stage, 'questions/topic-taxonomy.json'));
  for (const [path, value] of [[indexPath, updated], [coveragePath, coverage]]) {
    writeFileSync(join(stage, path), json(value));
    files.set(path, value);
  }
  validateQuestions(stage);
  return files;
}

function publicationCommit(root, base, index, files, date) {
  git(root, ['read-tree', base], { index });
  for (const [path, value] of files) {
    const blob = git(root, ['hash-object', '-w', '--stdin'], { input: json(value) }).toString().trim();
    git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { index });
  }
  const tree = git(root, ['write-tree'], { index }).toString().trim();
  return git(root, ['commit-tree', tree, '-p', base, '-m', `Publish daily questions for ${date}`]).toString().trim();
}

export async function runDailyQuestions(root, {
  date = cairoDate(), limit = 10, env = process.env, log = () => {}, signal, documentReader, ...transport
} = {}) {
  if (!isCalendarDate(date)) throw new Error('Publication date must be a valid Cairo calendar date.');
  signal?.throwIfAborted();
  const base = git(root, ['rev-parse', 'HEAD']).toString().trim();
  const finish = (status, published = 0, commit = null, decisions = {}) => ({ date, status, published, base, commit, decisions });
  const scratch = mkdtempSync(join(tmpdir(), 'gym-daily-'));
  const stage = join(scratch, 'bank');
  try {
    const manifest = snapshotBank(root, base, stage);
    const index = buildQuestionIndex(stage);
    validateQuestions(stage);
    // Keep the date consumed after a publication is reverted to recover the previous site.
    const publication = git(root, ['log', '-1', '--first-parent', '--format=%H',
      `--grep=^Publish daily questions for ${date}$`, base]).toString().trim();
    if (publication || index.questions.some(q => q.publishedOn === date)) return finish('already_published');
    if (index.questions.some(q => q.publishedOn > date)) return finish('stale_date');
    if (env.GROQ_REVIEW_FREE_PLAN !== '1') throw new Error('Set GROQ_REVIEW_FREE_PLAN=1 with a Groq Free Plan account.');
    const groq = { GROQ_API_KEY: env.GROQ_API_KEY, GROQ_REVIEW_FREE_PLAN: '1',
      QUESTION_AI_PROVIDER: 'groq', GROQ_MODEL: generator, GROQ_REASONING_EFFORT: 'none', GROQ_REVIEW_MODEL: reviewer,
      QUESTION_REVIEW_CODE_POLICY: 'hold-unverified' };
    const diagnostic = phase => event => log({ phase, ...event });
    let stagedBatch;
    try {
      stagedBatch = await generateBatch(stage, { date, seed: `daily-${date}`, limit, proseOnly: true }, {
        ...transport, env: groq, signal, log: diagnostic('generation')
      });
    } catch (error) {
      if (!(error instanceof GenerationError)) throw error;
      log({ phase: 'generation', failureCategory: error.category, validation: error.validation });
      return finish('generation_failed');
    }
    const batch = readJson(dirname(stagedBatch), 'candidates.json');
    if (batch.status !== 'complete') return finish('generation_incomplete');

    const reviewOptions = { ...transport, env: groq, signal, documentReader, outputParent: scratch, proseOnly: true,
      budget: { remaining: limit * 2 + 2 }, log: diagnostic('review'), logDocumentation: diagnostic('documentation') };
    const blocked = ({ report }) => report.entries.some(e => e.diagnostics.some(({ httpStatus }) =>
      [400, 401, 403, 422].includes(httpStatus)));
    const initial = await reviewBatch(stage, stagedBatch, reviewOptions);
    if (blocked(initial)) return finish('provider_rejected');
    const reviews = [initial];
    if (initial.revisedPath && !initial.report.entries.some(e => e.reason === 'rate_limit')) {
      const repaired = await reviewBatch(stage, initial.revisedPath, { ...reviewOptions, repairFrom: initial });
      if (blocked(repaired)) return finish('provider_rejected');
      reviews.push(repaired);
    }
    const finalEntries = reviews.at(-1).report.entries.map((entry, i) =>
      entry.reason === 'unchanged_after_source_repair' ? initial.report.entries[i] : entry);
    for (const [i, { decision, reason }] of finalEntries.entries()) {
      log({ phase: 'outcome', candidate: i + 1, decision, reason });
    }
    const decisions = Object.fromEntries(['approved', 'rejected', 'needs_review'].map(decision =>
      [decision, finalEntries.filter(entry => entry.decision === decision).length]));
    const candidates = reviews.flatMap(result => approvedQuestions(stage, result, { date, generator, reviewer }))
      .sort((a, b) => compareText(a.fingerprint, b.fingerprint));
    if (!candidates.length) return finish('zero_approved', 0, null, decisions);
    signal?.throwIfAborted();
    if (candidates.length > limit) throw new Error('Publication exceeds the daily limit.');
    const files = writePublication(stage, manifest, index, candidates, date);
    const commit = publicationCommit(root, base, join(scratch, 'git-index'), files, date);
    return finish('staged', candidates.length, commit, decisions);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  try {
    const [createdAt, ...extra] = process.argv.slice(2);
    const instant = createdAt === undefined ? new Date() : new Date(createdAt);
    if (extra.length || !Number.isFinite(instant.getTime())) throw new Error('Expected a workflow creation timestamp.');
    const date = cairoDate(instant);
    const signal = AbortSignal.timeout(20 * 60_000);
    const lastRequest = new Map();
    // Space calls to each model against the Groq Free Plan token-per-minute limit.
    const beforeRequest = async model => {
      const wait = (lastRequest.get(model) ?? 0) + 30_000 - Date.now();
      if (wait > 0) await sleep(wait, undefined, { signal });
      lastRequest.set(model, Date.now());
    };
    const result = date === cairoDate() ? await runDailyQuestions(process.cwd(), {
      date, signal, beforeRequest, retryWaitMs: 60_000, log: event => console.error(JSON.stringify(event))
    }) : { date, status: 'stale_run', published: 0, commit: null, decisions: {} };
    console.log(JSON.stringify(result));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### Cairo daily questions — ${result.date}\n\nOutcome: ${result.status}\n\nQuestions staged: ${result.published}\n\n` +
      Object.entries(result.decisions).map(([decision, count]) => `- ${decision}: ${count}\n`).join(''));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
      `status=${result.status}\ndate=${result.date}\nbase=${result.base ?? ''}\ncommit=${result.commit ?? ''}\n`);
    if (['provider_rejected', 'generation_failed', 'generation_incomplete'].includes(result.status)) process.exitCode = 1;
  } catch (error) {
    const key = process.env.GROQ_API_KEY;
    console.error(key ? error.message.replaceAll(key, '[REDACTED]') : error.message);
    process.exitCode = 1;
  }
}
