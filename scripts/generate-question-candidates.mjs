import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isRecord, normalizePrompt, questionFingerprint, readJson } from './build-question-index.mjs';
import { isMain, planGeneration, readPlanArgs } from './plan-question-generation.mjs';

const endpoint = 'https://openrouter.ai/api/v1/chat/completions';
const transient = new Set([408, 429, 500, 502, 503, 504]);
const targetFields = ['category', 'conceptId', 'difficulty', 'skill'];
const requiredFields = [...targetFields, 'q', 'options', 'answer', 'hint', 'why', 'sourceUrls'];
const allowedFields = new Set([...requiredFields, 'code']);
const codeFields = ['lang', 'prompt', 'code'];
const arabic = /\p{Script=Arabic}/u;
const nonempty = (str, max) => typeof str === 'string' && str.trim().length > 0 && str.length <= max;

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
  if (JSON.stringify(value).includes(key)) throw new GenerationError('credentials_in_payload', 'Rejected payload containing credentials.');
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

class GenerationError extends Error {
  constructor(category, message) {
    super(message);
    this.category = category;
  }
}

class CandidateValidationError extends GenerationError {
  constructor(candidateIndex, field, rule, category = 'invalid_schema', message) {
    super(category, message ?? `Candidate ${candidateIndex} failed validation at ${field} (${rule}).`);
    this.validation = { candidateIndex, field, rule };
  }
}

const finishReasons = new Set(['stop', 'length', 'content_filter', 'tool_calls', 'error']);
const modelPattern = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:-]+$/;

