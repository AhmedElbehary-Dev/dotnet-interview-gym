import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { analyzeCoverage } from './analyze-coverage.mjs';
import { buildQuestionIndex, isMain, questionFingerprint, readJson } from './build-question-index.mjs';
import { questionFormatErrors, validateQuestions } from './validate-questions.mjs';

const manifestPath = 'questions/manifest.json';
const taxonomyPath = 'questions/topic-taxonomy.json';
const cairoCalendar = new Intl.DateTimeFormat('en', { timeZone: 'Africa/Cairo', calendar: 'gregory',
  numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' });

export function cairoDate(instant = new Date()) {
  const { year, month, day } = Object.fromEntries(cairoCalendar.formatToParts(instant).map(({ type, value }) => [type, value]));
  return `${year}-${month}-${day}`;
}

function importFormatErrors(question, shard, targets, taxonomy) {
  const errors = questionFormatErrors(question);
  if (errors.length) return errors;
  if (!shard) errors.push(`unsupported category ${JSON.stringify(question.category)} (see ${manifestPath})`);
  for (const field of ['difficulty', 'skill']) {
    if (!Object.hasOwn(targets[field], question[field])) errors.push(`unsupported ${field} ${JSON.stringify(question[field])}`);
  }
  if (question.conceptId !== undefined &&
      (typeof question.conceptId !== 'string' || !Object.hasOwn(taxonomy.concepts, question.conceptId))) {
    errors.push(`unregistered conceptId ${JSON.stringify(question.conceptId)}`);
  }
  return errors;
}

function prepareImport(root, questions, date) {
  const index = buildQuestionIndex(root);
  const manifest = readJson(root, manifestPath);
  const taxonomy = readJson(root, taxonomyPath);
  const targets = readJson(root, 'scripts/coverage-targets.json');
  const shards = new Map();
  for (const entry of manifest.files) if (!shards.has(entry.category)) shards.set(entry.category, entry);
  const ids = new Set(index.questions.map(q => String(q.id)));
  const fingerprints = new Set(index.questions.map(q => q.fingerprint));
  const files = new Map();
  const errors = [];
  let added = 0, duplicate = 0;

  for (const [i, raw] of questions.entries()) {
    const shard = shards.get(raw?.category);
    const problems = importFormatErrors(raw, shard, targets, taxonomy);
    if (problems.length) {
      errors.push(`Question ${i + 1}: ${problems.join(', ')}`);
      continue;
    }
    const fingerprint = questionFingerprint(raw);
    if (fingerprints.has(fingerprint)) { duplicate++; continue; }
    const id = `manual-${fingerprint}`;
    if (ids.has(id)) throw new Error(`Question ${i + 1}: generated ID already exists: ${id}`);
    const { id: ignoredId, fingerprint: ignoredFingerprint, publishedOn: ignoredDate, ...content } = raw;
    const data = files.get(shard.path) ?? readJson(root, shard.path);
    data.questions.push({ id, ...content, publishedOn: date });
    files.set(shard.path, data);
    shard.count++;
    added++;
    ids.add(id);
    fingerprints.add(fingerprint);
  }

  if (errors.length || !added) return { files: new Map(), errors, added: 0, duplicate };
  manifest.total += added;
  manifest.updated = date;
  const read = path => files.get(path) ?? readJson(root, path);
  files.set(manifestPath, manifest);
  const updatedIndex = buildQuestionIndex(root, read);
  validateQuestions(root, read);
  files.set('questions/index.json', updatedIndex);
  files.set('reports/coverage-report.json', analyzeCoverage(updatedIndex, targets, taxonomy));
  return { files, errors, added, duplicate };
}

function applyImport(root, scratch, files) {
  // Stage the replacements and their originals on the same volume before changing the bank.
  const staged = [...files].map(([path, content]) => {
    const target = join(root, path);
    const next = join(scratch, 'next', path);
    const backup = join(scratch, 'backup', path);
    mkdirSync(dirname(next), { recursive: true });
    mkdirSync(dirname(backup), { recursive: true });
    copyFileSync(target, backup);
    writeFileSync(next, `${JSON.stringify(content, null, 2)}\n`);
    return { target, next, backup };
  });

  const applied = [];
  try {
    for (const file of staged) {
      renameSync(file.next, file.target);
      applied.push(file);
    }
  } catch (error) {
    const failures = [];
    for (const { backup, target } of applied.reverse()) {
      try { renameSync(backup, target); }
      catch { failures.push(`${backup} -> ${target}`); }
    }
    if (failures.length) {
      const failure = new Error(`Import rollback failed. Restore these backups:\n${failures.join('\n')}`, { cause: error });
      failure.code = 'IMPORT_ROLLBACK_FAILED';
      throw failure;
    }
    throw error;
  }
}

function main([input, flag, ...extra]) {
  if (!input || input.startsWith('--') || (flag !== undefined && flag !== '--apply') || extra.length) {
    throw new Error('Usage: node scripts/import-questions.mjs <file.json> [--apply]');
  }
  const apply = flag === '--apply';
  const summary = (received, added, duplicate, invalid) => {
    console.log(`${invalid ? 'Rejected' : apply ? 'Applied' : 'Preview (would add)'}: ` +
      `received ${received}, added ${added}, duplicate ${duplicate}, invalid-format ${invalid}`);
  };
  let questions;
  try {
    const data = JSON.parse(readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
    questions = Array.isArray(data) ? data : data?.questions;
    if (!Array.isArray(questions)) throw new Error('expected a questions array or an object containing a questions array');
  } catch (error) {
    summary(0, 0, 0, 1);
    throw new Error(`${input}: ${error.message}`, { cause: error });
  }

  const root = process.cwd();
  const scratch = join(root, '.question-import');
  if (apply) {
    try { mkdirSync(scratch); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error(`Another import is active or left recovery files in ${scratch}.`);
      throw error;
    }
  }
  let preserveBackups = false;
  try {
    const { files, errors, added, duplicate } = prepareImport(root, questions, cairoDate());
    if (apply && files.size) applyImport(root, scratch, files);
    summary(questions.length, added, duplicate, errors.length);
    if (errors.length) {
      for (const error of errors.slice(0, 10)) console.error(error);
      if (errors.length > 10) console.error(`… and ${errors.length - 10} more invalid rows.`);
      process.exitCode = 1;
    }
  } catch (error) {
    preserveBackups = error.code === 'IMPORT_ROLLBACK_FAILED';
    throw error;
  } finally {
    if (apply && !preserveBackups) rmSync(scratch, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
