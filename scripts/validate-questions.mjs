import { isMain, isRecord, questionFingerprint, readJson } from './build-question-index.mjs';
import path from 'node:path';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function questionFormatErrors(q) {
  if (!isRecord(q)) return ['expected a question object'];
  const errors = [];
  for (const field of ['q', 'category', 'difficulty', 'skill', 'why', 'hint']) {
    if (!nonempty(q[field])) errors.push(`missing ${field}`);
  }
  if (!Array.isArray(q.options) || q.options.length !== 4 || !q.options.every(nonempty)) {
    errors.push('expected 4 non-empty options');
  }
  if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) errors.push('invalid answer index');
  if (q.code != null && (!isRecord(q.code) || ['code', 'prompt', 'lang'].some(field => typeof q.code[field] !== 'string'))) {
    errors.push('malformed code sample');
  }
  return errors;
}

export function validateQuestions(root = process.cwd(), read = file => readJson(root, file)) {
  const manifest = read('questions/manifest.json');
  const ids = new Set();
  const normalizedQuestions = new Set();
  const errors = [];
  let count = 0;
  for (const entry of manifest.files) {
    const filePath = path.join(root, entry.path);
    if (!filePath.startsWith(path.join(root, 'questions') + path.sep)) {
      errors.push(`${entry.path}: invalid path`); continue;
    }
    const file = read(entry.path);
    if (!Array.isArray(file.questions)) { errors.push(`${entry.path}: expected questions array`); continue; }
    if (file.questions.length !== entry.count) errors.push(`${entry.path}: manifest count mismatch`);
    count += file.questions.length;
    for (const q of file.questions) {
      if (!isRecord(q)) { errors.push(`${entry.path}: expected a question object`); continue; }
      const where = `${entry.path} #${q.id}`;
      if (!(typeof q.id === 'number' && Number.isSafeInteger(q.id) && q.id > 0) && !(typeof q.id === 'string' && /^[a-z0-9_-]+$/.test(q.id))) errors.push(`${where}: invalid id`);
      if (ids.has(String(q.id))) errors.push(`${where}: duplicate ID`);
      ids.add(String(q.id));
      for (const error of questionFormatErrors(q)) errors.push(`${where}: ${error}`);
      const key = questionFingerprint({ ...q, q: String(q.q) });
      if (normalizedQuestions.has(key)) errors.push(`${where}: duplicated question fingerprint`);
      normalizedQuestions.add(key);
    }
  }
  if (manifest.total !== count) errors.push(`Bank count ${count} != manifest total ${manifest.total}`);
  if (errors.length) throw new Error(errors.join('\n'));
  return { count, shards: manifest.files.length, ids: ids.size };
}

if (isMain(import.meta.url)) {
  try {
    const { count, shards, ids } = validateQuestions();
    console.log(`OK: ${count} questions across ${shards} JSON shards, ${ids} unique IDs`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
