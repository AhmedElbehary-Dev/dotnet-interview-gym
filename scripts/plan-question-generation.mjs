import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCoverage } from './analyze-coverage.mjs';
import { buildQuestionIndex, isCalendarDate, readJson } from './build-question-index.mjs';

export function isMain(url) {
  return process.argv[1] && fileURLToPath(url) === resolve(process.argv[1]);
}

export function readPlanArgs([date, seed, ...extra]) {
  if (extra.length || !date || !seed) throw new Error('Usage: node <script> YYYY-MM-DD SEED');
  return { date, seed };
}

export function planGeneration(root, { date, seed }) {
  if (!isCalendarDate(date)) {
    throw new Error('Batch date must be a valid YYYY-MM-DD date');
  }
  if (typeof seed !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(seed)) {
    throw new Error('Seed must contain 1–64 letters, digits, hyphens or underscores');
  }
  const index = readJson(root, 'questions/index.json');
  const report = readJson(root, 'reports/coverage-report.json');
  const policies = readJson(root, 'scripts/coverage-targets.json');
  const taxonomy = readJson(root, 'questions/topic-taxonomy.json');
  if (JSON.stringify(index) !== JSON.stringify(buildQuestionIndex(root)) ||
      JSON.stringify(report) !== JSON.stringify(analyzeCoverage(index, policies, taxonomy))) {
    throw new Error('Coverage artifacts are stale. Rebuild the question index and coverage report.');
  }

  const gaps = new Map(report.gaps.map(g => [JSON.stringify([g.category, g.dimension, g.label]), g.deficit]));
  const deficit = (category, dimension, label) => gaps.get(JSON.stringify([category, dimension, label])) ?? 0;
  const choices = [];
  for (const { category, conceptId, observed, status } of report.conceptCoverage) {
    if (status === 'unknown' || status === 'unplanned') continue;
    const policy = policies.categories[category];
    for (const difficulty of Object.keys(policy.difficulty)) {
      for (const skill of Object.keys(policy.skill)) {
        const target = { category, conceptId, difficulty, skill };
        const score = deficit(category, 'concept', conceptId) * 10 +
          deficit(category, 'difficulty', difficulty) * 3 + deficit(category, 'skill', skill) * 3;
        const rank = createHash('sha256').update(JSON.stringify([date, seed, target])).digest().readUInt32BE();
        choices.push({ target, score, rank, observed });
      }
    }
  }

  const targets = [];
  const used = new Set();
  const counts = new Map();
  const penalty = (field, value) => counts.get(JSON.stringify([field, value])) ?? 0;
  while (targets.length < 10) {
    const score = ({ target, score, observed }) => score - observed -
      20 * penalty('category', target.category) - 6 * penalty('difficulty', target.difficulty) -
      6 * penalty('skill', target.skill);
    const candidate = choices.filter(({ target }) => !used.has(target.conceptId))
      .sort((a, b) => score(b) - score(a) || a.rank - b.rank)[0];
    if (!candidate) throw new Error('Coverage policy requires at least 10 distinct classified or confirmed-gap concepts');
    const { target } = candidate;
    used.add(target.conceptId);
    for (const field of ['category', 'difficulty', 'skill']) {
      counts.set(JSON.stringify([field, target[field]]), penalty(field, target[field]) + 1);
    }
    targets.push(target);
  }
  return { schemaVersion: 1, date, seed, targets };
}

if (isMain(import.meta.url)) {
  try {
    console.log(JSON.stringify(planGeneration(process.cwd(), readPlanArgs(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
