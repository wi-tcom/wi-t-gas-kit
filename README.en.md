# wi-t-gas-kit

[日本語](README.md)

Building blocks for delivering Google Apps Script (GAS) projects that clients can keep running with confidence.
Rather than scaffolding or feature snippets, this kit focuses on operational parts: **don't stop, notice failures, verify results, hand over cleanly**.

- Plain JavaScript (GAS V8 runtime). No external dependencies in the library itself.
- Usable as a GAS library or by copying the files.

## Status

| Part | Purpose | Status |
|------|---------|--------|
| `WitGas.lock` | Prevent concurrent runs | Implemented (Node tests only; not yet verified on GAS) |
| `WitGas.resume` | Split work before the 6-minute limit and continue | Implemented (Node tests only; not yet verified on GAS) |
| `WitGas.runlog` / `WitGas.notify` | Run log and failure notification | Implemented (Node tests only; not yet verified on GAS) |
| `WitGas.guard` | One-line wrapper combining the above | Implemented (Node tests only; not yet verified on GAS) |
| `WitGas.reconcile` | Match two tables by key | Implemented (Node tests only; not yet verified on GAS) |

## Installation

### Copy the files

Paste the `.js` files from `src/` into the client's script project (`.gs` extension is fine).
The only global name added is `WitGas`. File order does not matter.

### Push with clasp

```bash
cp .clasp.json.example .clasp.json   # set scriptId to the client's script ID
npx @google/clasp push
```

`.claspignore` limits the push to `appsscript.json` and `src/`.

### Use as a GAS library

Add the library with an identifier such as `WitGasLib`, then:

```js
var WitGas = WitGasLib.WitGas;
```

Which project the lock, script properties and triggers belong to when used through a library will be documented after checking on GAS ([docs/manual-check.md](docs/manual-check.md), items L8 and R7).
To be sure the caller's own ones are used, pass them from the caller:

```js
WitGas.lock.run('summary', fn, { lock: LockService.getScriptLock() });
WitGas.resume.run({ /* ... */ properties: PropertiesService.getScriptProperties(), scriptApp: ScriptApp });
```

## WitGas.guard — the entry point (start here)

Wraps lock (no concurrent runs) → run → runlog (run log) → notify on failure in one line.
Samples and deliverables are wrapped with this by default.

```js
// Keep the settings in one place (where a successor will look)
var GUARD = {
  log:    { spreadsheetId: '1AbC... (ID of the spreadsheet holding the log)' },
  notify: { to: 'ops@example.com' }
};

function dailySummary() {   // called from a time-driven trigger
  WitGas.guard('daily-summary', function (ctx) {
    var n = summarize_();    // your work here
    ctx.setCount(n);         // shown in the "count" column
  }, GUARD);
}
```

| What happened | Run log | Notification | `status` |
|---------------|---------|--------------|----------|
| Finished | success (成功) | none | `success` |
| `resume` paused | continued (続きあり) | none | `continued` |
| Previous run still running | skipped (スキップ) | none | `skipped` |
| Failed | failure (失敗) with error type | yes (at most about one per hour) | — (rethrown) |

### With resume

If `fn` returns the result of `WitGas.resume.run`, paused runs are logged as "continued" and the last one as "success",
with the count of items processed in that run and a message such as `cursor 4, runs 1`.

```js
function makeInvoices() {   // called by the daily trigger and by the continuation trigger
  return WitGas.guard('invoice-pdf', function () {
    var rows = loadRows_();
    return WitGas.resume.run({
      key: 'invoicePdf',
      total: rows.length,
      handler: 'makeInvoices',
      step: function (i) { /* one row at a time (see "Make items safe to process twice") */ }
    });
  }, GUARD);
}
```

### opts

