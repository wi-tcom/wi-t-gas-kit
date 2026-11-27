# Example: GAS inspection (gas-inspect)

[日本語](README.md)

Inspect a GAS project the client already uses by adding a single file. It looks at triggers, scopes, the 6-minute limit and failure handling, writes the findings to an "点検結果" (inspection result) sheet, and writes versions, triggers, scopes, properties (values hidden) and the sheet structure to an "引き継ぎ書" (handover) sheet. When the inspection is over, remove what you added and restore the project.

- Version: `1.0.0` (`GAS_INSPECT_VERSION` in `main.js`; changes in [CHANGELOG.md](CHANGELOG.md), Japanese)
- Parts: `version.js`, `handover.js` (`parts.json`). The parts are enclosed inside the inspection file; the client's global `WitGas` is never touched.
- File to add: `wit-inspect.js` (one file created in `dist/gas-inspect/` by `npm run example:build -- gas-inspect`)

## Before inspecting: get the client's consent

**Add the inspection file and the extra scopes only after the client has agreed.** You will be changing the client's project. When asking, tell them:

- What is added: one file (`wit-inspect`); if the project lists scopes in `appsscript.json`, up to two scopes (see "Scopes").
- The scopes grow, so an authorization screen appears when it runs.
- What is written: only two sheets, "点検結果" and "引き継ぎ書", in the same spreadsheet. The client's code, triggers, properties and other sheets are not changed.
- What is read: function names and bodies (used for the checks only, never written anywhere), the trigger list, the authorized scopes, time zones, sheet names with row/column counts, and property keys (values are not written).
- Afterwards the file and scopes are removed, and whether that was done is recorded in the last row of the result ("後片付け：元に戻したか" — clean-up: restored?).

## How to inspect

1. **Keep a copy**: in the client's project, turn on "Project Settings → Show 'appsscript.json' manifest file in editor" and copy the whole current `appsscript.json` somewhere (a text editor). Note that you turned the setting on.
2. **Add the file**: "Files → + → Script", name it `wit-inspect`, and paste `dist/gas-inspect/wit-inspect.js`. Do not touch other files.
3. **Add scopes (only if `oauthScopes` exists)**: if `appsscript.json` has `oauthScopes`, add whichever of these two are missing, and note what you added. If there is no `oauthScopes`, add nothing (GAS infers scopes from the code and shows them on the authorization screen).
   - `https://www.googleapis.com/auth/script.scriptapp`
   - `https://www.googleapis.com/auth/spreadsheets.currentonly`
4. **Run**: choose `witInspect` in the editor and click "Run". If the authorization screen appears, review it with the client before allowing.
   - Only the triggers created by the person running it are visible. **Have the person who created the triggers (usually the client's staff) run it.**
5. **Read the results**: go through "点検結果" and "引き継ぎ書" with the client.
6. **Clean up (restore)**:
   1. Delete the `wit-inspect` file.
   2. Paste back the `appsscript.json` you copied in step 1 (removing the scopes added in step 3). If you turned on the manifest setting in step 1, turn it off.
   3. Check that the scopes added in step 3 are no longer listed under "Project OAuth Scopes" on the editor's "Overview".
   4. Run the client's process once (or wait for its next trigger run) and confirm with the client that it works as before.
7. **Record that it was restored**: in the last row "後片付け：元に戻したか", write "済み" (done) and the date in the "確認" (check) column. Keep both sheets as a record (the client may delete them if not needed).

For a script not bound to a spreadsheet (standalone), no spreadsheet scope is added: the findings go to the editor's execution log and no handover sheet is made.

## What is checked

The "状態" (state) column has four values: **直したほうがよい** (should fix), **気をつける** (watch out), **目で確かめる** (check on screen — this inspection cannot read it), **よい** (fine). The "まとめ" (summary) row at the top counts each.

| Item | What is checked | State |
|------|-----------------|-------|
| Functions | Names of the client's functions found (the inspection file's own are excluded) | fine |
| Number of triggers | How many of the 20 allowed per user per script are used | "watch out" at 15 or more |
| Trigger: function | The function a trigger runs does not exist (deleted or renamed) | should fix |
| | Two or more triggers with the same function, type and source (e.g. on form submit) | should fix (runs twice per event) |
| | Two or more time-driven triggers for the same function | watch out (may be intended if the times differ) |
| | An installable trigger whose function is named `onOpen`, `onEdit`, ... | should fix (it also runs as a simple trigger, so it runs twice) |
| Finished triggers | If there are time-driven triggers: finished one-shot triggers stay listed as "disabled" and cannot be told apart from the list | check on screen |
| Double runs: function | Whether functions run by time-driven, form-submit, edit, ... triggers (and the functions they call) use a lock (`LockService`, `WitGas.lock`, `WitGas.guard`) | "watch out" if not |
| Failure handling: function | Whether trigger functions catch failures; whether a catch neither notifies nor rethrows | "watch out" for either |
| Web app | Whether `doGet` / `doPost` exist (check the deployment settings) | check on screen |
| Authorized scopes | Each authorized scope; for broad ones (all of Drive, all of Gmail, all spreadsheets, ...) a narrower scope that often suffices | broad ones are "watch out" |
| Time zone | Whether the script and spreadsheet time zones are the same | "watch out" if they differ |
| WitGas kit | If the client has WitGas parts, whether their versions match | "watch out" if not |
| 6-minute limit | This inspection cannot read run times; it tells you where to look ("Executions") | check on screen |
| Scopes in appsscript.json | This inspection cannot read `appsscript.json`; it tells you where to look | check on screen |
| Handover | Whether the handover sheet could be written | "check on screen" if not |
| Clean-up: restored? | Whether the added file and scopes were removed afterwards; write "済み" and the date in the check column | check on screen |

