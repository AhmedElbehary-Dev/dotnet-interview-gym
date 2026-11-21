# Review staged question candidates

Use Node.js 22 from the repository root. Point the review command at the complete
`candidates.json` produced by the generator outside the checkout. Review reads
the staged batch directly and leaves it available for subsequent review.

```powershell
$candidate = 'C:\path\to\interview-gym-candidate-staging-...\candidates.json'
node scripts/review-question-candidates.mjs $candidate --dry-run
```

A dry run checks the staged format, recomputes the generation plan against the
current bank and checks candidate schema, fingerprints, IDs and source URLs. It
skips network requests and report creation. A valid candidate is reported as
`needs_review (dry_run)`.

Use PowerShell 7 and a key for a Groq **Free Plan** account. The flag records your confirmation of
the account tier because the chat API offers no per-request Free Plan selector.
The supported review models are `openai/gpt-oss-20b` (default) and
`openai/gpt-oss-120b`. [Groq Free Plan rate limits](https://console.groq.com/docs/rate-limits)

```powershell
$env:QUESTION_REVIEW_PROVIDER = 'groq'
$env:GROQ_REVIEW_MODEL = 'openai/gpt-oss-20b'
$env:GROQ_REVIEW_FREE_PLAN = '1'
$env:QUESTION_REVIEW_CODE_POLICY = 'hold-unverified'
$env:GROQ_API_KEY = Read-Host 'Groq Free Plan API key' -MaskInput
try {
    node scripts/review-question-candidates.mjs $candidate
} finally {
    Remove-Item Env:GROQ_API_KEY
}
```

- A complete run atomically stages `review.json` in a fresh sibling directory
  outside the checkout. The report preserves each original candidate, its
  generation metadata, the review model, gate results, findings and decision.
  The command exits with status 1 if any candidate is held or rejected. Keep
  approved reports for later review and reuse.
- Groq uses strict Structured Outputs for both review models. The CLI prints
  per-attempt diagnostics to stderr and saves them in each report entry. These
  include requested and recognized reported models, HTTP status, finish reason,
  token usage when supplied, failure category, and validation field and rule
  when available. `missing_review_field` identifies an omitted required field,
  while `invalid_review` identifies a bad shape or value. `invalid_json` includes
  a rule identifying the response envelope or completion content. Diagnostics
  omit raw responses, candidate text, and credentials.
- Approval requires a distinct, confirmed review model, an independently
  selected matching answer, all positive findings and a supported quote for each
  source. Documentation checks use bounded HTTPS reads from allowlisted
  documentation hosts, public IPv4 address pinning and at most two redirects
  within the original allowlisted origin and documentation paths. Groq
  judges the relevance of the retrieved passages. The semantic duplicate check
  covers the batch, related bank prompts and bounded cross-category context.
- Each source's `documentationDiagnostics` records its HTTP status (when
  available), retrieval outcome, passage count, supplied passage count and
  failure category. A DNS or network error, deadline, HTTP error, blocked
  redirect, unsupported content type or encoding, or response over 512 KiB can
  make documentation unavailable. A page that loads but yields no usable
  passages produces `insufficient_evidence`. Extraction includes lists,
  tables and other article text, and skips navigation and hidden content.
- The reviewer distinguishes insufficient evidence from passages unrelated to
  the question (`documentation_irrelevant`). An `unsupported_citation`
  identifies a quote or source that failed validation. A quote must match a
  contiguous span of one supplied passage exactly. If citation validation
  fails, the report retains validated findings with an empty citations array.
- The CLI treats every snippet as potentially executable and holds it when
  execution is unverified. The JavaScript API accepts an `isolatedVerifier`
  adapter for C#; the caller must supply a trusted, resource-limited sandbox.
  Approval requires successful compile and run results. This release ships
  without a sandbox runner.
- Each candidate uses at most three Groq attempts, with at most two extra
  attempts across the batch. Authentication failure or an exhausted rate-limit
  retry stops further Groq calls. CI supplies mocked responses and documents.

## Offline documentation diagnostics

Run the extractor against a saved HTML page or a local fixture. The command
prints only diagnostic metadata, uses the same 512 KiB limit, and exits with
status 1 when it extracts no passages. HTTP status is null for a local file.

```powershell
node scripts/review-documentation.mjs --offline 'C:\path\to\saved-learn-page.html'
```