| Name | Default | Description |
|------|---------|-------------|
| `log` | (required) | Run-log settings (`WitGas.runlog.append` opts), or `false`. |
| `notify` | (required) | Notification settings (`WitGas.notify.failure` opts), or `false`. |
| `waitMs` | `0` | Maximum milliseconds to wait for the lock. |
| `lock` | script lock | Lock to use (`opts.lock` of `WitGas.lock.run`). |
| `rethrow` | `true` | Rethrow the error after logging and notifying. If `false`, return `{status:'failure', errorType}` instead. |

`log` and `notify` are required so they are not forgotten; write `false` to turn one off.

### ctx (argument of fn)

- `ctx.setCount(n)` sets the count; `ctx.addCount(n)` adds to it (`n` defaults to 1).
- `ctx.setMessage(s)` sets the log message (up to 100 characters). No personal or business data.
- On failure, the count so far is still logged and mailed.

### Rules

- **Settings are checked on every call, before running.** A mistyped address fails on the first run, not on the first failure (nothing is logged or mailed in that case).
- On failure: log → notify → rethrow. Because it is rethrown, the execution shows as failed in Apps Script's Executions page, where the error message can be read.
  The run log and the mail contain only the error type.
- If the run log cannot be written, the job result is unchanged and a notification with error type `runlog:<type>` is sent.
- If the notification cannot be sent, it is logged and the original error is still rethrown.
- The mail includes the run-log URL built from `log.spreadsheetId` (or `log.spreadsheet`), unless `notify.linkUrl` is given.
- When copying `guard.js`, also copy `lock.js` (and `runlog.js` / `notify.js` if you use logging / notification).

## WitGas.lock — prevent concurrent runs

Runs the function only when the script lock (`LockService.getScriptLock()`) is acquired, and always releases it afterwards, even on failure.
If the lock cannot be acquired, the function is not run and a "skipped" result is returned.

```js
function dailyJob() {   // called from a time-driven trigger
  var res = WitGas.lock.run('daily-summary', function () {
    // your work here
    return 120;          // available as res.value
  });
  if (res.skipped) return; // the previous run is still in progress
}
```

### Return value

| Case | Result |
|------|--------|
| Ran | `{ skipped: false, value: <return value of fn> }` |
| Skipped (lock not acquired) | `{ skipped: true, reason: 'locked', name: <name> }` |
| `fn` threw | The lock is released, then the same error is rethrown |

### Options

| Name | Default | Description |
|------|---------|-------------|
| `waitMs` | `0` | Maximum milliseconds to wait for the lock. 0 skips immediately. |
| `onSkip` | none | Called on skip with `{name, result:'skipped', reason:'locked', startedAt, endedAt}`. Hook for the run-log sheet (`WitGas.runlog`); `WitGas.guard` uses it to log skips. |
| `lock` | `LockService.getScriptLock()` | The lock to use; any object with `tryLock(ms)` and `releaseLock()`. |

### Rules

- On skip, `[WitGas.lock] skipped: <name> (locked)` is written with `console.log`.
- Logs contain only the name and the error type. **Do not put personal or business data in the name.**
- `fn` must be synchronous. Returning a `Promise` is an error because the lock would be released first.
- If `fn` succeeds but releasing the lock fails, the release error is thrown (a stuck lock would make every later run skip, so it is not treated as success).
- If both `fn` and the release fail, the `fn` error is thrown and the release failure is logged.

## WitGas.resume — continue across executions

Stops before a time budget (default 4.5 minutes) is exceeded, saves the progress (cursor) in script properties,
and continues with a one-time trigger 1 minute later. When finished, the cursor and the trigger are deleted.

```js
function makeInvoices() {   // called by the daily trigger and by the continuation trigger
  WitGas.lock.run('invoice-pdf', function () {
    var sheet = SpreadsheetApp.getActive().getSheetByName('Invoices');
    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
    return WitGas.resume.run({
      key: 'invoicePdf',
      total: rows.length,
      handler: 'makeInvoices',              // function the continuation trigger calls (this one)
      step: function (i) {
        if (rows[i][4] === 'done') return;   // skip rows already done
        createPdf_(rows[i]);                 // do not recreate if a file with the same name exists
        sheet.getRange(i + 2, 5).setValue('done');
      }
    });
  });
}
```

