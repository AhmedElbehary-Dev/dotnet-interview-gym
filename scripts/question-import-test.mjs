import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildQuestionIndex, questionFingerprint } from './build-question-index.mjs';
import { analyzeCoverage } from './analyze-coverage.mjs';
import { cairoDate } from './import-questions.mjs';

const cli = resolve('scripts/import-questions.mjs');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gym-import-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['questions', 'reports', 'scripts']) mkdirSync(join(root, dir));
  for (const path of ['questions/topic-taxonomy.json', 'scripts/coverage-targets.json']) cpSync(path, join(root, path));
  const read = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const write = (path, value) => writeFileSync(join(root, path), JSON.stringify(value));
  const bankManifest = JSON.parse(readFileSync('questions/manifest.json', 'utf8'));
  const source = bankManifest.files.slice(0, 3);
  const manifest = { schemaVersion: 1, total: 2, updated: '2026-01-12', files: source.map((entry, i) =>
    ({ path: `questions/shard-${i}.json`, category: entry.category, count: i === 1 ? 0 : 1 })) };
  const paths = [...manifest.files.map(file => file.path), 'questions/manifest.json', 'questions/index.json', 'reports/coverage-report.json'];
  const question = { q: 'When does StringComparer.OrdinalIgnoreCase consider two strings equal?',
    category: manifest.files[0].category, difficulty: 'متوسط', skill: 'مفهوم',
    options: ['When ordinal comparison ignores casing', 'When the culture changes', 'When whitespace is trimmed', 'When lengths match'],
    answer: 0, hint: 'فكّر في نوع المقارنة.', why: 'المقارنة ترتيبية وتتجاهل حالة الأحرف.' };
  const original = { ...question, id: 17, category: manifest.files[2].category,
    q: 'How are strings compared with a case-sensitive ordinal comparer?', publishedOn: manifest.updated };
  const originals = [[{ ...question, id: 1, q: 'What does string equality compare?' }], [], [original]];
  for (const [i, { path, category }] of manifest.files.entries()) {
    write(path, { category, questions: originals[i] });
  }
  write('questions/manifest.json', manifest);
  const index = buildQuestionIndex(root);
  write('questions/index.json', index);
  const targets = read('scripts/coverage-targets.json');
  write('reports/coverage-report.json', analyzeCoverage(index, targets, read('questions/topic-taxonomy.json')));
  return { root, read, manifest, original, question, paths,
    snapshot: () => Object.fromEntries(paths.map(path => [path, readFileSync(join(root, path))])),
    run(input, ...flags) {
      writeFileSync(join(root, 'input.json'), typeof input === 'string' ? input : JSON.stringify(input));
      return spawnSync(process.execPath, [cli, 'input.json', ...flags], { cwd: root, encoding: 'utf8' });
    }
  };
}

function succeeded(result, summary) {
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, summary);
}

test('previews and applies distinct questions while skipping normalized bank and batch duplicates', t => {
  const bank = fixture(t);
  const before = bank.snapshot();
  const { question, manifest, original } = bank;
  const input = { questions: [question, { ...original, q: `  ${original.q.toUpperCase()}  ` },
    { ...question, q: ` \n${question.q.toUpperCase().replaceAll(' ', '  ')} `, answer: 2 },
    { ...question, q: 'How does ordinal case-insensitive string comparison determine equality?', category: manifest.files[1].category }] };
  succeeded(bank.run(input), /Preview.*received 4, added 2, duplicate 2, invalid-format 0/);
  assert.deepEqual(bank.snapshot(), before);
  const startDate = cairoDate();
  succeeded(bank.run(input, '--apply'), /Applied.*received 4, added 2, duplicate 2, invalid-format 0/);
  const updatedManifest = bank.read('questions/manifest.json');
  assert.ok([startDate, cairoDate()].includes(updatedManifest.updated));
  assert.equal(updatedManifest.total, manifest.total + 2);
  for (const [i, { path, count }] of manifest.files.entries()) {
    const { questions } = bank.read(path);
    assert.deepEqual(questions.slice(0, count), JSON.parse(before[path]).questions);
    assert.equal(updatedManifest.files[i].count, count + (i < 2 ? 1 : 0));
    if (i >= 2) assert.deepEqual(bank.snapshot()[path], before[path]);
    else assert.deepEqual(questions.at(-1), { id: `manual-${questionFingerprint(input.questions[i * 3])}`,
      ...input.questions[i * 3], publishedOn: updatedManifest.updated });
  }
  const index = buildQuestionIndex(bank.root);
  assert.deepEqual(bank.read('questions/index.json'), index);
  assert.deepEqual(bank.read('reports/coverage-report.json'), analyzeCoverage(index,
    bank.read('scripts/coverage-targets.json'), bank.read('questions/topic-taxonomy.json')));
  const applied = bank.snapshot();
  succeeded(bank.run(input, '--apply'), /Applied.*received 4, added 0, duplicate 4, invalid-format 0/);
  assert.deepEqual(bank.snapshot(), applied);
  assert.deepEqual(readdirSync(bank.root).sort(), ['input.json', 'questions', 'reports', 'scripts']);
});

