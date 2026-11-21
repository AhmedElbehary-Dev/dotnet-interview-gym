# Manual question import

## Prepare the JSON

Save trusted question content as UTF-8 JSON. Use an array of questions or an object with a `questions` array. Each question needs a prompt (`q`), four non-empty `options`, a zero-based `answer` from `0` to `3`, a `why` explanation, and a `hint`. Copy the exact category from `questions/manifest.json`. Use `أساسي`, `متوسط`, or `متقدم` for `difficulty` and `مفهوم`, `فهم الكود`, or `حل مشكلة` for `skill`.

```json
{
  "questions": [
    {
      "category": "أساسيات C#",
      "difficulty": "متوسط",
      "skill": "مفهوم",
      "q": "When does StringComparer.OrdinalIgnoreCase consider two strings equal?",
      "options": [
        "When ordinal comparison finds them equal ignoring case",
        "When they match under the current culture's sort rules",
        "When they match after trimming whitespace",
        "When they contain the same number of characters"
      ],
      "answer": 0,
      "why": "المقارنة ترتيبية وتتجاهل حالة الأحرف، والمسافات تظل جزءًا من النص.",
      "hint": "فكّر في قاعدة المقارنة وتأثير إعدادات اللغة."
    }
  ]
}
```

For a code question, include a `code` object with string fields `lang`, `prompt`, and `code`. An optional `conceptId` must already exist in `questions/topic-taxonomy.json`. The importer assigns IDs from the question fingerprints and sets `publishedOn` to the current Africa/Cairo date at apply time. Omit `id`, `fingerprint`, and `publishedOn` from the input.

## Preview and apply

Run from the repository root with Node.js 22. Start with a clean working tree so the import is easy to review and undo. Keep your source JSON local.

```powershell
node scripts/import-questions.mjs .\imports\weekly.json
node scripts/import-questions.mjs .\imports\weekly.json --apply
```

Preview reports how many questions would be added without writing to the bank. Apply updates the affected shards, manifest, index, and coverage report. An invalid row rejects the entire batch. Fix the reported rows and preview again.

The importer checks fingerprints against every published question and earlier accepted rows in the input. The bank keeps its existing records and the first valid occurrence in the batch wins. Prompt case and runs of whitespace are normalized. For code questions, the fingerprint also includes the code prompt, language, and snippet, with the snippet's case and whitespace preserved apart from line endings. Different wording can be accepted even when it tests the same concept. A repeat import of the same file adds zero questions.

## Commit and publish

Inspect and validate the result, then commit only the generated bank files. Review the branch on GitHub and publish through your usual pull request process.

```powershell
git diff -- questions reports/coverage-report.json
node scripts/validate-questions.mjs
node scripts/build-question-index.mjs --check
node scripts/analyze-coverage.mjs --check
node scripts/smoke-test.mjs
git add -- questions reports/coverage-report.json
git commit -m "Import weekly interview questions"
git push -u origin HEAD
```

GitHub Pages serves `main` from the repository root. After the import reaches `main` and Pages finishes publishing, questions appear in the main practice bank and in **الأسئلة الجديدة** for today or the latest earlier publication date. Each group shows up to five previews. Its practice button can draw from the entire group.

## Undo an import

Before committing, if the import is the only change to the bank and report, restore those paths from `HEAD`.

```powershell
git restore --source=HEAD --staged --worktree -- questions reports/coverage-report.json
```

After committing, run `git revert <import-commit-sha>` on a branch based on the branch that contains the import. Push and review the revert as you would an import. Once the revert reaches `main`, Pages publishes the restored bank. The local source JSON is unaffected in either case.
