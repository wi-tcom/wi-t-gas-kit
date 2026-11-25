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
| `WitGas.resume` | Split work before the 6-minute limit and continue | Planned |
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

The scope of the lock when used through a library (per calling project or shared) will be documented after checking on GAS ([docs/manual-check.md](docs/manual-check.md), item L8).
To be sure the caller's own lock is used, pass `LockService.getScriptLock()` as `opts.lock`.

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

## Permissions (oauthScopes)

`oauthScopes` in `appsscript.json` is set explicitly and kept minimal. Each new part adds its reason here.

| Scope | Part | Reason |
|-------|------|--------|
| (none) | `WitGas.lock` | Uses only `LockService` and `console`; expected to need no extra scope (verified by L1) |

## How to stop

`WitGas.lock` creates no triggers and stores no data. To stop a job, delete the trigger of the function that calls it (Triggers page).

## Development

```bash
npm test
```

- Tests use Node's built-in `node:test` (Node 22+, no packages).
- `test/mocks/` contains fakes of GAS services and a fake clock; `test/helpers/gas-env.js` loads `src/` into one shared global scope, as GAS does.
- GitHub Actions (`.github/workflows/test.yml`) runs the same tests.
- On-GAS verification steps and results: [docs/manual-check.md](docs/manual-check.md) (Japanese).

© 2026 wi-t.com Inc.