`resume` does not prevent concurrent runs by itself. Call it inside `WitGas.lock.run` as above, or wrap it with `WitGas.guard` (which adds logging and notification).

### Options

| Name | Default | Description |
|------|---------|-------------|
| `key` | (required) | Job name. Saved as script property `WitGas.resume:<key>`. |
| `total` | — | Number of items; the cursor goes from 0 to `total - 1`. Use either this or `hasNext`. |
| `hasNext` | — | `function(cursor)` returning `true` if the item exists. For when the count is not known up front. |
| `step` | (required) | `function(cursor)` that processes one item. Return nothing to continue at `cursor + 1`, or an integer greater than `cursor` to continue there (batches). Must be synchronous. |
| `handler` | (required) | Function name the continuation trigger calls; a top-level function, usually the one calling `run`. |
| `budgetMs` | `270000` (4.5 min) | Time budget per execution, 1–360000. |
| `properties` / `scriptApp` | `PropertiesService.getScriptProperties()` / `ScriptApp` | Pass only to override. |

### Return value

`{ done, cursor, processed, runs, scheduled, elapsedMs }`

- `done`: `true` when everything is processed; `false` when it will continue ("continues" in the run log).
- `cursor`: next position. `processed`: items processed in this execution. `runs`: execution count.
- `scheduled`: `true` if a continuation trigger was created.

### How it splits

- It moves on to the next item only if that item would still fit in the budget even if it took as long as the longest item so far in this execution.
- Time is counted from the call to `run`. If you do slow setup before it, lower `budgetMs` accordingly.
- At least one item is processed per execution, so a job never keeps rescheduling without progress.
  Still, split `step` if a single item could exceed the 6-minute limit.

### On failure

- If `step` throws, the **cursor of the failed item** is saved, no continuation trigger is created, and the error is rethrown (so the same failure does not repeat every minute).
- The next call to `run` (daily trigger or manual) retries from that item.
- If the saved state is unreadable, it throws instead of starting over (to avoid reprocessing). `WitGas.resume.cleanup(key)` resets it.
- If a trigger cannot be created (e.g. the 20-trigger limit per project), the cursor is saved before the error is thrown.

### Make items safe to process twice

The cursor is saved only when pausing and on failure, so items are processed again in these cases:

- the failed item (to retry it)
- if the execution is killed (e.g. the 6-minute limit is exceeded): every item processed in that execution

Write each item so processing it twice gives the same result:

1. **Done markers**: write a marker per item and skip marked items.
2. **Overwrite**: write to a fixed cell with `setValue` instead of `appendRow`.
3. **Fixed names**: create files with fixed names; skip (or overwrite) if they exist.
4. **Irreversible actions (e.g. sending mail)**: mark "sending" before and "done" after. Items left at "sending" are checked by a person, not resent automatically.
5. Do not delete or reorder rows while a job is in progress (the cursor is a position). Use IDs for done markers if needed.

### When the lock collides

There is one script lock per project. If a continuation run collides with another job and `lock.run` skips, that run does nothing.
The cursor is kept, so the next call to `run` (daily trigger or manual) continues from it.
To continue right away, set `waitMs` on `lock.run` (the wait counts toward the 6 minutes).

### What is stored

Script property `WitGas.resume:<key>` holds this JSON. It contains no business data.

```json
{"v":1,"cursor":4,"runs":1,"firstStartedAt":1767571200000,"triggerId":"1234567890"}
```

### Other functions

- `WitGas.resume.get(key)`: saved progress `{cursor, runs, firstStartedAt, scheduled}`, or `null`.
- `WitGas.resume.cleanup(key)`: deletes the continuation trigger and the saved state — to stop midway or start over. Triggers you created yourself are never deleted, even with the same function name.

