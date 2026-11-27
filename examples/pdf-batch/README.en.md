# Example: batch PDF documents (pdf-batch)

[日本語](README.md)

Turns each row of the "明細" (line items) sheet into one "お見積書" (quotation) PDF and puts them in a Drive folder the script creates. Run it from the spreadsheet menu. Sheet names, menus and messages are in Japanese.

- Version: `1.0.0` (`PDF_BATCH_VERSION` in `main.js`; changes in [CHANGELOG.md](CHANGELOG.md))
- Parts: `version.js`, `lock.js`, `resume.js`, `runlog.js`, `notify.js`, `guard.js`, `handover.js`, `settings.js`, `migrate.js` (`parts.json`)
- All data is fictional. The document is styled as a quotation and does not call itself an invoice (tax requirements are out of scope).

## Stage of this example

| Stage | What this example does |
|-------|------------------------|
| 1. Works | "PDF を作る" builds PDFs from the rows; no concurrent runs, run log, failure mail (`WitGas.guard`) |
| 2. Can be left alone | Splits large batches and continues (`WitGas.resume`). **Scheduled runs and checking the PDF count against the rows are not included yet** |
| 3. Can be changed | Title, issuer, column names, folder name, budget and recipient live in the "設定" (settings) sheet; handover document and upgrade steps exist |

### What the next stages can add

- Scheduled runs (e.g. nightly; functions to install and remove the time-driven trigger).
- Checking the created PDFs against the rows (`WitGas.reconcile` on the quotation numbers of the rows and of the record sheet).
- Connecting to the next steps: mailing each PDF, keeping a sent log.
- Several items per document (grouping rows by quotation number).

## Installation

### Paste into the script editor

1. In the spreadsheet, open Extensions → Apps Script.
2. Create files with the same names and paste: the 9 parts listed in `parts.json` from the repository's `src/`, and `main.js` from this example.
3. Under Services (+), add the **Drive API** (identifier `Drive`, version `v3`).
4. Show the `appsscript.json` manifest in Project Settings and replace it with this example's.
5. Reopen the spreadsheet; a "帳票" menu appears. Run "帳票 → 設定と表を用意する" (prepare settings and sheets).
6. Set "失敗の通知先" (failure recipient) in the settings sheet.

### Push with clasp

```bash
cd examples/pdf-batch
echo '{"scriptId":"(ID of the script bound to the spreadsheet)"}' > .clasp.json
cd ../..
npm run example:build -- pdf-batch
cd dist/pdf-batch
npx @google/clasp push
```

The manifest already enables the Drive API (v3), so no editor step is needed with clasp.

## Usage

- **Try it**: "見本のデータを入れる" (30 fictional rows), then "PDF を作る". Sample data is not inserted if the rows or record sheet already have data.
- **Real use**: fill "明細" and run "PDF を作る". Numbers already in "作成記録" (record sheet) are skipped.
- **Rebuild one**: delete its row in the record sheet and trash its PDF, then run again. If the PDF still exists, it is not recreated (never overwritten); only the record row comes back.
- **Stop midway**: "作成を途中でやめる" removes the continuation trigger and progress; created PDFs and records stay.
- **Check**: "点検する" checks the schema version, settings and headers, and lists what to fix (fixes nothing).

## Permissions

| Scope | Reason |
|-------|--------|
| `https://www.googleapis.com/auth/spreadsheets.currentonly` | Read/write this spreadsheet's settings, rows, record and run log |
| `https://www.googleapis.com/auth/drive.file` | Create the folder and PDFs; touches only files and folders this script created |
| `https://www.googleapis.com/auth/script.scriptapp` | Create/delete continuation triggers; list triggers in the handover |
| `https://www.googleapis.com/auth/script.send_mail` | Mail failures |
| `https://www.googleapis.com/auth/script.container.ui` | Show the menu and messages |

- Files are saved with the **Drive API (advanced service v3)**, not `DriveApp`. The on-GAS check P0 (2026-11-27) showed that `DriveApp` cannot even create a folder with `drive.file` (it asks for `drive`), while the Drive API creates folders and PDFs and finds them by name with `drive.file` only.
- PDFs are built from HTML (`Utilities.newBlob(html, 'text/html').getAs('application/pdf')`); no Docs scope and no external requests.

## Limitations

- **A folder the client created by hand cannot be the output folder**: with `drive.file` the script only sees what it created.
- One item per document (one row = one PDF).
- The layout is a simple HTML/CSS one; no breakage was found in P0. Edit the HTML in `pdfBatchRender_` in `main.js` for a company layout.

## Timing

- In P0 (2026-11-27), building and saving one short PDF took 1.3–1.9 s (5 documents). The time for this example's 30 rows will be added after check A2.
- When a run nears the budget it pauses; the continuation runs about a minute later (65–94 s on GAS).

## Business data

- The record sheet holds quotation numbers and file names; the PDFs hold recipients, items and amounts. Mind the sharing of the spreadsheet and folder.
- The run log and mails contain counts and error types only.

## Upgrading

1. **Before**: make a copy of the spreadsheet (File → Make a copy); the bound script is copied with it.
2. **Replace**: paste the new `main.js`, the parts in `parts.json` and the new `appsscript.json` (or `npm run example:build -- pdf-batch` and `clasp push`).
3. **Run**: "帳票 → 設定と表を用意する". Only migration steps not yet run will run; settings values are kept. Running it again changes nothing.
4. **Check**: "点検する", then "引き継ぎ書を作る" to confirm the new version.
5. **Roll back**: use the copy from step 1; delete any continuation trigger left in the original.

`CHANGELOG.md` records what changed in each version and whether it adds migration steps.

## How to stop

- If a batch is in progress, run "作成を途中でやめる" and make sure no `runPdfBatch` trigger is left.
- Delete `onOpen` from `main.js` to remove the menu (or merge it into your existing `onOpen`).
- Created PDFs stay in the Drive folder; delete the folder if not needed.

© 2026 wi-t.com Inc.
