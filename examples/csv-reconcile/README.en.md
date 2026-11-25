# Example: CSV reconciliation

[日本語](README.md)

Matches the "会計" (books) sheet against an imported CSV (e.g. bank deposits) **by invoice number**,
and writes matched / mismatched / one-side-only rows to a "照合結果" (result) sheet. Run it from the spreadsheet menu.

- Matching uses `WitGas.reconcile`; the run is wrapped with `WitGas.guard`.
- Each run adds one row (counts only) to the "実行記録" (run log) sheet, and failures are mailed.
- All data is fictional. Sheet names, menus and messages are in Japanese.

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
   - from the repository's `src/`: `lock.js`, `runlog.js`, `notify.js`, `guard.js`, `reconcile.js` (as listed in `parts.json`)
   - from this example: `main.js`
3. In Project Settings, show the `appsscript.json` manifest and replace it with this example's.
4. Set `CSV_RECONCILE.notifyTo` in `main.js` to the address that should receive failure mails.
5. Reopen the spreadsheet; a "照合" (reconcile) menu appears.

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

## Settings (`CSV_RECONCILE` in `main.js`)

| Name | Sample value | Description |
|------|--------------|-------------|
| `name` | `CSV照合` | Job name in the run log and mails |
| `leftSheet` / `rightSheet` | `会計` / `CSV貼り付け` | The two sheets to match |
| `reportSheet` / `logSheet` | `照合結果` / `実行記録` | Output sheets |
| `labels` | `{ left: '会計', right: '銀行' }` | Names used in the result |
| `compare` | see `main.js` | Options passed to `WitGas.reconcile.compare` |
| `notifyTo` | `ops@example.com` | Failure mail recipient. **Change it.** |

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

## How to stop

- No triggers and no script properties are created; it runs only from the menu.
- Delete `onOpen` from `main.js` to remove the menu.
- The result and run-log sheets may be deleted (they are recreated on the next run).

## Reading the CSV from Drive or Gmail

This example imports into a sheet to avoid extra scopes. To read from Drive or a mail attachment, replace `right` in `runCsvReconcile`;
see the Japanese README for code. **Neither has been checked on GAS.** Expected extra scopes: `drive.readonly` for Drive (read access to all files),
and `https://mail.google.com/` for `GmailApp` (full mail access even for reading) — explain this to the client.

© 2026 wi-t.com Inc.
