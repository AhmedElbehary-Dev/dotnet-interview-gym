import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildQuestionIndex } from './build-question-index.mjs';
import { analyzeCoverage } from './analyze-coverage.mjs';

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const manifest = readJson('questions/manifest.json');
const targets = readJson('scripts/coverage-targets.json');
const { categories, ...fixtureTargets } = targets;
const mapping = readJson('questions/concept-map.json').questions;
const question = { id: 1, q: 'Explain deferred execution.', category: 'LINQ', difficulty: 'أساسي', skill: 'مفهوم' };
const source = 'questions/sample.json';

function fixture(t, questions, concepts = {}, total = questions.length) {
  const root = mkdtempSync(join(tmpdir(), 'gym-coverage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'questions'));
  const write = (path, value) => writeFileSync(join(root, path), JSON.stringify(value));
  write('questions/manifest.json', { schemaVersion: 1, total, files: [{ path: source, category: 'LINQ', count: questions.length }] });
  write('questions/topic-taxonomy.json', { schemaVersion: 1, concepts });
  write(source, { questions });
  return root;
}

test('indexes the original 120 IDs and maps each entry to its source question', () => {
  const index = buildQuestionIndex();
  const originals = new Map(manifest.files.map(f => [f.path, readJson(f.path).questions]));
  const ids = index.questions.map(q => q.id);
  assert.deepEqual(ids.slice(0, 120), Array.from({ length: 120 }, (_, i) => i + 1));
  assert.equal(ids.length, manifest.total);
  assert.equal(new Set(ids.map(String)).size, ids.length);
  for (const { id, category, difficulty, skill, source, fingerprint, ...extra } of index.questions) {
    const original = originals.get(source).find(q => q.id === id);
    assert.deepEqual({ category, difficulty, skill }, {
      category: original.category, difficulty: original.difficulty, skill: original.skill
    });
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    const conceptId = original.conceptId ?? mapping[id];
    assert.deepEqual(extra, conceptId === undefined ? {} : { conceptId });
  }
});

test('reports bank totals, distributions, and both category cross-tabs', () => {
  const report = analyzeCoverage(buildQuestionIndex(), targets);
  const bank = manifest.files.flatMap(({ path }) => readJson(path).questions);
  assert.equal(report.totalQuestions, bank.length);
  for (const [dimension, totals, crossTab] of [
    ['difficulty', report.byDifficulty, report.categoryByDifficulty],
    ['skill', report.bySkill, report.categoryBySkill]
  ]) {
    const labels = new Set([...Object.keys(targets[dimension]), ...bank.map(q => q[dimension])]);
    assert.deepEqual(totals, Object.fromEntries([...labels].map(label => [label, bank.filter(q => q[dimension] === label).length])));
    for (const category of new Set([...manifest.files.map(f => f.category), ...bank.map(q => q.category)])) {
      const questions = bank.filter(q => q.category === category);
      assert.equal(report.byCategory[category], questions.length);
      assert.deepEqual(crossTab[category], Object.fromEntries([...labels].map(label => [label, questions.filter(q => q[dimension] === label).length])));
    }
  }
});

test('committed artifacts match deterministic CLI output', () => {
  for (const script of ['build-question-index', 'analyze-coverage']) {
    const result = spawnSync(process.execPath, [`scripts/${script}.mjs`, '--check'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('generates identical bytes and rejects stale files without rewriting them', t => {
  const root = fixture(t, [question]);
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/coverage-targets.json'), JSON.stringify(fixtureTargets));
  for (const [script, path] of [
    ['build-question-index', 'questions/index.json'],
    ['analyze-coverage', 'reports/coverage-report.json']
  ]) {
    const output = join(root, path);
    const run = (...args) => spawnSync(process.execPath, [resolve(`scripts/${script}.mjs`), ...args], { cwd: root, encoding: 'utf8' });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const bytes = readFileSync(output);
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(readFileSync(output), bytes);
    writeFileSync(output, '{}');
    const stale = run('--check');
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /is stale/);
    assert.equal(readFileSync(output, 'utf8'), '{}');
  }
});

test('handles empty shards with zero counts and configured gaps', t => {
  const report = analyzeCoverage(buildQuestionIndex(fixture(t, [])), fixtureTargets);
  assert.equal(report.totalQuestions, 0);
  assert.deepEqual(report.byCategory, { LINQ: 0 });
  assert.deepEqual(report.byDifficulty, Object.fromEntries(Object.keys(targets.difficulty).map(label => [label, 0])));
  assert.equal(report.gaps.length, [...Object.values(targets.difficulty), ...Object.values(targets.skill)].filter(n => n > 0).length);
  assert.deepEqual(report.potentialDuplicates, []);
  assert.deepEqual(report.missingConceptClassification, []);
});

test('rejects malformed data and duplicate IDs', t => {
  assert.throws(() => buildQuestionIndex(fixture(t, [null])), /invalid question/);
  assert.throws(() => buildQuestionIndex(fixture(t, [{ ...question, q: ' ' }])), /missing q/);
  assert.throws(() => buildQuestionIndex(fixture(t, [question, question])), /duplicate ID/);
  assert.throws(() => buildQuestionIndex(fixture(t, [question, { ...question, id: '1' }])), /duplicate ID/);
  assert.throws(() => buildQuestionIndex(fixture(t, [question], {}, 2)), /total mismatch/);
  const root = fixture(t, []);
  writeFileSync(join(root, source), '{');
  assert.throws(() => buildQuestionIndex(root), /sample\.json/);
  writeFileSync(join(root, source), '{}');
  assert.throws(() => buildQuestionIndex(root), /expected questions array/);
});

test('flags normalized prompt duplicates and preserves distinct questions', t => {
  const root = fixture(t, [
    { ...question, q: 'Explain café execution.' },
    { ...question, id: 2, q: '  EXPLAIN\nCAFE\u0301   EXECUTION.  ' },
    { ...question, id: 3, q: 'Explain immediate café execution.' }
  ]);
  const index = buildQuestionIndex(root);
  const report = analyzeCoverage(index, fixtureTargets);
  assert.deepEqual(report.potentialDuplicates, [
    { fingerprint: index.questions[0].fingerprint, questionIds: [1, 2] }
  ]);
  assert.equal(report.totalQuestions, 3);
});

test('uses explicit registered concepts and reports absent concept IDs as unknown', t => {
  const conceptId = 'linq.deferred-execution';
  const root = fixture(t, [question, { ...question, id: 2, conceptId }], { [conceptId]: 'Deferred execution' });
  const index = buildQuestionIndex(root);
  assert.equal(index.questions[0].conceptId, undefined);
  assert.equal(index.questions[1].conceptId, conceptId);
  assert.deepEqual(analyzeCoverage(index, fixtureTargets).missingConceptClassification, [1]);
  assert.throws(() => buildQuestionIndex(fixture(t, [{ ...question, conceptId }])), /unregistered conceptId/);
});

test('ranks gaps by deficit with deterministic category, dimension, and label ties', t => {
  const index = buildQuestionIndex(fixture(t, [question]));
  const report = analyzeCoverage(index, { difficulty: { 'أساسي': 3, 'متوسط': 4 }, skill: { 'مفهوم': 1, 'فهم الكود': 2 } });
  assert.deepEqual(report.gaps.map(g => [g.dimension, g.label, g.observed, g.target, g.deficit]), [
    ['difficulty', 'متوسط', 0, 4, 4],
    ['difficulty', 'أساسي', 1, 3, 2],
    ['skill', 'فهم الكود', 0, 2, 2]
  ]);
  const tied = analyzeCoverage({ ...index, categories: ['Z', 'LINQ'] }, {
    difficulty: { z: 2, a: 2 }, skill: { z: 2 }
  });
  assert.deepEqual(tied.gaps.map(g => [g.category, g.dimension, g.label]), [
    ['LINQ', 'difficulty', 'a'], ['LINQ', 'difficulty', 'z'], ['LINQ', 'skill', 'z'],
    ['Z', 'difficulty', 'a'], ['Z', 'difficulty', 'z'], ['Z', 'skill', 'z']
  ]);
  assert.throws(() => analyzeCoverage(index, { difficulty: { beginner: -1 }, skill: {} }), /invalid target/);
});

test('reports an observed excluded combination and a conservative concept deficit', t => {
  const concept = 'linq.deferred-execution';
  const index = buildQuestionIndex(fixture(t, [
    { ...question, conceptId: concept }, { ...question, id: 2, difficulty: 'متقدم' }
  ], { [concept]: 'Deferred execution' }));
  const policy = { difficulty: { 'أساسي': 1, 'متقدم': 1 }, skill: { 'مفهوم': 1 }, categories: {
    LINQ: { difficulty: { 'أساسي': 1 }, skill: { 'مفهوم': 1 }, concepts: { [concept]: 3 } }
  } };
  const report = analyzeCoverage(index, policy);
  assert.deepEqual(report.excluded, [{ category: 'LINQ', dimension: 'difficulty', label: 'متقدم', observed: 1 }]);
  assert.deepEqual(report.conceptCoverage, [
    { category: 'LINQ', conceptId: concept, observed: 1, unknown: 1, target: 3, status: 'gap' }
  ]);
  assert.deepEqual(report.gaps.map(g => [g.dimension, g.deficit]), [['concept', 1]]);
  policy.categories.LINQ.concepts[concept] = 2;
  const uncertain = analyzeCoverage(index, policy);
  assert.equal(uncertain.conceptCoverage[0].status, 'unknown');
  assert.deepEqual(uncertain.gaps, []);
});
