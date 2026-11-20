# .NET Interview GYM

A free, static, community-editable interview practice app with English MCQs, brief Egyptian-Arabic hints and explanations, timed exam and study modes, topic filters, and progress saved locally.

## Current scope

- **120 real questions** carried from the original app, across C#, .NET, SQL Server, React, security, and delivery topics. **5,000 is a future target, not a published count.**
- Independent JSON question files, with stable IDs and a manifest.
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

No database, environment variables, API keys, build process, or runtime package install is needed. `.nojekyll` prevents Jekyll handling of static files. The GitHub Actions workflow validates JSON data when code is pushed; it is **not** a required deployment workflow.

## Local development

Do **not** open `index.html` using `file://`, since browser security prevents fetching local JSON files. Run a basic static server in the folder:

```sh
python -m http.server 5500
```

Then open `http://localhost:5500/`. Node alternatives like `npx serve .` also work.

## Add questions

Each `questions/*.json` file (except `manifest.json`) looks like:

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

## Progress and privacy

All history is stored in browser `localStorage` as `interview_gym_history_v2`; current round in `interview_gym_session_v2`. No cloud syncing is used. An exported progress file is the only portable record of completed questions. Different site origins (e.g., `file://` and `github.io`) do not share browser storage. Don't import progress JSON from untrusted sources.

## License

The application code is released under the MIT License. Newly contributed original question text and explanations are licensed under CC BY 4.0 unless the contributor states otherwise. Do not submit copied third-party question banks or proprietary interview material.

## V7 — Adaptive assessment

- **Placement Test**: 30 timed questions sampled across the available categories. The next difficulty adjusts to your latest answer in the same area. Arabic hints are hidden by default in placement; showing one is recorded as assistance.
- **Adaptive Practice**: personalized category mix based on weak areas and unseen questions; difficulty changes during the round. The selected difficulty filter is intentionally ignored in adaptive mode.
- **Skill Profile**: provisional per-category performance indicators using distinct questions, difficulty and hint use. These are **not certified psychometric scores or job seniority labels**. A limited 120-question bank, uneven difficulty coverage and small samples constrain accuracy.
- Saved progress and history keep their existing localStorage keys; prior sessions still resume. Export/import remains available.
- All assessment logic is local JavaScript: no tracking, login, cloud database or cost.

Run checks with `node scripts/validate-questions.mjs`, `node scripts/assessment-test.mjs`, and `node scripts/smoke-test.mjs`.

## Branding

Our new barbell-and-code icon combines the `.NET` developer experience with the **GYM** idea: practice a little, improve every day. The logo, favicon and touch icon live in `assets/` and can be freely adapted under the repository license.