## WitGas.runlog — run log

Appends one row per execution to a "実行記録" (run log) sheet in the given spreadsheet, creating the sheet if needed.

```js
var LOG = { spreadsheetId: '1AbC... (ID of the spreadsheet holding the log)' };

WitGas.runlog.append({
  name: 'daily-summary',
  result: 'success',          // 'success' | 'failure' | 'skipped' | 'continued'
  startedAt: startedAt,
  count: 120
}, LOG);
```

Columns (headers are in Japanese): start (開始), end (終了), name (処理名), result (結果), count (件数), error type (エラー種別), message (メッセージ).
Results are written as 成功 (success), 失敗 (failure), スキップ (skipped), 続きあり (continued).

### entry

| Name | Description |
|------|-------------|
| `name` | Job name (required), up to 100 characters. |
| `result` | `success`, `failure`, `skipped` or `continued` (required). |
| `startedAt` / `endedAt` | `Date`s. `endedAt` defaults to now; `startedAt` defaults to `endedAt`. |
| `count` | Item count (integer >= 0). |
| `error` | An error. **Only its type (e.g. `TypeError`) is written, never its message** (it may contain business data). |
| `errorType` | To write the type directly. |
| `message` | Short message. Newlines are removed; cut to 100 characters. Do not include personal or business data. |

### opts

| Name | Default | Description |
|------|---------|-------------|
| `spreadsheetId` | — | Spreadsheet ID to write to. |
| `spreadsheet` | — | Spreadsheet object, instead of the ID. |
| (neither) | active spreadsheet | For scripts bound to a spreadsheet; error if none. |
| `sheetName` | `実行記録` | Sheet name. |
| `maxRows` | `5000` | Rows to keep (excluding the header). Oldest rows are deleted beyond this. |

### Rules

- Text starting with `=`, `+`, `-` or `@` is prefixed with `'` so it is not read as a formula.
- An existing sheet's header is not rewritten (keep the column order above).
- Write failures are thrown.

## WitGas.notify — failure notification

Sends a mail with `MailApp` on failure. The same job with the same error type is notified at most once per hour.

```js
WitGas.notify.failure(
  { name: 'invoice-pdf', error: e, count: 3 },
  { to: 'ops@example.com', linkUrl: '(URL of the run-log sheet)' }
);
// → { sent: true }  or  { sent: false, reason: 'throttled' }
```

The mail (in Japanese) contains the job name, error type, time, count and the link. It never contains the error message.

### info and opts

| Name | Default | Description |
|------|---------|-------------|
| `info.name` | (required) | Job name. |
| `info.error` / `info.errorType` | type `Error` | Only the type is used. **The error message is never mailed.** |
| `info.at` | now | When it happened. |
| `info.count` | — | Item count. |
| `opts.to` | (required) | Recipients: comma-separated string or array. |
| `opts.throttleMs` | `3600000` (1 hour) | Suppression window, 1 minute to 6 hours. |
| `opts.subjectPrefix` | `[WitGas]` | Subject prefix, e.g. the client's name. |
| `opts.linkUrl` | — | URL to include in the body (must start with `https://`). |
| `opts.timeZone` | script time zone | Time zone for the displayed time. |

### Rules

- The suppression marker is stored in the script cache of `CacheService` (key: `WitGas.notify:` + a digest of name and type).
- The marker is set only after a successful send; a send failure is thrown and the next failure sends again.
- `CacheService` entries may be evicted early; then another mail can arrive within the hour.
  Two executions failing at the same moment may also send two mails. Think "usually one", not "at most one".
- Newlines in the name and type are removed so the subject stays intact.

## WitGas.reconcile — reconciliation

Matches two tables by key and sorts rows into **matched, mismatched, left only, right only, duplicate key and blank key**.
Every row lands in exactly one category, so the counts add up to the original row counts (otherwise it throws).