### Limits of this version

- Function bodies are only searched as text (for lock or `catch` words); nothing is executed to prove it. Whether a `catch` does the right thing is for a person to read.
- Only global functions (written as `function name() {}`) can be found. Functions written as `const name = () => {}` and functions inside libraries may not be found.
- Other people's triggers, run times and the contents of `appsscript.json` are not read (that would need broader scopes or the Apps Script API).

## What is written and what is not

- Only the "点検結果" and "引き継ぎ書" sheets are written. If a sheet with the same name but other contents exists, nothing is written to it (if it is "点検結果", nothing is written at all; if it is "引き継ぎ書", only the result is written).
- Written: function names, trigger types, counts, scopes, time zones, sheet names with row/column counts, property keys. **Function bodies (code), sheet values and property values are never written.**
- In the handover sheet, the reason for each scope reads "（理由が書かれていない）" (no reason given). Fill the reasons in with the client afterwards.
- It does not create or delete triggers, write properties or send email.

## Scopes

At most these two scopes are added for the inspection (the two in this example's `appsscript.json`). Do not replace the client's `appsscript.json` with this example's; add only what is missing.

| Scope | Why |
|-------|-----|
| `script.scriptapp` | Read the trigger list and the authorized scopes |
| `spreadsheets.currentonly` | Write the "点検結果" and "引き継ぎ書" sheets in the same spreadsheet |

## Stage of this example

| Stage | What this example does |
|-------|------------------------|
| 1. Works | Running `witInspect` once from the editor produces the result and the handover sheet |
| 3. Changeable | Produces a handover sheet; upgrading means replacing the file with the new version (see "Settings and upgrades") |

- It is run by a person only when inspecting, never on a schedule (no stage 2).
- **It is not wrapped in `WitGas.guard`.** Taking the client's script lock could stop or skip the client's own processing. It also sends no email (to avoid adding a mail scope). On failure the error appears in the runner's editor. The record of the run is the "点検結果" sheet (the date and time at the top).

### What the next stage could add

- Read run times (the same data as "Executions"); needs the Apps Script API and broader scopes, so separate consent from the client.
- Read `appsscript.json` to show whether `oauthScopes` exists and how the listed scopes differ from the authorized ones (also the Apps Script API).
- Show the difference from the previous inspection (fixed, new).
- For standalone scripts, write the result to a new spreadsheet (needs a file-creation scope).

## Settings and upgrades

- No settings sheet and no `migrate()`: there is nothing to change per client, and the file is added and removed for every inspection.
- To upgrade, replace the contents of the `wit-inspect` file with the new version. The "点検結果" sheet is rewritten every time.
- The version appears in row 2 of the result (`gas-inspect 1.0.0`).

## Tests

`test/examples/gas-inspect.test.js` loads the built file (`wit-inspect.js`) together with a fictional client project. It also checks that only two global names are added and the client's `WitGas` is unchanged, that no triggers are created or deleted, and that function bodies and sheet values are not written.

© 2026 wi-t.com Inc.
