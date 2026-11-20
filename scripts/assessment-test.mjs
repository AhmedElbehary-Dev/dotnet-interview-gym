import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const engine = fs.readFileSync('assets/assessment.js', 'utf8');
const sandbox = vm.createContext({ Math });
vm.runInContext(engine, sandbox);
const { buildProfile, buildTopicQueue, chooseQuestion } = sandbox.GymAssessment;
const manifest = JSON.parse(fs.readFileSync('questions/manifest.json', 'utf8'));
const bank = manifest.files.flatMap(file => JSON.parse(fs.readFileSync(file.path, 'utf8')).questions);
const histogram = count => Object.fromEntries([...new Set(count)].map(x => [x, count.filter(y => y === x).length]));

const placement = [...buildTopicQueue(bank, {}, 'placement', 30, 'all', () => 0.33)];
assert.equal(placement.length, 30);
assert.equal(Object.keys(histogram(placement)).length, 10);
for (const count of Object.values(histogram(placement))) assert.equal(count, 3);

const state = { plan: 'placement', topicQueue: placement, ids: [], answers: {}, skillFilter: 'all' };
const history = {};
for (let i = 0; i < placement.length; i++) {
  const next = chooseQuestion(bank, history, state, () => 0.2);
  assert.ok(next, `question ${i} exists`);
  assert.equal(next.category, placement[i]);
  assert.ok(!state.ids.includes(next.id), `question ${next.id} is new for this round`);
  state.ids.push(next.id);
  const correct = i % 4 !== 0;
  state.answers[next.id] = { correct, hintUsed: i === 9 };
  history[next.id] = { correct: +correct, wrong: +!correct, lastCorrect: correct, lastHint: i === 9 };
}
assert.equal(state.ids.length, 30);
assert.equal(chooseQuestion(bank, history, state), null);
const result = buildProfile(bank, history);
assert.equal(result.assessed, 10);
assert.equal(result.attempted, 30);
assert.equal(result.categories.length, 10);
for (const p of result.categories) {
  assert.equal(p.count, 3);
  assert.ok(p.score >= 0 && p.score <= 100);
  assert.equal(p.confidence, 'منخفض');
}

// Scores count distinct questions, not repetitions; hints reduce a correct result's weight.
const x = bank.find(q => q.difficulty === 'متقدم');
const baseline = buildProfile([x], { [x.id]: { correct: 99, wrong: 1, lastCorrect: true, lastHint: false } }).categories[0];
const assisted = buildProfile([x], { [x.id]: { correct: 99, wrong: 1, lastCorrect: true, lastHint: true } }).categories[0];
assert.equal(baseline.count, 1);
assert.equal(baseline.score, 100);
assert.equal(assisted.score, 75);

// Adaptive practice allocates more slots to areas with weak measured performance.
const sample = bank.filter(q => ['أساسيات C#', 'C# المتقدم وLINQ'].includes(q.category));
const h2 = {};
for (const q of sample) h2[q.id] = { correct: q.category === 'أساسيات C#' ? 0 : 1, wrong: q.category === 'أساسيات C#' ? 1 : 0,
  lastCorrect: q.category !== 'أساسيات C#' };
const adaptive = [...buildTopicQueue(sample, h2, 'adaptive', 18, 'all', () => 0.2)];
const share = histogram(adaptive);
assert.ok(share['أساسيات C#'] > share['C# المتقدم وLINQ'], JSON.stringify(share));
assert.ok(Math.max(...Object.values(share)) <= 12);
console.log('Assessment tests passed: balanced placement, adaptive question choice, distinct attempts, confidence, hints, and weighted focus.');
