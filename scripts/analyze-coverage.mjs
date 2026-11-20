import { buildQuestionIndex, compareText, isRecord, readJson, runArtifactCli } from './build-question-index.mjs';

function summarizeDimension(index, dimension, targets) {
  if (!isRecord(targets)) throw new Error(`Missing targets for ${dimension}`);
  for (const [label, minimum] of Object.entries(targets)) {
    if (!label.trim() || !Number.isSafeInteger(minimum) || minimum < 0) {
      throw new Error(`invalid target for ${dimension}: ${label}`);
    }
  }
  const labels = [...new Set([...Object.keys(targets), ...index.questions.map(q => q[dimension])])].sort(compareText);
  const zeros = () => Object.fromEntries(labels.map(label => [label, 0]));
  const totals = zeros();
  const byCategory = Object.fromEntries(index.categories.map(category => [category, zeros()]));
  for (const q of index.questions) {
    totals[q[dimension]]++;
    byCategory[q.category][q[dimension]]++;
  }
  const gaps = [];
  for (const category of index.categories) {
    for (const [label, target] of Object.entries(targets)) {
      const observed = byCategory[category][label];
      if (observed < target) gaps.push({ category, dimension, label, observed, target, deficit: target - observed });
    }
  }
  return { totals, byCategory, gaps };
}

export function analyzeCoverage(index, targets) {
  const difficulty = summarizeDimension(index, 'difficulty', targets?.difficulty);
  const skill = summarizeDimension(index, 'skill', targets?.skill);
  const byCategory = Object.fromEntries(index.categories.map(category => [category, 0]));
  const byFingerprint = new Map();
  const missingConceptClassification = [];
  for (const q of index.questions) {
    byCategory[q.category]++;
    if (!byFingerprint.has(q.fingerprint)) byFingerprint.set(q.fingerprint, []);
    byFingerprint.get(q.fingerprint).push(q.id);
    if (q.conceptId === undefined) missingConceptClassification.push(q.id);
  }
  const potentialDuplicates = [...byFingerprint]
    .filter(([, ids]) => ids.length > 1)
    .map(([fingerprint, questionIds]) => ({ fingerprint, questionIds }));
  const gaps = [...difficulty.gaps, ...skill.gaps].sort((a, b) =>
    b.deficit - a.deficit || compareText(a.category, b.category) ||
    compareText(a.dimension, b.dimension) || compareText(a.label, b.label));
  return {
    schemaVersion: 1,
    totalQuestions: index.questions.length,
    byCategory,
    byDifficulty: difficulty.totals,
    bySkill: skill.totals,
    categoryByDifficulty: difficulty.byCategory,
    categoryBySkill: skill.byCategory,
    gaps,
    potentialDuplicates,
    missingConceptClassification
  };
}

runArtifactCli(import.meta.url, 'reports/coverage-report.json', () =>
  analyzeCoverage(buildQuestionIndex(), readJson(process.cwd(), 'scripts/coverage-targets.json')));
