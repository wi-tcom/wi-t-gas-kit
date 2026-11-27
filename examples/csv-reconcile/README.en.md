# Example: CSV reconciliation

[日本語](README.md)

Matches the "会計" (books) sheet against an imported CSV (e.g. bank deposits) **by invoice number**,
and writes matched / mismatched / one-side-only rows to a "照合結果" (result) sheet. Run it from the spreadsheet menu.

- Version: `1.0.0` (`CSV_RECONCILE_VERSION` in `main.js`; changes in [CHANGELOG.md](CHANGELOG.md))
- Parts: `version.js`, `lock.js`, `runlog.js`, `notify.js`, `guard.js`, `reconcile.js`, `handover.js`, `settings.js`, `migrate.js` (`parts.json`)
- Matching uses `WitGas.reconcile`; the run is wrapped with `WitGas.guard`.
- Each run adds one row (counts only) to the "実行記録" (run log) sheet, and failures are mailed.
- All data is fictional. Sheet names, menus and messages are in Japanese.

## Stage of this example

| Stage | What this example does |
|-------|------------------------|
| 1. Works | "照合する" matches the sheets; no concurrent runs, run log, failure mail (`WitGas.guard`) |
| 2. Can be left alone | The matching itself is the check against source data. **It does not run on a schedule** (importing the CSV into the sheet is a manual step) |
| 3. Can be changed | Sheet names, labels, key, compared columns, column map and recipient live in the "設定" (settings) sheet; handover document and upgrade steps exist |

### What the next stages can add

- Scheduled matching (read the CSV from Drive or a mail attachment, see below, and run on a time-driven trigger).
- Mailing the person in charge with counts only when there are mismatches.
- Keeping a daily ledger of results to see changes since the last run.
- A guide for checking mismatches and an inquiry template.

## Sheets

| Sheet | Content | Written by |
|-------|---------|------------|
| 会計 (books) | Your table (header row: 請求番号 invoice no., 金額 amount, 入金日 paid on, ...) | client |
| CSV貼り付け (CSV paste) | The imported CSV (header row: 請求番号, 入金額 deposit, 入金日, ...) | client (import) |
| 照合結果 (result) | Counts per category and details | this script (rewritten each run) |
| 実行記録 (run log) | One row per run | this script |

## Installation

### Paste into the script editor

1. In the spreadsheet, open Extensions → Apps Script.
2. Create these files with the same names and paste their contents (`.gs` is fine):
   - from the repository's `src/`: the 9 files listed in `parts.json`
   - from this example: `main.js`
3. In Project Settings, show the `appsscript.json` manifest and replace it with this example's.
4. Reopen the spreadsheet; a "照合" (reconcile) menu appears. Run "照合 → 設定と表を用意する" (prepare settings).
5. Set "失敗の通知先" (failure recipient) in the settings sheet. "照合 → 点検する" (check) warns if it is still the sample address.

### Push with clasp

```bash
cd examples/csv-reconcile
echo '{"scriptId":"(ID of the script bound to the spreadsheet)"}' > .clasp.json
cd ../..
npm run example:build -- csv-reconcile
cd dist/csv-reconcile
npx @google/clasp push
```

`npm run example:build` gathers this example's `appsscript.json` and `main.js` plus the parts listed in `parts.json` into `dist/csv-reconcile/`.
`.clasp.json` is not committed.

## Usage

### Try it with sample data

Menu "照合 → 見本のデータを入れる" (insert sample data), then "照合 → 照合する" (reconcile).
Sample data is not inserted if either sheet already has data.

The result is (checked by `test/examples/csv-reconcile.test.js`):

```
一致 2 / 不一致 2 / 会計だけ 1 / 銀行だけ 1 / キー重複 0 / キーなし 0
```

### Import a real CSV

1. Select the "CSV貼り付け" sheet.
2. File → Import → Upload, and choose the CSV.
3. Import location: **Replace current sheet**.
4. **Turn off "Convert text to numbers, dates, and formulas"**,
   otherwise leading zeros (`001`) are lost and values starting with `=` become formulas.
   Amounts (`"1,000"`) and dates (`2026/1/5`) are normalized when matching even as text.
5. Menu "照合 → 照合する".

If characters are garbled, re-save the CSV as UTF-8 and import again.

## Settings ("設定" sheet)

