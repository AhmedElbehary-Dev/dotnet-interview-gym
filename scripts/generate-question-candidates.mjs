import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isRecord, normalizePrompt, questionFingerprint, readJson } from './build-question-index.mjs';
import { isMain, planGeneration, readPlanArgs } from './plan-question-generation.mjs';

const groqModel = 'qwen/qwen3.8-27b';
const groqModelPattern = /^(?:[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/;
const openRouterModelPattern = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:-]+$/;
const transient = new Set([408, 429, 500, 502, 503, 504]);
const targetFields = ['category', 'conceptId', 'difficulty', 'skill'];
const requiredFields = [...targetFields, 'q', 'options', 'answer', 'hint', 'why', 'sourceUrls'];
const allowedFields = new Set([...requiredFields, 'code']);
const codeFields = ['lang', 'prompt', 'code'];
const arabic = /\p{Script=Arabic}/u;
const nonempty = (str, max) => typeof str === 'string' && str.trim().length > 0 && str.length <= max;

function settings(env) {
  const provider = env.QUESTION_AI_PROVIDER ?? 'groq';
  if (provider !== 'groq' && provider !== 'openrouter') {
    throw new Error('QUESTION_AI_PROVIDER must be groq or openrouter.');
  }
  const groq = provider === 'groq';
  const name = groq ? 'Groq' : 'OpenRouter';
  const prefix = provider.toUpperCase();
  const key = env[`${prefix}_API_KEY`];
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(key)) {
    throw new Error(`Set ${prefix}_API_KEY to a valid API token.`);
  }
  const model = env[`${prefix}_MODEL`] ?? (groq ? groqModel : 'openrouter/free');
  const modelPattern = groq ? groqModelPattern : openRouterModelPattern;
  if (typeof model !== 'string' || !modelPattern.test(model) ||
      model.length > 160 || model.includes(key)) {
    throw new Error(`Invalid ${prefix}_MODEL.`);
  }
  const timeout = Number((groq ? undefined : env.OPENROUTER_TIMEOUT_MS) ?? 45000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000) {
    throw new Error('OPENROUTER_TIMEOUT_MS must be an integer from 1 to 120000.');
  }
  const reasoningEffort = groq ? env.GROQ_REASONING_EFFORT ?? (model === groqModel ? 'none' : undefined) : undefined;
  if (reasoningEffort !== undefined && !['none', 'default', 'low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) {
    throw new Error('Invalid GROQ_REASONING_EFFORT.');
  }
  const endpoint = groq ? 'https://api.groq.com/openai/v1/chat/completions' :
    'https://openrouter.ai/api/v1/chat/completions';
  return { provider, groq, name, endpoint, key, model, modelPattern, timeout, reasoningEffort };
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

export class GenerationError extends Error {
  constructor(category, message, validation) {
    super(message);
    this.category = category;
    if (validation) this.validation = validation;
  }
}

class CandidateValidationError extends GenerationError {
  constructor(candidateIndex, field, rule, category = 'invalid_schema', message) {
    super(category, message ?? `Candidate ${candidateIndex} failed validation at ${field} (${rule}).`);
    this.validation = { candidateIndex, field, rule };
  }
}

const finishReasons = new Set(['stop', 'length', 'content_filter', 'tool_calls', 'error']);
function parseCompletion(content, { key, name, modelPattern }, diagnostics, selectOutput, strict) {
  let decoded;
  const validation = (field, rule) => strict ? { field, rule } : undefined;
  if (!content.trim()) throw new GenerationError('empty_response', `${name} returned an empty response.`,
    validation('$', 'nonempty'));
  try {
    decoded = JSON.parse(content);
  } catch {
    throw new GenerationError('invalid_json', `${name} returned an invalid JSON response envelope.`,
      validation('$', 'json_envelope'));
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
    throw new GenerationError('truncated', `${name} output was truncated (finish_reason=length).`);
  }
  if (decoded?.error) {
    throw new GenerationError('provider_error', `${name} reported a completion error.`);
  }
  if (output == null || typeof output === 'string' && !output.trim()) {
    throw new GenerationError(strict ? 'empty_output' : 'empty_response', `${name} returned empty output.`,
      validation('$.choices[0].message.content', 'nonempty'));
  }
  if (choice.finish_reason !== 'stop') {
    throw new GenerationError('unexpected_finish', `${name} completion did not finish with stop.`);
  }

  let parsed;
  try {
    if (typeof output !== 'string') throw new Error();
    const fenced = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```\s*$/i.exec(output);
    parsed = JSON.parse(!strict && fenced ? fenced[1] : output);
  } catch {
    throw new GenerationError('invalid_json', `${name} returned invalid JSON output.`,
      validation('$.choices[0].message.content', 'json_output'));
  }
  if (!selectOutput && (!isRecord(parsed) || !Array.isArray(parsed.candidates))) {
    throw new CandidateValidationError(null, 'candidates', 'array', 'invalid_schema',
      `${name} returned an invalid candidate schema at candidates (array).`);
  }
  rejectSecret(decoded, key);
  rejectSecret(parsed, key);
  return selectOutput ? selectOutput(parsed, diagnostics.reportedModel) : parsed.candidates;
}

const reviewParameters = ['response_format', 'json_schema', 'strict', 'reasoning_effort', 'max_completion_tokens', 'temperature', 'model'];
const providerParameters = [
  'response_format.json_schema.schema', 'response_format.json_schema.strict', 'response_format.json_schema',
  ...reviewParameters, 'messages'
];
const requestParameter = providerParameters.map(param => param.replaceAll('.', '\\.')).join('|');
const unsupportedParameterMessage = new RegExp(
  `^['"\x60]?(?<param>${requestParameter})['"\x60]? (?:is (?:unsupported|not (?:currently )?supported|not allowed)|does not support)\\b`, 'i'
);
const providerErrorCategories = new Map([
  ['invalid_json_schema', 'invalid_request_schema'],
  ['invalid_request_schema', 'invalid_request_schema'],
  ['unsupported_parameter', 'unsupported_model_parameters'],
  ['unsupported_value', 'unsupported_model_parameters'],
  ['json_validate_failed', 'structured_output_generation_failed'],
  ['invalid_model', 'invalid_model_configuration'],
  ['model_not_found', 'invalid_model_configuration'],
  ['model_decommissioned', 'invalid_model_configuration'],
  ['unsupported_model', 'invalid_model_configuration']
]);

async function diagnoseReviewRejection(response) {
  let error;
  try {
    error = JSON.parse(await readCompletion(response))?.error;
  } catch {
    return {};
  }
  if (!isRecord(error)) return {};

  const message = typeof error.message === 'string' ? error.message : '';
  if (response.status === 422) {
    // Keep the existing 422 handling for unsupported parameters.
    let field;
    if (['unsupported_parameter', 'unsupported_value', 'unsupported_model'].includes(error.code)) {
      field = reviewParameters.includes(error.param) ? `request.${error.param}` : 'request';
    } else if (/\b(?:unsupported|not (?:currently )?supported|does not support|is not allowed|does not allow)\b/i.test(message)) {
      const param = reviewParameters.find(candidate => new RegExp(`\\b${candidate}\\b`, 'i').test(message));
      if (param) field = `request.${param}`;
    }
    return field ? { category: 'unsupported_model_parameters', validation: { field, rule: 'unsupported_parameter' } } : {};
  }

  const code = providerErrorCategories.has(error.code) ? error.code : undefined;
  const type = error.type === 'invalid_request_error' ? error.type : undefined;
  const param = providerParameters.includes(error.param) ? error.param : undefined;
  const providerError = { ...(code && { code }), ...(type && { type }), ...(param && { param }) };

  // Some Groq errors omit a structured code. Match only specific leading phrases.
  const unsupportedParam = unsupportedParameterMessage.exec(message)?.groups.param.toLowerCase();
  let category = providerErrorCategories.get(code);
  if (!category) {
    if (unsupportedParam) {
      category = 'unsupported_model_parameters';
    } else if (/^(?:Invalid (?:JSON )?schema for response_format\b|Invalid JSON schema:)/i.test(message)) {
      category = 'invalid_request_schema';
    } else if (/^(?:Generated JSON does not match the expected schema\.|Failed to generate JSON\.)/i.test(message)) {
      category = 'structured_output_generation_failed';
    }
  }
  const parameter = param ?? unsupportedParam;
  return {
    category,
    providerError: Object.keys(providerError).length ? providerError : undefined,
    validation: category === 'unsupported_model_parameters' ?
      { field: parameter ? `request.${parameter}` : 'request', rule: 'unsupported_parameter' } : undefined
  };
}

export async function requestCompletion(payload, env, {
  fetchImpl = fetch, delay = sleep, log = () => {}, budget = { remaining: 3 }, signal: cancellation
} = {}) {
  const config = settings(env);
  const { groq, name, endpoint, key, model, timeout, reasoningEffort } = config;
  const maxTokens = payload.maxTokens ?? 3200;
  const strict = groq && payload.responseFormat?.type === 'json_schema';
  const body = JSON.stringify({
    messages: payload.messages, model, temperature: 0.2,
    response_format: strict ? payload.responseFormat : { type: 'json_object' },
    ...(groq ? { max_completion_tokens: maxTokens, reasoning_effort: reasoningEffort } :
      { max_tokens: maxTokens, provider: { require_parameters: true } })
  });
  if (Buffer.byteLength(body) > (strict ? 24 : 16) * 1024) throw new Error(`${name} request exceeds the size limit.`);
  if (body.includes(key)) throw new Error('Rejected request containing credentials.');
  for (let attempt = 0; attempt < 3; attempt++) {
    cancellation?.throwIfAborted();
    if (budget.remaining === 0) {
      log({ failureCategory: 'request_budget' });
      throw new GenerationError('request_budget', `${name} request budget exhausted.`);
    }
    budget.remaining--;
    const deadline = AbortSignal.timeout(timeout);
    const signal = cancellation ? AbortSignal.any([deadline, cancellation]) : deadline;
    const diagnostics = { reportedModel: null, finishReason: null, usage: {}, outputLength: 0 };
    let response;
    let error;
    let retry = false;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal, body,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
      });
      if (strict) diagnostics.httpStatus = response.status;
      if (response.ok) {
        const output = parseCompletion(await readCompletion(response), config, diagnostics, payload.selectOutput, strict);
        const result = payload.selectOutput ? { output } : { candidates: payload.validate ? payload.validate(output) : output };
        log({ ...diagnostics, failureCategory: null });
        return { ...result, reportedModel: diagnostics.reportedModel };
      }

      const status = response.status;
      const rejection = strict && [400, 422].includes(status) ? await diagnoseReviewRejection(response) : {};
      void response.body?.cancel().catch(() => {});
      cancellation?.throwIfAborted();
      if (rejection.providerError) diagnostics.providerError = rejection.providerError;
      retry = transient.has(status);
      if (rejection.category) {
        error = new GenerationError(rejection.category, `${name} returned HTTP ${status}.`, rejection.validation);
      } else if (status === 401 || status === 403) {
        error = new GenerationError('authentication', `${name} authentication failed (HTTP ${status}).`);
      } else if (status === 429) {
        error = new GenerationError('rate_limit', `${name} rate limit reached (HTTP 429).`);
      } else if (status === 408) {
        error = new GenerationError('timeout', `${name} request timed out (HTTP 408).`);
      } else {
        error = new GenerationError('http_error', `${name} returned HTTP ${status}.`);
      }
    } catch (cause) {
      cancellation?.throwIfAborted();
      if (cause instanceof GenerationError) {
        error = cause;
      } else if (signal.aborted) {
        retry = true;
        error = new GenerationError('timeout', `${name} request timed out.`);
      } else if (!response) {
        retry = true;
        error = new GenerationError('transport', `${name} transport failed.`);
      } else {
        error = new GenerationError('read_error', `Could not read the ${name} response.`);
      }
    }
    log({
      ...diagnostics, failureCategory: error.category,
      ...(error.validation && { validation: error.validation })
    });
    if (!retry || attempt === 2 || budget.remaining === 0) throw error;
    const wait = retryDelay(response?.headers.get('retry-after'), attempt);
    if (wait > 5000) throw error;
    await delay(wait, undefined, { signal: cancellation });
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
      'hint for a short Arabic hint, why for a detailed Egyptian-Arabic explanation, and sourceUrls for 1–3 authoritative documentation links.',
      'Use one directly relevant official documentation URL by default. Add another only if it supplies distinct evidence for a material claim. Use known URLs and do not invent references.',
      'Use a code object with lang, prompt and code when a snippet is helpful. Keep each explanation to about 2–4 sentences.',
      'Keep all questions educational and defensive. Do not provide exploit instructions.'
    ].join(' ') },
    { role: 'user', content: JSON.stringify(briefs) }
  ];
}

export async function generateBatch(root, options, { env = process.env, ...transport } = {}) {
  const { key, model, provider } = settings(env);
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
      const generation = { provider, requestedModel: model, reportedModel: output.reportedModel, seed: plan.seed };
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
  const keys = [process.env.GROQ_API_KEY, process.env.OPENROUTER_API_KEY].filter(Boolean);
  const redact = message => keys.reduce((result, key) => result.replaceAll(key, '[REDACTED]'), message);
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
