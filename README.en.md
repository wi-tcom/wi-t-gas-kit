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
| `WitGas.runlog` / `WitGas.notify` | Run log and failure notification | Planned |
| `WitGas.guard` | One-line wrapper combining the above | Planned |

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
| `onSkip` | none | Called on skip with `{name, result:'skipped', reason:'locked', startedAt, endedAt}`. Hook for the run-log sheet (`WitGas.runlog`, planned). |
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

`resume` does not prevent concurrent runs by itself. Call it inside `WitGas.lock.run` as above.

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

## Permissions (oauthScopes)

`oauthScopes` in `appsscript.json` is set explicitly and kept minimal. Each new part adds its reason here.

| Scope | Part | Reason |
|-------|------|--------|
| (none) | `WitGas.lock` | Uses only `LockService` and `console`; expected to need no extra scope (verified by L1) |
| `https://www.googleapis.com/auth/script.scriptapp` | `WitGas.resume` | Create and delete continuation triggers (`ScriptApp`). Saving the cursor (`PropertiesService`) is expected to need no extra scope (verified by R8) |

If you use only `lock`, you may remove `script.scriptapp`.

## How to stop

- `WitGas.lock` creates no triggers and stores no data.
- To stop a `WitGas.resume` job midway, run a function that calls `WitGas.resume.cleanup('<key>')` from the script editor.
  To do it by hand, delete the continuation trigger (one-time trigger for the `handler` function) on the Triggers page,
  and delete `WitGas.resume:<key>` under Project Settings → Script Properties.
  If you delete only the trigger, the next call to `run` continues from the cursor.
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