| Item | Default | Description |
|------|---------|-------------|
| 会計のシート / CSV のシート | 会計 / CSV貼り付け | The two sheets to match |
| 照合結果のシート / 実行記録のシート | 照合結果 / 実行記録 | Output sheets |
| 呼び名（会計） / 呼び名（CSV） | 会計 / 銀行 | Labels used in the result |
| キーの列 | 請求番号 | Key column (books header); comma-separated for several |
| 比べる列 | 金額, 入金日 | Compared columns (books headers), comma-separated |
| 列の対応 | 金額=入金額 | Only columns whose names differ: "books=CSV", comma-separated |
| 数の列 / 日付の列 | 金額 / 入金日 | Columns compared as numbers / dates |
| 全角と半角を区別しない | はい (yes) | Ignore full-width/half-width differences |
| 失敗の通知先 | ops@example.com | Failure mail recipient. **Change it.** |

Invalid values show a message naming the item, and nothing runs. The settings sheet survives code replacement.

## Permissions

| Scope | Reason |
|-------|--------|
| `https://www.googleapis.com/auth/spreadsheets.currentonly` | Read and write only this spreadsheet |
| `https://www.googleapis.com/auth/script.container.ui` | Show the menu and the "missing input" message |
| `https://www.googleapis.com/auth/script.send_mail` | Mail failures |

No triggers are created, so `script.scriptapp` is not used.
Whether `spreadsheets.currentonly` suffices has not been checked on GAS yet (`docs/manual-check.md`, E1); if not, use `spreadsheets`.

## Business data

- The result sheet contains invoice numbers, amounts and dates by nature. Mind the spreadsheet's sharing settings.
- The run log and mails contain only counts and error types. See Apps Script's Executions page for error details.

## If you already have `onOpen`

Move the menu code from this example's `onOpen` into your existing `onOpen`; two `onOpen` functions overwrite each other.

## On failure

| What happened | Screen | Run log | Mail |
|---------------|--------|---------|------|
| "会計" or "CSV貼り付け" is empty | A message asking to fill both sheets | not logged | not sent |
| A column used for matching is missing from a header (wrong CSV format) | Which sheet lacks which column (in Japanese) | failure (`CsvFormatError`) | sent |
| Any other failure | Apps Script's error display | failure (error type) | sent |

Other failures also show as failed in Apps Script's Executions page, where the error details can be read.

## Run-log time zone

A newly created spreadsheet may store Pacific time even though its settings show Tokyo (see `WitGas.runlog` in the top README).
This example aligns the spreadsheet's time zone to the script's (Asia/Tokyo) only when it first creates the run-log sheet (`matchTimeZone: true`).

In the on-GAS check (2026-11-26), attaching the script via Extensions → Apps Script had already changed the time zone to `Asia/Tokyo`, so `matchTimeZone` did not need to act; it stays on as a safeguard.

## How to stop

- No triggers are created; it runs only from the menu. The only script property is the schema version (`WitGas.schema:csvReconcile`).
- The handover document does not list triggers (no `script.scriptapp` scope, since no triggers are used).
- Delete `onOpen` from `main.js` to remove the menu.
- The result and run-log sheets may be deleted (they are recreated on the next run).

## Upgrading

1. **Before**: make a copy of the spreadsheet (File → Make a copy).
2. **Replace**: paste the new `main.js`, the parts in `parts.json` and the new `appsscript.json` (or build and `clasp push`).
3. **Run**: "照合 → 設定と表を用意する". Only pending migration steps run; settings values are kept.
4. **Check**: "点検する", then "引き継ぎ書を作る" to confirm the version.
5. **Roll back**: use the copy from step 1.

### From the first form (no version number) to 1.0.0

The first form kept settings in `CSV_RECONCILE` in `main.js`; 1.0.0 moves them to the settings sheet.
Before replacing the code, note the values of `CSV_RECONCILE` (especially `notifyTo`), follow steps 1–3, then enter the values in the settings sheet and run "点検する" (it warns if the recipient is still the sample address). The existing sheets are used as they are.

## Reading the CSV from Drive or Gmail

This example imports into a sheet to avoid extra scopes. To read from Drive or a mail attachment, replace `right` in `runCsvReconcile`;
see the Japanese README for code. **Neither has been checked on GAS.** Expected extra scopes: `drive.readonly` for Drive (read access to all files),
and `https://mail.google.com/` for `GmailApp` (full mail access even for reading) — explain this to the client.

© 2026 wi-t.com Inc.