test('imports 1,000 questions with stable IDs and stamps the Cairo date', t => {
  const bank = fixture(t);
  const input = Array.from({ length: 1000 }, (_, i) => ({ ...bank.question, q: `Question number ${i}?` }));
  succeeded(bank.run(input, '--apply'), /received 1000, added 1000, duplicate 0, invalid-format 0/);
  const added = bank.read(bank.paths[0]).questions.slice(bank.manifest.files[0].count);
  assert.deepEqual(added.map(q => q.id), input.map(q => `manual-${questionFingerprint(q)}`));
  assert.equal(new Set(added.map(q => q.id)).size, 1000);
  const publicationDate = bank.read('questions/manifest.json').updated;
  assert.ok(added.every(q => q.publishedOn === publicationDate));
  assert.equal(cairoDate(new Date('2026-11-21T21:59:59Z')), '2026-11-21');
  assert.equal(cairoDate(new Date('2026-11-21T22:00:00Z')), '2026-11-22');
  assert.equal(cairoDate(new Date('2026-07-01T21:00:00Z')), '2026-07-02');
});

test('rejects malformed JSON, incompatible rows and unknown categories without partial updates', t => {
  const bank = fixture(t);
  const before = bank.snapshot();
  for (const [input, message, summary] of [
    ['{', /input.json/, /received 0, added 0, duplicate 0, invalid-format 1/],
    [{ questions: null }, /questions array/, /received 0, added 0, duplicate 0, invalid-format 1/],
    [[bank.question, { ...bank.question, answer: 4 }, { ...bank.question, category: 'LINQ' },
      { ...bank.question, code: {} }, { ...bank.question, conceptId: 'missing.concept' }],
    /Question 2:.*answer[\s\S]*Question 3: unsupported category "LINQ"[\s\S]*Question 4:.*code[\s\S]*Question 5:.*conceptId/,
    /received 5, added 0, duplicate 0, invalid-format 4/]
  ]) {
    const result = bank.run(input, '--apply');
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.match(result.stdout, summary);
    assert.deepEqual(bank.snapshot(), before);
  }
});

test('restores the bank when a prepared replacement fails', t => {
  const bank = fixture(t);
  const before = bank.snapshot();
  writeFileSync(join(bank.root, 'input.json'), JSON.stringify([bank.question]));
  writeFileSync(join(bank.root, 'fail-rename.cjs'), `
    const fs = require('node:fs');
    const { basename } = require('node:path');
    const rename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (basename(source) === 'manifest.json') throw new Error('test replacement failure');
      rename(source, target);
    };
    require('node:module').syncBuiltinESMExports();
  `);
  const result = spawnSync(process.execPath, ['--require', './fail-rename.cjs', cli, 'input.json', '--apply'],
    { cwd: bank.root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /test replacement failure/);
  assert.deepEqual(bank.snapshot(), before);
  assert.ok(!readdirSync(bank.root).includes('.question-import'));
});
