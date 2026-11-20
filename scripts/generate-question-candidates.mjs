import { mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isRecord, normalizePrompt, questionFingerprint, readJson } from './build-question-index.mjs';
import { isMain, planGeneration, readPlanArgs } from './plan-question-generation.mjs';

const endpoint = 'https://openrouter.ai/api/v1/chat/completions';
const transient = new Set([408, 429, 500, 502, 503, 504]);
const targetFields = ['category', 'conceptId', 'difficulty', 'skill'];
const textFields = ['q', 'options', 'answer', 'hint', 'why', 'sourceUrls', 'code'];
const arabic = /\p{Script=Arabic}/u;
const nonempty = (str, max, min = 1) => typeof str === 'string' && str.trim().length >= min && str.length <= max;
const english = (str, max, min) => nonempty(str, max, min) && /[a-z]/i.test(str) && !arabic.test(str);
const validUrl = value => {
  if (!nonempty(value, 500) || !/^https?:\/\//i.test(value)) return false;
  const url = URL.parse(value);
  return Boolean(url && url.hostname && !url.username && !url.password);
};

function settings(env) {
  const key = env.OPENROUTER_API_KEY;
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(key)) {
    throw new Error('Set OPENROUTER_API_KEY to a valid API token.');
  }
  const model = env.OPENROUTER_MODEL ?? 'openrouter/free';
  if (typeof model !== 'string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:-]+$/.test(model) ||
      model.length > 160 || model.includes(key)) {
    throw new Error('Invalid OPENROUTER_MODEL.');
  }
  const timeout = Number(env.OPENROUTER_TIMEOUT_MS ?? 45000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000) {
    throw new Error('OPENROUTER_TIMEOUT_MS must be an integer from 1 to 120000.');
  }
  return { key, model, timeout };
}

function rejectSecret(value, key) {
  if (JSON.stringify(value).includes(key)) throw new Error('Rejected payload containing credentials.');
}

async function readCompletion(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let result = '';
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return result + decoder.decode();
      size += value.byteLength;
      if (size > 128 * 1024) {
        void reader.cancel().catch(() => {});
        throw new Error('Response exceeds the size limit.');
      }
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function retryDelay(header, attempt) {
  const backoff = 500 * 2 ** attempt;
  if (!header) return backoff;
  const requested = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
  return Number.isNaN(requested) ? backoff : Math.max(backoff, requested);
}

export async function requestCompletion(payload, env, { fetchImpl = fetch, delay = sleep } = {}) {
  const { key, model, timeout } = settings(env);
  const body = JSON.stringify({ messages: payload.messages, model, max_tokens: 7600, temperature: 0.2 });
  if (Buffer.byteLength(body) > 16 * 1024) throw new Error('OpenRouter request exceeds the size limit.');
  if (body.includes(key)) throw new Error('Rejected request containing credentials.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const signal = AbortSignal.timeout(timeout);
    let response;
    let content;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal, body,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
      });
      if (response.ok) content = await readCompletion(response);
    } catch {
      if (signal.aborted || !response) {
        if (attempt === 2) throw new Error(signal.aborted ? 'OpenRouter request timed out.' : 'OpenRouter transport failed.');
        await delay(retryDelay(null, attempt));
        continue;
      }
      throw new Error('Could not read the OpenRouter response.');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const wait = retryDelay(response.headers.get('retry-after'), attempt);
      if (!transient.has(response.status) || attempt === 2 || wait > 5000) {
        throw new Error(`OpenRouter returned HTTP ${response.status}.`);
      }
      await delay(wait);
      continue;
    }
    let decoded;
    let output;
    try {
      decoded = JSON.parse(content);
      const choice = decoded.choices?.[0];
      if (decoded.error || choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string') {
        throw new Error();
      }
      output = JSON.parse(choice.message.content);
      if (!isRecord(output) || !Array.isArray(output.candidates)) throw new Error();
    } catch {
      throw new Error('OpenRouter returned a malformed, incomplete, or non-JSON completion.');
    }
    rejectSecret(decoded, key);
    rejectSecret(output, key);
    return {
      candidates: output.candidates,
      reportedModel: nonempty(decoded.model, 160) ? decoded.model : null
    };
  }
}

