# .NET Interview GYM

A free, static, community-editable interview practice app with English MCQs, brief Egyptian-Arabic hints and explanations, timed exam and study modes, topic filters, and progress saved locally.

## Current scope

- The original 120 questions cover C#, .NET, SQL Server, React, security, and delivery. The app shows the current bank size.
- Independent JSON question files, with stable IDs and a manifest.
- **الأسئلة الجديدة** shows additions from today and the previous six Cairo calendar days. Older questions stay in the practice bank.
- Prefer **unseen questions**; previously answered questions only appear when the matching pool runs out. Review mode selects missed questions.
- Pause/resume a timed exam; show explanations only during learning mode or in the final report.
- Export/import your history as JSON; no account, database, or server-side user tracking.
- Theme switch (light/dark), code blocks, keyboard shortcuts.
- Confirmation popups styled to match the app using [MicroModal](https://github.com/micromodal/Micromodal) loaded from a pinned CDN version, with an in-project fallback if it cannot load. Small nonblocking toasts for feedback.

## Deploy on GitHub Pages (free for public projects)

1. Create a **public** GitHub repository, e.g., `dotnet-interview-gym`.
2. Upload the **contents of this folder** to the repository root, then commit them to `main`.
3. Navigate to **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
4. Select **Branch: `main` / Folder: `/ (root)`**, then save.
5. The site will be available at `https://YOUR-USERNAME.github.io/dotnet-interview-gym/` after publication. The folder name and repo name must match to use that URL.

The static app runs without a database, API key, or package install. `.nojekyll` prevents Jekyll handling of static files. To enable automated question publishing, follow the [Daily Question Engine setup](docs/daily-questions.md) to switch the Pages source to GitHub Actions.

## Local development

Do **not** open `index.html` using `file://`, since browser security prevents fetching local JSON files. Run a basic static server in the folder:

```sh
python -m http.server 5500
```

Then open `http://localhost:5500/`. Node alternatives like `npx serve .` also work.

## Add questions

Each question shard listed in `questions/manifest.json` uses this format:

```json
{
  "category": "SQL Server",
  "questions": [
    {
      "id": 2001,
      "category": "SQL Server",
      "q": "Which index design is best for this query?",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "answer": 0,
      "why": "شرح واضح باللهجة المصرية للسبب والبدائل.",
      "hint": "لمحة قصيرة من غير كشف الحل.",
      "difficulty": "متوسط",
      "skill": "حل مشكلة"
    }
  ]
}
```

Use a unique, stable numeric ID or simple lowercase string ID; never reuse a retired ID for a different question because users' history is keyed by ID. When a shard changes, update `manifest.json` counts. Run:

```sh
node scripts/validate-questions.mjs
node scripts/smoke-test.mjs
```

**Content quality first:** Verify factual correctness and code behavior against official documentation and executable examples where possible, avoid leaked copyrighted interview question dumps, and favor scenario-based questions over memorized trivia. Community contributions are reviewed before merging.

### Question index and coverage

After changing the bank or coverage targets, regenerate and commit both artifacts.

```sh
node scripts/build-question-index.mjs
node scripts/analyze-coverage.mjs
```

`questions/index.json` stores IDs, metadata, shard paths and SHA-256 fingerprints. Prompts are normalized with Unicode NFC, case folding and whitespace folding. Structured code samples also contribute their language, prompt and snippet. Snippets preserve case and whitespace apart from CRLF normalization.

`scripts/coverage-targets.json` defines allowed difficulties, skill minimums and concept targets for each category. Omitted difficulties appear under `excluded`. The report ranks confirmed gaps by descending shortfall, then by category, dimension and label. If unclassified questions could meet a concept target, the report marks it `unknown`.

Register stable concept IDs such as `linq.deferred-execution` in `questions/topic-taxonomy.json`. Classify existing questions by ID in `questions/concept-map.json`, or provide an optional `conceptId` on the question. Leave uncertain classifications absent.

### V8.2.3 candidate generation

Use Node.js 22 from the repository root. The planner reads the current index and report, checks them for staleness, and emits ten targets as JSON. A date and seed reproduce the plan offline.

```sh
node scripts/plan-question-generation.mjs 2026-11-21 review
```

Groq is the default when `QUESTION_AI_PROVIDER` is unset. Set `GROQ_API_KEY` for authentication. `GROQ_MODEL` defaults to `qwen/qwen3.8-27b`, and `GROQ_REASONING_EFFORT` defaults to `none` for that model. For another Groq model, leave the effort unset or choose a value the model supports.

Generate one candidate from the repository root in PowerShell 7 with Node.js 22:

```powershell
$env:QUESTION_AI_PROVIDER = 'groq'
$env:GROQ_MODEL = 'qwen/qwen3.8-27b'
$env:GROQ_REASONING_EFFORT = 'none'
$env:GROQ_API_KEY = Read-Host 'Groq API key' -MaskInput
try {
    node scripts/generate-question-candidates.mjs 2026-11-21 review --limit 1
} finally {
    Remove-Item Env:GROQ_API_KEY
}
```

For OpenRouter, set `QUESTION_AI_PROVIDER=openrouter` and supply `OPENROUTER_API_KEY` with the same masked prompt and cleanup pattern. `OPENROUTER_MODEL` defaults to `openrouter/free`, which selects among compatible free models. A model override may incur charges. `OPENROUTER_TIMEOUT_MS` defaults to 45000. Both providers request JSON object mode and validate the candidate schema locally. Requests stay on the selected provider and model, and OpenRouter routing requires support for the requested parameters.

Keep API keys in the local CLI environment or GitHub Actions secrets. The validation workflow uses mocked requests and needs no credentials.

The generator sends up to two briefs per request with a 1,600-token completion cap per candidate. It can split a truncated pair into single requests. Transient failures allow up to three attempts per request within a shared budget of the selected candidate count plus two. The seed fixes target selection, while live model output can vary.

The CLI prints the path to `candidates.json` in a new sibling staging directory named `interview-gym-candidate-staging-*`. If a later request fails, the CLI can stage earlier validated candidates as an incomplete batch and exit with an error. Review proposed answers, dialect quality, semantic duplicates and source claims before adding any candidate to the bank.

## Progress and privacy

All history is stored in browser `localStorage` as `interview_gym_history_v2`; current round in `interview_gym_session_v2`. No cloud syncing is used. An exported progress file is the only portable record of completed questions. Different site origins (e.g., `file://` and `github.io`) do not share browser storage. Don't import progress JSON from untrusted sources.

## License

The application code is released under the MIT License by [Ahmed Elbehary](https://github.com/AhmedElbehary-Dev). Newly contributed original question text and explanations are licensed under CC BY 4.0 unless the contributor states otherwise. Do not submit copied third-party question banks or proprietary interview material.

## V7 — Adaptive assessment

- **Placement Test**: 30 timed questions sampled across the available categories. The next difficulty adjusts to your latest answer in the same area. Arabic hints are hidden by default in placement; showing one is recorded as assistance.
- **Adaptive Practice**: personalized category mix based on weak areas and unseen questions; difficulty changes during the round. The selected difficulty filter is intentionally ignored in adaptive mode.
- **Skill Profile**: provisional per-category performance indicators using distinct questions, difficulty and hint use. These are **not certified psychometric scores or job seniority labels**. A limited 120-question bank, uneven difficulty coverage and small samples constrain accuracy.
- Saved progress and history keep their existing localStorage keys; prior sessions still resume. Export/import remains available.
- All assessment logic is local JavaScript: no tracking, login, cloud database or cost.

Run checks with `node scripts/validate-questions.mjs`, `node scripts/assessment-test.mjs`, and `node scripts/smoke-test.mjs`.

## Branding

Our new barbell-and-code icon combines the `.NET` developer experience with the **GYM** idea: practice a little, improve every day. The logo, favicon and touch icon live in `assets/` and can be freely adapted under the repository license.
