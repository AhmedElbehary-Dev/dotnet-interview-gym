import { buildQuestionIndex, compareText, isRecord, readJson, runArtifactCli } from './build-question-index.mjs';

function summarizeDimension(index, dimension, targets, policies) {
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
  const excluded = [];
  for (const category of index.categories) {
    const configured = policies?.[category]?.[dimension];
    if (configured && (!isRecord(configured) || Object.entries(configured).some(([label, minimum]) =>
        !Object.hasOwn(targets, label) || !Number.isSafeInteger(minimum) || minimum < 0))) {
      throw new Error(`invalid target for ${category} ${dimension}`);
    }
    for (const [label, target] of Object.entries(configured ?? targets)) {
      const observed = byCategory[category][label];
      if (observed < target) gaps.push({ category, dimension, label, observed, target, deficit: target - observed });
    }
    if (configured) {
      for (const label of Object.keys(targets).filter(label => !Object.hasOwn(configured, label))) {
        excluded.push({ category, dimension, label, observed: byCategory[category][label] });
      }
    }
  }
  return { totals, byCategory, gaps, excluded };
}

export function analyzeCoverage(index, targets, taxonomy) {
  const policies = targets?.categories;
  if (policies !== undefined && (!isRecord(policies) || index.categories.some(category =>
      !isRecord(policies[category]) || !['difficulty', 'skill', 'concepts'].every(key =>
        isRecord(policies[category][key])) || !Object.keys(policies[category].difficulty).length ||
        !Object.keys(policies[category].skill).length))) {
    throw new Error('Missing or invalid category coverage policy');
  }
  const difficulty = summarizeDimension(index, 'difficulty', targets?.difficulty, targets?.categories);
  const skill = summarizeDimension(index, 'skill', targets?.skill, targets?.categories);
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
  const conceptCoverage = [];
  const conceptGaps = [];
  for (const category of index.categories) {
    const questions = index.questions.filter(q => q.category === category);
    const configured = policies?.[category]?.concepts;
    const unknown = questions.filter(q => q.conceptId === undefined).length;
    const concepts = new Set([...Object.keys(configured ?? {}), ...questions.map(q => q.conceptId).filter(Boolean)]);
    for (const conceptId of [...concepts].sort(compareText)) {
      const observed = questions.filter(q => q.conceptId === conceptId).length;
      const hasTarget = configured !== undefined && Object.hasOwn(configured, conceptId);
      const target = hasTarget ? configured[conceptId] : null;
      if ((taxonomy && !Object.hasOwn(taxonomy.concepts, conceptId)) ||
          (hasTarget && (!Number.isSafeInteger(target) || target < 1))) {
        throw new Error(`invalid concept target for ${category}: ${conceptId}`);
      }
      const status = target === null ? 'unplanned' : observed >= target ? 'met' :
        observed + unknown >= target ? 'unknown' : 'gap';
      conceptCoverage.push({ category, conceptId, observed, unknown, target, status });
      if (status === 'gap') {
        conceptGaps.push({ category, dimension: 'concept', label: conceptId, observed, target,
          deficit: target - observed - unknown });
      }
    }
  }
  const gaps = [...difficulty.gaps, ...skill.gaps, ...conceptGaps].sort((a, b) =>
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
    excluded: [...difficulty.excluded, ...skill.excluded],
    conceptCoverage,
    potentialDuplicates,
    missingConceptClassification
  };
}

runArtifactCli(import.meta.url, 'reports/coverage-report.json', () =>
  analyzeCoverage(buildQuestionIndex(), readJson(process.cwd(), 'scripts/coverage-targets.json'),
    readJson(process.cwd(), 'questions/topic-taxonomy.json')));
