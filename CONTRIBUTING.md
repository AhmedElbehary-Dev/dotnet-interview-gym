# Contributing questions

Thanks for improving the bank. Keep every question original, unambiguous, verified, and tied to a real technical concept.

1. Choose a topic and append a question with a unique permanent ID to the relevant JSON shard; update `questions/manifest.json` counts.
2. Provide four **distinct** English options and exactly one correct zero-based `answer` index (`0..3`).
3. Write a short, non-revealing Arabic hint and a clear Arabic answer explanation in `why`.
4. Prefer examples of **what code prints**, **what query returns**, SQL troubleshooting, API design decisions, security choices, and realistic production trade-offs.
5. Check compile/runtime/SQL results or official documentation. Indicate any assumptions needed to avoid ambiguous answers.
6. Run `node scripts/validate-questions.mjs`, open a Pull Request, and mention supporting references.

We won't accept plagiarized material, company-specific confidential interview questions, duplicated content, unverified answers, or questions whose alternatives are effectively synonyms.

**License:** Original questions contributed here are offered under Creative Commons Attribution 4.0 (CC BY 4.0). Software code uses MIT.