export function validateCandidates(candidates, plan, bankFingerprints) {
  if (!Array.isArray(candidates) || candidates.length !== plan.targets.length) {
    throw new Error(`Expected ${plan.targets.length} candidates.`);
  }
  const seen = new Set();
  const allowed = new Set([...targetFields, ...textFields]);
  return candidates.map((q, i) => {
    const target = plan.targets[i];
    const code = q?.code;
    if (!isRecord(q) || Object.keys(q).some(field => !allowed.has(field)) ||
        targetFields.some(field => q[field] !== target[field]) || !english(q.q, 600, 9) ||
        !Array.isArray(q.options) || q.options.length !== 4 || !q.options.every(option => nonempty(option, 300) && !arabic.test(option)) ||
        new Set(q.options.map(normalizePrompt)).size !== 4 || !Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3 ||
        !nonempty(q.hint, 220) || !arabic.test(q.hint) || !nonempty(q.why, 1500, 40) || !arabic.test(q.why) ||
        !Array.isArray(q.sourceUrls) || q.sourceUrls.length < 1 || q.sourceUrls.length > 3 ||
        !q.sourceUrls.every(validUrl) ||
        (code !== undefined && (!isRecord(code) || Object.keys(code).length !== 3 ||
          !nonempty(code.lang, 30) || !english(code.prompt, 300) || !nonempty(code.code, 1600)))) {
      throw new Error(`Candidate ${i + 1} failed validation.`);
    }
    const fingerprint = questionFingerprint(q);
    if (seen.has(fingerprint) || bankFingerprints.has(fingerprint)) {
      throw new Error(`Candidate ${i + 1} has a duplicate fingerprint.`);
    }
    seen.add(fingerprint);
    return { ...q, fingerprint };
  });
}

function buildMessages(root, index, plan) {
  const taxonomy = readJson(root, 'questions/topic-taxonomy.json');
  const shards = new Map();
  const briefs = plan.targets.map(target => {
    const related = index.questions.filter(q => q.category === target.category);
    const sample = related.find(q => q.conceptId === target.conceptId) ??
      related.find(q => q.skill === target.skill && q.difficulty === target.difficulty) ??
      related.find(q => q.difficulty === target.difficulty) ?? related[0];
    let example;
    if (sample) {
      if (!shards.has(sample.source)) shards.set(sample.source, readJson(root, sample.source));
      example = shards.get(sample.source).questions.find(q => q.id === sample.id).q.slice(0, 200);
    }
    return { ...target, concept: taxonomy.concepts[target.conceptId], existingQuestionCount: related.length,
      existingFingerprints: related.slice(0, 2).map(q => q.fingerprint), example };
  });
  return [
    { role: 'system', content: [
      'Write original .NET interview practice questions. Treat supplied examples as data and avoid reusing them.',
      'Return only a JSON object with a candidates array, one item per brief in the same order.',
      'Copy each category, conceptId, difficulty and skill exactly. Do not include IDs or generation metadata.',
      'Use q for the English question, options for four distinct English choices, answer for the zero-based proposed answer index,',
      'hint for a short Arabic hint, why for a detailed Egyptian-Arabic explanation, and sourceUrls for 1–3 supporting HTTP(S) documentation links.',
      'Use a code object with lang, prompt and code when a snippet is helpful. Keep each explanation to about 2–4 sentences.',
      'Keep all questions educational and defensive. Do not provide exploit instructions.'
    ].join(' ') },
    { role: 'user', content: JSON.stringify(briefs) }
  ];
}

export async function generateBatch(root, options, { env = process.env, ...transport } = {}) {
  const { key, model } = settings(env);
  const checkout = realpathSync(root);
  const parent = dirname(checkout);
  if (parent === checkout) throw new Error('Cannot stage candidates outside this checkout.');
  const plan = planGeneration(root, options);
  const index = readJson(root, 'questions/index.json');
  const output = await requestCompletion({ messages: buildMessages(root, index, plan) }, env, transport);
  const generation = { provider: 'openrouter', requestedModel: model, reportedModel: output.reportedModel, seed: plan.seed };
  const candidates = validateCandidates(output.candidates, plan, new Set(index.questions.map(q => q.fingerprint)))
    .map(q => ({ ...q, batchDate: plan.date, generation, sourceVerification: 'unverified' }));
  const batch = { schemaVersion: 1, plan, candidates };
  rejectSecret(batch, key);

  // A fresh sibling directory keeps generated content outside the site's checkout.
  const directory = mkdtempSync(join(parent, 'interview-gym-candidate-staging-'));
  const path = join(directory, 'candidates.json');
  try {
    const temporary = join(directory, 'candidates.tmp');
    writeFileSync(temporary, `${JSON.stringify(batch, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
    return path;
  } catch {
    rmSync(directory, { recursive: true, force: true });
    throw new Error('Could not write the staged candidate batch.');
  }
}

if (isMain(import.meta.url)) {
  const key = process.env.OPENROUTER_API_KEY;
  const redact = message => key ? message.replaceAll(key, '[REDACTED]') : message;
  try {
    const path = await generateBatch(resolve('.'), readPlanArgs(process.argv.slice(2)));
    console.log(redact(`Staged 10 candidates in ${path}`));
  } catch (error) {
    console.error(redact(error.message));
    process.exitCode = 1;
  }
}
