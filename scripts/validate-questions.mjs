import { questionFingerprint } from './build-question-index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from './plan-question-generation.mjs';

export function validateQuestions(root = process.cwd()) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'questions/manifest.json'), 'utf8'));
  const ids = new Set();
  const normalizedQuestions = new Set();
  const errors = [];
  let count = 0;
  for (const entry of manifest.files) {
    const filePath = path.join(root, entry.path);
    if (!filePath.startsWith(path.join(root, 'questions') + path.sep)) {
      errors.push(`${entry.path}: invalid path`); continue;
    }
    const file = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(file.questions)) { errors.push(`${entry.path}: expected questions array`); continue; }
    if (file.questions.length !== entry.count) errors.push(`${entry.path}: manifest count mismatch`);
    count += file.questions.length;
    for (const q of file.questions) {
      const where = `${entry.path} #${q.id}`;
      if (!(typeof q.id === 'number' && Number.isSafeInteger(q.id) && q.id > 0) && !(typeof q.id === 'string' && /^[a-z0-9_-]+$/.test(q.id))) errors.push(`${where}: invalid id`);
      if (ids.has(String(q.id))) errors.push(`${where}: duplicate ID`);
      ids.add(String(q.id));
      if (typeof q.q !== 'string' || q.q.trim().length < 9) errors.push(`${where}: missing question text`);
      if (!Array.isArray(q.options) || q.options.length !== 4 || q.options.some(a=>typeof a !== 'string'||!a.trim())) errors.push(`${where}: expected 4 meaningful options`);
      if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) errors.push(`${where}: invalid answer index`);
      for (const field of ['category','difficulty','skill','why','hint']) if (typeof q[field] !== 'string'||!q[field].trim()) errors.push(`${where}: missing ${field}`);
      if (q.code && (typeof q.code.code !== 'string'||typeof q.code.prompt !== 'string'||typeof q.code.lang !== 'string')) errors.push(`${where}: malformed code sample`);
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