function parseCompletion(content, key, diagnostics) {
  let decoded;
  if (!content.trim()) throw new GenerationError('empty_response', 'OpenRouter returned an empty response.');
  try {
    decoded = JSON.parse(content);
  } catch {
    throw new GenerationError('invalid_json', 'OpenRouter returned an invalid JSON response envelope.');
  }
  const choice = decoded?.choices?.[0];
  const output = choice?.message?.content;
  const reportedModel = decoded?.model;
  diagnostics.reportedModel = nonempty(reportedModel, 160) && modelPattern.test(reportedModel) &&
    !reportedModel.includes(key) ? reportedModel : null;
  diagnostics.finishReason = finishReasons.has(choice?.finish_reason) && !choice.finish_reason.includes(key)
    ? choice.finish_reason : null;
  diagnostics.outputLength = typeof output === 'string' ? output.length : 0;
  for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    const count = decoded?.usage?.[field];
    if (Number.isSafeInteger(count) && count >= 0 && !String(count).includes(key)) diagnostics.usage[field] = count;
  }

  if (choice?.finish_reason === 'length') {
    throw new GenerationError('truncated', 'OpenRouter output was truncated (finish_reason=length).');
  }
  if (decoded?.error) {
    throw new GenerationError('provider_error', 'OpenRouter reported a completion error.');
  }
  if (output == null || typeof output === 'string' && !output.trim()) {
    throw new GenerationError('empty_response', 'OpenRouter returned empty output.');
  }
  if (choice.finish_reason !== 'stop') {
    throw new GenerationError('unexpected_finish', 'OpenRouter completion did not finish with stop.');
  }

  let parsed;
  try {
    if (typeof output !== 'string') throw new Error();
    const fenced = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```\s*$/i.exec(output);
    parsed = JSON.parse(fenced ? fenced[1] : output);
  } catch {
    throw new GenerationError('invalid_json', 'OpenRouter returned invalid JSON output.');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.candidates)) {
    throw new CandidateValidationError(null, 'candidates', 'array', 'invalid_schema',
      'OpenRouter returned an invalid candidate schema at candidates (array).');
  }
  rejectSecret(decoded, key);
  rejectSecret(parsed, key);
  return parsed.candidates;
}

export async function requestCompletion(payload, env, {
  fetchImpl = fetch, delay = sleep, log = () => {}, budget = { remaining: 3 }
} = {}) {
  const { key, model, timeout } = settings(env);
  const body = JSON.stringify({ messages: payload.messages, model, max_tokens: payload.maxTokens ?? 3200, temperature: 0.2 });
  if (Buffer.byteLength(body) > 16 * 1024) throw new Error('OpenRouter request exceeds the size limit.');
  if (body.includes(key)) throw new Error('Rejected request containing credentials.');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (budget.remaining === 0) {
      log({ failureCategory: 'request_budget' });
      throw new GenerationError('request_budget', 'OpenRouter request budget exhausted.');
    }
    budget.remaining--;
    const signal = AbortSignal.timeout(timeout);
    const diagnostics = { reportedModel: null, finishReason: null, usage: {}, outputLength: 0 };
    let response;
    let error;
    let retry = false;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal, body,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
      });
      if (response.ok) {
        const candidates = parseCompletion(await readCompletion(response), key, diagnostics);
        const validated = payload.validate ? payload.validate(candidates) : candidates;
        log({ ...diagnostics, failureCategory: null });
        return { candidates: validated, reportedModel: diagnostics.reportedModel };
      }

      void response.body?.cancel().catch(() => {});
      const status = response.status;
      retry = transient.has(status);
      if (status === 401 || status === 403) {
        error = new GenerationError('authentication', `OpenRouter authentication failed (HTTP ${status}).`);
      } else if (status === 429) {
        error = new GenerationError('rate_limit', 'OpenRouter rate limit reached (HTTP 429).');
      } else if (status === 408) {
        error = new GenerationError('timeout', 'OpenRouter request timed out (HTTP 408).');
      } else {
        error = new GenerationError('http_error', `OpenRouter returned HTTP ${status}.`);
      }
    } catch (cause) {
      if (cause instanceof GenerationError) {
        error = cause;
      } else if (signal.aborted) {
        retry = true;
        error = new GenerationError('timeout', 'OpenRouter request timed out.');
      } else if (!response) {
        retry = true;
        error = new GenerationError('transport', 'OpenRouter transport failed.');
      } else {
        error = new GenerationError('read_error', 'Could not read the OpenRouter response.');
      }
    }
    log({
      ...diagnostics, failureCategory: error.category,
      ...(error instanceof CandidateValidationError && { validation: error.validation })
    });
    if (!retry || attempt === 2 || budget.remaining === 0) throw error;
    const wait = retryDelay(response?.headers.get('retry-after'), attempt);
    if (wait > 5000) throw error;
    await delay(wait);
  }
}

export function validateCandidates(candidates, plan, bankFingerprints, offset = 0) {
  if (!Array.isArray(candidates)) {
    throw new CandidateValidationError(null, 'candidates', 'array', 'invalid_schema', 'Expected a candidates array.');
  }
  if (candidates.length !== plan.targets.length) {
    const firstMismatch = offset + Math.min(candidates.length, plan.targets.length) + 1;
    throw new CandidateValidationError(firstMismatch, 'candidates', 'count', 'invalid_schema',
      `Expected ${plan.targets.length} candidates. First count mismatch at candidate ${firstMismatch}.`);
  }

  const seen = new Set();
  return candidates.map((q, i) => {
    const candidateIndex = offset + i + 1;
    const fail = (field, rule) => { throw new CandidateValidationError(candidateIndex, field, rule); };
    const checkText = (value, field, max, min = 1) => {
      if (typeof value !== 'string') fail(field, 'string');
      if (value.trim().length < min || value.length > max) fail(field, 'length');
    };
    const checkEnglish = (value, field, max, min) => {
      checkText(value, field, max, min);
      if (!/[a-z]/i.test(value)) fail(field, 'latin_letter');
      if (arabic.test(value)) fail(field, 'no_arabic_script');
    };

    if (!isRecord(q)) fail('$candidate', 'object');
    // Unknown keys can contain generated text, so report the enclosing object.
    if (Object.keys(q).some(field => !allowedFields.has(field))) fail('$candidate', 'unexpected_field');
    for (const field of requiredFields) {
      if (!Object.hasOwn(q, field)) fail(field, 'required');
    }
    for (const field of targetFields) {
      if (q[field] !== plan.targets[i][field]) fail(field, 'target_match');
    }

    checkEnglish(q.q, 'q', 600, 9);
    if (!Array.isArray(q.options)) fail('options', 'array');
    if (q.options.length !== 4) fail('options', 'length');
    const options = new Set();
    for (const [index, option] of q.options.entries()) {
      const field = `options[${index}]`;
      checkText(option, field, 300);
      if (arabic.test(option)) fail(field, 'no_arabic_script');
      const normalized = normalizePrompt(option);
      if (options.has(normalized)) fail(field, 'unique_normalized');
      options.add(normalized);
    }
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) fail('answer', 'integer_0_to_3');
    checkText(q.hint, 'hint', 220);
    if (!arabic.test(q.hint)) fail('hint', 'arabic_script');
    checkText(q.why, 'why', 1500, 40);
    if (!arabic.test(q.why)) fail('why', 'arabic_script');

    if (!Array.isArray(q.sourceUrls)) fail('sourceUrls', 'array');
    if (q.sourceUrls.length < 1 || q.sourceUrls.length > 3) fail('sourceUrls', 'length');
    q.sourceUrls.forEach((value, index) => {
      const field = `sourceUrls[${index}]`;
      checkText(value, field, 500);
      if (!/^https?:\/\//i.test(value)) fail(field, 'http_scheme');
      const url = URL.parse(value);
      if (!url?.hostname) fail(field, 'valid_url');
      if (url.username || url.password) fail(field, 'no_url_credentials');
    });

    const code = q.code;
    if (code !== undefined) {
      if (!isRecord(code)) fail('code', 'object');
      if (Object.keys(code).some(field => !codeFields.includes(field))) fail('code', 'unexpected_field');
      for (const field of codeFields) {
        if (!Object.hasOwn(code, field)) fail(`code.${field}`, 'required');
      }
      checkText(code.lang, 'code.lang', 30);
      checkEnglish(code.prompt, 'code.prompt', 300);
      checkText(code.code, 'code.code', 1600);
    }

    const fingerprint = questionFingerprint(q);
    if (seen.has(fingerprint) || bankFingerprints.has(fingerprint)) {
      throw new CandidateValidationError(candidateIndex, 'fingerprint', 'unique_fingerprint', 'duplicate_fingerprint');
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
  const fullPlan = planGeneration(root, options);
  const limit = options.limit ?? fullPlan.targets.length;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > fullPlan.targets.length) {
    throw new Error('--limit must be an integer from 1 to 10.');
  }
  const plan = { ...fullPlan, targets: fullPlan.targets.slice(0, limit) };
  const index = readJson(root, 'questions/index.json');
  const fingerprints = new Set(index.questions.map(q => q.fingerprint));
  const candidates = [];
  // Allow at most one request per target plus two extra requests across the run.
  const budget = { remaining: limit + 2 };
  let failure = null;
  let singlesRemaining = 0;
  while (candidates.length < limit) {
    const targets = plan.targets.slice(candidates.length, candidates.length + (singlesRemaining ? 1 : 2));
    try {
      const output = await requestCompletion({
        messages: buildMessages(root, index, { targets }),
        maxTokens: 1600 * targets.length,
        validate: raw => validateCandidates(raw, { targets }, fingerprints, candidates.length)
      }, env, { ...transport, budget });
      const generation = { provider: 'openrouter', requestedModel: model, reportedModel: output.reportedModel, seed: plan.seed };
      for (const q of output.candidates) {
        fingerprints.add(q.fingerprint);
        candidates.push({ ...q, batchDate: plan.date, generation, sourceVerification: 'unverified' });
      }
      if (singlesRemaining) singlesRemaining--;
    } catch (error) {
      if (error.category === 'truncated' && targets.length === 2 && budget.remaining > 0) {
        singlesRemaining = 2;
        continue;
      }
      if (!(error instanceof GenerationError) || candidates.length === 0) throw error;
      failure = {
        category: error.category, message: error.message,
        ...(error instanceof CandidateValidationError && { validation: error.validation })
      };
      break;
    }
  }
  const batch = { schemaVersion: 1, status: failure ? 'incomplete' : 'complete', plan, candidates };
  if (failure) batch.failure = failure;
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

export function readGenerationArgs([date, seed, ...extra]) {
  const options = readPlanArgs([date, seed]);
  if (!extra.length) return options;
  if (extra.length !== 2 || extra[0] !== '--limit' || !/^(?:[1-9]|10)$/.test(extra[1])) {
    throw new Error('Usage: node generate-question-candidates.mjs YYYY-MM-DD SEED [--limit 1-10]');
  }
  return { ...options, limit: Number(extra[1]) };
}

if (isMain(import.meta.url)) {
  const key = process.env.OPENROUTER_API_KEY;
  const redact = message => key ? message.replaceAll(key, '[REDACTED]') : message;
  try {
    const path = await generateBatch(resolve('.'), readGenerationArgs(process.argv.slice(2)), {
      log: metadata => console.error(redact(JSON.stringify(metadata)))
    });
    const { status, candidates, plan, failure } = JSON.parse(readFileSync(path, 'utf8'));
    console.log(redact(`Staged ${candidates.length}/${plan.targets.length} candidates (${status}) in ${path}`));
    if (failure) {
      console.error(redact(failure.message));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(redact(error.message));
    process.exitCode = 1;
  }
}
