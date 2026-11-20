/* Adaptive practice and provisional skill estimates. Runs entirely in the browser.
   No claim of psychometric calibration: question difficulty is editorial metadata. */
(function (root) {
  'use strict';
  const LEVEL = { 'أساسي': 1, 'متوسط': 2, 'متقدم': 3 };
  const WEIGHT = { 1: 1, 2: 1.35, 3: 1.7 };
  const rank = q => LEVEL[q.difficulty] || 2;
  const unique = xs => [...new Set(xs)];
  const randomSort = (values, rng = Math.random) => {
    const a = [...values];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  function buildProfile(bank, history = {}) {
    const categories = unique(bank.map(q => q.category));
    const report = categories.map(category => {
      const pool = bank.filter(q => q.category === category);
      const attempted = pool.filter(q => history[q.id] && Number(history[q.id].correct || 0) + Number(history[q.id].wrong || 0) > 0);
      let earned = 0, available = 0, hardCorrect = 0, mediumCorrect = 0, assisted = 0;
      const difficulties = new Set();
      for (const q of attempted) {
        const item = history[q.id];
        const weight = WEIGHT[rank(q)];
        const correct = item.lastCorrect === true;
        difficulties.add(rank(q));
        earned += weight * (correct ? (item.lastHint ? 0.75 : 1) : 0);
        available += weight;
        if (correct && rank(q) === 3) hardCorrect++;
        if (correct && rank(q) === 2) mediumCorrect++;
        if (item.lastHint) assisted++;
      }
      const score = available ? Math.round(100 * earned / available) : null;
      let level = 'لم يُقيَّم';
      if (attempted.length >= 3) {
        if (hardCorrect >= 2 && mediumCorrect >= 1 && score >= 75) level = 'متقدم مبدئيًا';
        else if (mediumCorrect >= 1 && score >= 60) level = 'متوسط مبدئيًا';
        else if (score >= 65 && difficulties.has(1)) level = 'أساسيات قوية';
        else level = 'يحتاج مراجعة';
      } else if (attempted.length) level = 'بيانات محدودة';
      const confidence = attempted.length >= 9 && difficulties.size >= 2 ? 'تغطية أفضل' : attempted.length >= 5 && difficulties.size >= 2 ? 'مبدئي' : 'منخفض';
      return { category, count: attempted.length, total: pool.length, score, level, confidence,
        assisted, difficultyCoverage: difficulties.size, weak: attempted.filter(q => !history[q.id].lastCorrect).length };
    });
    const tested = report.filter(x => x.count > 0);
    return { categories: report, assessed: tested.length,
      attempted: report.reduce((s, x) => s + x.count, 0),
      average: tested.length ? Math.round(tested.reduce((s, x) => s + x.score * x.count, 0) / tested.reduce((s, x) => s + x.count, 0)) : null };
  }

  function buildTopicQueue(bank, history, kind, target, category = 'all', rng = Math.random) {
    const all = unique(bank.map(q => q.category));
    const names = category !== 'all' ? all.filter(c => c === category) : all;
    if (!names.length || target < 1) return [];
    const profile = buildProfile(bank, history);
    const info = new Map(profile.categories.map(p => [p.category, p]));
    const poolLimit = new Map(names.map(c => [c, bank.filter(q => q.category === c).length]));
    const counts = new Map(names.map(c => [c, 0]));
    const queue = [];
    const tie = new Map(randomSort(names, rng).map((c, i) => [c, i]));
    while (queue.length < target) {
      let candidates = names.filter(c => counts.get(c) < poolLimit.get(c));
      if (!candidates.length) break;
      candidates.sort((a, b) => {
        const pa = info.get(a), pb = info.get(b);
        const wa = kind === 'placement' ? 1 : (pa.count === 0 ? 1.5 : pa.score < 60 ? 2.5 : pa.score < 80 ? 1.8 : 1);
        const wb = kind === 'placement' ? 1 : (pb.count === 0 ? 1.5 : pb.score < 60 ? 2.5 : pb.score < 80 ? 1.8 : 1);
        return counts.get(a) / wa - counts.get(b) / wb || tie.get(a) - tie.get(b);
      });
      const selected = candidates[0];
      queue.push(selected);
      counts.set(selected, counts.get(selected) + 1);
    }
    return queue;
  }

  function chooseQuestion(bank, history, state, rng = Math.random) {
    const used = new Set(state.ids);
    const nextCategory = state.topicQueue?.[state.ids.length];
    if (!nextCategory) return null;
    const candidates = bank.filter(q => q.category === nextCategory && !used.has(q.id) &&
      (!state.skillFilter || state.skillFilter === 'all' || q.skill === state.skillFilter));
    if (!candidates.length) return null;
    const attempts = state.ids
      .map(id => bank.find(q => q.id === id))
      .filter(q => q && q.category === nextCategory && state.answers[q.id])
      .map(q => ({ q, answer: state.answers[q.id] }));
    const previous = attempts.at(-1);
    const profile = buildProfile(bank, history).categories.find(p => p.category === nextCategory);
    let desired = profile?.count >= 5 && profile.score >= 80 ? 3 : 2;
    if (state.plan === 'placement' && !previous) desired = 2;
    if (previous) {
      desired = Math.max(1, Math.min(3, rank(previous.q) + (previous.answer.correct && !previous.answer.hintUsed ? 1 : -1)));
    }
    const coveredSkills = new Map(attempts.map(x => [x.q.skill, attempts.filter(y => y.q.skill === x.q.skill).length]));
    const scored = candidates.map(q => ({ q, value:
      (history[q.id] ? 0 : 8) - Math.abs(rank(q) - desired) * 3 -
      (coveredSkills.get(q.skill) || 0) * 0.5 +
      (history[q.id] && history[q.id].lastCorrect === false ? 2 : 0) + rng() * 0.1
    }));
    scored.sort((a, b) => b.value - a.value);
    return scored[0].q;
  }

  root.GymAssessment = Object.freeze({ buildProfile, buildTopicQueue, chooseQuestion });
}(typeof window === 'undefined' ? globalThis : window));
