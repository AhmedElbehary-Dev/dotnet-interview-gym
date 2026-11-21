# Daily Question Engine

The engine proposes up to ten prose-only questions for gaps in the current bank. Groq Free Plan runs `qwen/qwen3.8-27b` for generation and `openai/gpt-oss-20b` for strict independent review. A source-only repair gets one fresh review. Questions need an independently solved answer, verified citations and a pass on every review finding. Each question keeps its verified source URLs, a stable fingerprint-based ID and a `publishedOn` date in Africa/Cairo.

The repository can publish at most one batch per Cairo calendar date. GitHub schedules the workflow for local midnight, including daylight-saving transitions. The workflow uses the run's creation timestamp so a delayed job can run later that day and a rerun from a previous day cannot claim today's date. A publication commit consumes its date, even if that commit is later reverted. A zero-approval run leaves the bank unchanged. Rate limits, interruptions and provider errors can reduce output or leave the day without a publication.

## Enable

1. Complete the feature branch integration review, then merge it into `main`. Leave the two variables below unset during review.
2. Use a Groq **Free Plan** API key. In **Settings → Secrets and variables → Actions → Secrets**, create `GROQ_API_KEY`. The workflow sets `GROQ_REVIEW_FREE_PLAN=1` for this key. The secret is available only to the engine step. There is no paid fallback.
3. In **Actions → Daily questions and Pages**, run the workflow from `main` in `preview` mode. Check the run summary and the strict reviewer diagnostics. Confirm at least one question reaches approval and that `Validate the proposed site` passes. If Groq rejects the request, keep the scheduler disabled and retain the run URL and safe HTTP diagnostics.
4. In **Settings → Pages → Build and deployment**, set **Source** to **GitHub Actions**. Restrict the `github-pages` environment to `main` under **Settings → Environments**. If the environment requires manual approval, unattended deployments wait for that approval.
5. Create the Actions repository variable `PAGES_ACTIONS_ENABLED` with value `true`. Dispatch `deploy` from `main` and check that the Pages deployment succeeds and the site loads. This publishes the current validated site without generation.
6. Dispatch `publish` from `main`. Confirm that the branch receives one publication commit, Pages serves it, New Arrivals shows the approved questions and a previous round can still be resumed. If zero questions are approved, the run reports the outcome without a branch update. Rerun the same day once the underlying issue is resolved.
7. Set Actions repository variable `DAILY_QUESTIONS_ENABLED` to `true` to enable the midnight schedule. Manual modes remain available from `main`. A same-day `publish` rerun after a successful push deploys the existing bank without calling Groq or adding questions again.

The prepare job requests `actions: read` for the run timestamp and `contents: write` for the guarded update to `main`. The deployment job requests `pages: write` and `id-token: write` for GitHub Pages. The repository can keep read-only default workflow permissions. Branch rules must allow the workflow's `GITHUB_TOKEN` to make a fast-forward update to `main`. There is no PAT requirement. The workflow stages and validates the complete bank and uploads a static site artifact before updating the branch. It deploys that artifact explicitly in the same workflow because a push with `GITHUB_TOKEN` does not trigger the ordinary push workflow.

## Verification and recovery

- `preview` performs generation and review and validates a proposed commit without updating a branch or deploying. Review logs retain only safe metadata and decision reasons. The scratch directory and approval records are temporary. A retry generates and reviews fresh candidates.
- The request budget is at most 12 generation calls and 22 review calls per run, including retries and source repairs. The engine spaces live calls to each model and bounds retry waits and total runtime. Published output can range from zero to ten questions.
- If generation or validation fails, the existing Pages deployment stays available. If the branch update succeeds and Pages fails, rerun `publish` on the same Cairo date or dispatch `deploy` on `main`. Both use the latest validated bank.
- To roll back an incorrect publication, turn off `DAILY_QUESTIONS_ENABLED`, revert the offending commit on `main`, and check the Pages run from the revert. Use `deploy` if the push run did not deploy. Preserve the commit history so the reverted date cannot publish a second batch.

The validation workflow uses Node.js 22. Run the same test suites locally with `node --test scripts/*-test.mjs`, and check the bank with `node scripts/validate-questions.mjs`, `node scripts/build-question-index.mjs --check`, and `node scripts/analyze-coverage.mjs --check`.