```js
function reconcileInvoices() {
  WitGas.guard('invoice-reconcile', function (ctx) {
    var ss = SpreadsheetApp.getActive();
    var books = ss.getSheetByName('Books').getDataRange().getValues();
    var bank  = Utilities.parseCsv(csvText);               // CSV text (how you load it depends on the case)
    var r = WitGas.reconcile.compare(books, bank, {
      key: 'InvoiceNo',
      columnMap: { 'Amount': 'Deposit' },                  // only columns whose names differ
      numberColumns: ['Amount'],
      dateColumns: ['PaidOn']
    });
    WitGas.reconcile.writeReport(r, { spreadsheet: ss, labels: { left: 'Books', right: 'Bank' } });
    ctx.setCount(r.summary.leftRows);
    ctx.setMessage(WitGas.reconcile.summaryText(r));
  }, GUARD);
}
```

### compare(left, right, opts)

Tables are 2D arrays whose first row is the header (the result of a sheet's `getValues()` or `Utilities.parseCsv()` works as is).
Columns are referred to by header name.

| Name | Default | Description |
|------|---------|-------------|
| `key` | (required) | Key column name, or an array for a composite key. |
| `columns` | columns in both tables (except keys) | Columns to compare. |
| `columnMap` | — | Left column name → right column name, only where names differ (keys included). |
| `numberColumns` | — | Compare as numbers. `1,000`, `¥1,000`, `1,000円` and full-width digits become 1000; `△500` / `▲500` (Japanese minus) become -500. Unreadable values are compared as text. |
| `dateColumns` | — | Compare as dates. Sheet dates and `2026/1/5`, `2026-01-05`, `2026年1月5日` become the same day. |
| `trim` | `true` | Ignore leading/trailing spaces (including full-width spaces). |
| `width` | `false` | Ignore full-width/half-width differences (NFKC). |
| `timeZone` | script time zone | Time zone used to turn sheet dates into days. |

**Comparison rules**

- Columns that are not number columns are compared as text: `1000` equals `"1000"` but not `"1,000"`.
- Keys follow the same rules: `"001"` and `1` are different keys (to keep leading zeros in codes). Put the key column in `numberColumns` to treat them as equal.
- In non-date columns, sheet dates are compared including the time.
- Empty, `null` and missing cells (short CSV rows) are all empty. `true` equals `"TRUE"`.
- Rows whose key is duplicated are not matched; all of them (from both tables) go to "duplicate key". Rows with an empty key go to "blank key".
- Rows with every cell empty are skipped (counted in `summary.leftEmptyRows` / `rightEmptyRows`).

**Result**

```js
{
  key: ['InvoiceNo'], columns: ['Customer', 'Amount'],
  matched:    [{ key: ['A001'], leftRow: 2, rightRow: 2 }],
  mismatched: [{ key: ['A002'], leftRow: 3, rightRow: 3,
                 diffs: [{ column: 'Amount', rightColumn: 'Deposit', left: 2500, right: 2400 }] }],
  leftOnly:   [{ key: ['A003'], leftRow: 4 }],
  rightOnly:  [{ key: ['A005'], rightRow: 5 }],
  duplicates: [{ key: ['A009'], leftRows: [8, 9], rightRows: [7] }],
  blankKey:   [{ side: 'left', row: 10 }],
  summary: { matched, mismatched, leftOnly, rightOnly, duplicates, blankKey,
             leftRows, rightRows, leftEmptyRows, rightEmptyRows }
}
```

Row numbers count the header as row 1 (for a sheet's `getDataRange()` starting at A1, they equal sheet row numbers).

### writeReport(result, opts)

Writes the result to a "照合結果" (reconcile result) sheet: counts per category on top, details below (one row per differing column for mismatches). Labels are in Japanese.

| Name | Default | Description |
|------|---------|-------------|
| `spreadsheetId` / `spreadsheet` | active spreadsheet | Where to write. |
| `sheetName` | `照合結果` | Sheet name. |
| `labels` | `{ left: '左', right: '右' }` | Names of the two tables, used in category and column labels. |
| `includeMatched` | `false` | Also list matched rows. |

- The target sheet must be **empty or a previous `writeReport` output (A1 is "照合日時")**. Any other sheet is left untouched and an error is thrown.
- A previous report is cleared before writing.
- Values starting with `=`, `+`, `-` or `@` are prefixed with `'` so they are not read as formulas.

### summaryText(result, labels)

Returns a counts-only line such as `一致 120 / 不一致 3 / 左だけ 1 / 右だけ 0 / キー重複 0 / キーなし 0`, for the run-log message.

### Business data

The report sheet contains keys and values (business data) by nature. Keep it in the client's spreadsheet and mind its sharing settings.
The run log and notifications get only the counts from `summaryText`. Error messages name columns but never contain data values.

## Permissions (oauthScopes)

`oauthScopes` in `appsscript.json` is set explicitly and kept minimal. Each new part adds its reason here.

| Scope | Part | Reason |
|-------|------|--------|
| (no extra) | `WitGas.guard` | Only the scopes of the parts it uses (lock, runlog, notify). With `log: false`, `spreadsheets` is not needed; with `notify: false`, `script.send_mail` is not needed |
| (none) | `WitGas.lock` | Uses only `LockService` and `console`; expected to need no extra scope (verified by L1) |
| `https://www.googleapis.com/auth/script.scriptapp` | `WitGas.resume` | Create and delete continuation triggers (`ScriptApp`). Saving the cursor (`PropertiesService`) is expected to need no extra scope (verified by R8) |
| `https://www.googleapis.com/auth/spreadsheets` | `WitGas.runlog`, `WitGas.reconcile` | Open the spreadsheet by ID and write to it (`SpreadsheetApp.openById`). `reconcile.compare` alone needs no scope (`writeReport` does) |
| `https://www.googleapis.com/auth/script.send_mail` | `WitGas.notify` | Send failure mails (`MailApp`). `CacheService`, `Utilities` and `Session` are expected to need no extra scope (verified by N1) |

You may remove scopes of parts you do not use.
If `runlog` writes only to the spreadsheet the script is bound to (no `spreadsheetId`), `https://www.googleapis.com/auth/spreadsheets.currentonly` is expected to suffice instead of `spreadsheets` (verified by W7).

## How to stop

- `WitGas.lock` creates no triggers and stores no data. Neither does `WitGas.reconcile` (the report sheet may be deleted).
- To stop a `WitGas.resume` job midway, run a function that calls `WitGas.resume.cleanup('<key>')` from the script editor.
  To do it by hand, delete the continuation trigger (one-time trigger for the `handler` function) on the Triggers page,
  and delete `WitGas.resume:<key>` under Project Settings → Script Properties.
  If you delete only the trigger, the next call to `run` continues from the cursor.
- `WitGas.guard` creates no triggers and no script properties (if it wraps `resume`, follow the `resume` steps above).
- `WitGas.runlog` and `WitGas.notify` create no triggers and no script properties.
  To stop logging, remove the call; to change recipients, change `opts.to`. A deleted run-log sheet is recreated on the next write.
- Triggers that call your job on a schedule (e.g. daily) are your own; delete them too to stop completely.

## Development

```bash
npm test
```

- Tests use Node's built-in `node:test` (Node 22+, no packages).
- `test/mocks/` contains fakes of GAS services and a fake clock; `test/helpers/gas-env.js` loads `src/` into one shared global scope, as GAS does.
- GitHub Actions (`.github/workflows/test.yml`) runs the same tests.
- On-GAS verification steps and results: [docs/manual-check.md](docs/manual-check.md) (Japanese).

© 2026 wi-t.com Inc.
