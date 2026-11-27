# Example: Form → approval → notification (form-approval)

[日本語](README.md)

Requests come in through a Google Form; an approver chooses "承認" (approve) or "差し戻し" (return) in the spreadsheet, and the applicant is told the result by email. It runs automatically every 10 minutes.

- Version: `1.0.0` (`FORM_APPROVAL_VERSION` in `main.js`; changes in [CHANGELOG.md](CHANGELOG.md), Japanese)
- Parts: `version.js`, `lock.js`, `runlog.js`, `notify.js`, `guard.js`, `handover.js`, `settings.js`, `migrate.js` (`parts.json`)
- All data is fictional. Sheet names, menu items and settings are in Japanese.

## Flow

1. The applicant answers the form. With the form's "Collect email addresses" setting, the applicant's address goes into the response sheet ("フォームの回答 1").
2. Every 10 minutes the script imports new responses into the "承認" (approval) sheet, numbers them (`A-0001`, ...) and marks them "未判断" (not yet decided). The approver gets an email with **counts only**, e.g. "2 new requests (5 waiting)".
3. The approver picks "承認" or "差し戻し" in the "判断" (decision) column; when returning, writes the reason in "コメント" (comment).
4. On the next run (within 10 minutes) the applicant is emailed the result and "状態" (state) becomes "知らせた（承認）" (notified, approved) etc. A request is never notified twice.

- The form itself is not read (no forms scope); only the linked response sheet is.
- Decisions are picked up by a time-driven trigger (every 10 minutes), not by an edit trigger (`onEdit`): it does not run on every edit, and a mistaken choice corrected quickly may be fixed before it is sent (only if corrected before the next run).

## Stage of this example

| Stage | What this example does |
|-------|------------------------|
| 1. Works | "今すぐ取り込む・知らせる" (import and notify now) runs once from the menu. No double runs, run log, failure notice (`WitGas.guard`) |
| 2. Hands-off | Runs every 10 minutes. Stays within the per-run limit and 4.5 minutes; the rest goes to the next run. "点検する" (check) reconciles the response sheet with the approval sheet (not imported, removed responses, stuck "sending", decision changed after notifying) |
| 3. Changeable | Sheet names, column names, copied columns, recipients, email texts and limits are set in the "設定" (settings) sheet. Handover sheet and upgrade steps |

### What the next stage could add

- Two-level approval (manager → director); approver by amount.
- Record who decided (not recorded now; see the sheet's version history).
- A morning digest of requests waiting too long.
- Copy approved requests to other sheets (ledger, accounting).

## Sheets

| Sheet | Contents | Written by |
|-------|----------|------------|
| フォームの回答 1 | Form responses (timestamp, email, answers) | The form |
| 承認 | One request per row: number, received at, applicant, decision, comment, state, notified at, response row, and the copied columns | This script (decision and comment by the approver) |
| 設定 | Per-client values (see "Settings") | Created by "設定と表を用意する"; values changed by the client |
| 実行記録 | One row per run (counts only) | This script |
| 引き継ぎ書 | Versions, triggers, scopes, settings, how to stop | "引き継ぎ書を作る" |

**Do not delete or sort rows in the response sheet.** Imported responses are recognized by timestamp and email address ("点検する" reports deleted or sorted rows). Do not delete rows in the approval sheet either (request numbers come from the row count).

## Install

1. Create the form and turn on "Settings → Responses → Collect email addresses".
2. In the form's "Responses", "Link to Sheets" → new spreadsheet (creates the "フォームの回答 1" sheet).
3. In that spreadsheet open "Extensions → Apps Script" and create files with the same names, pasting:
   - the 8 files listed in `parts.json` from the repository's `src/`
   - `main.js` from this example
4. Turn on "Project Settings → Show 'appsscript.json' manifest file in editor" and replace `appsscript.json` with this example's.
5. Reopen the spreadsheet; the "申請" menu appears. Run "申請 → 設定と表を用意する" (prepare settings and sheets).
6. Change "承認者の通知先" (approver) and "失敗の通知先" (failure notice) in the settings sheet; change "写す列" (copied columns) to match the form's questions.
7. Run "点検する" to confirm, then "定時の動きを始める（10 分ごと）" (start the 10-minute schedule).

With clasp:

```bash
cd examples/form-approval
echo '{"scriptId":"(ID of the script bound to the spreadsheet)"}' > .clasp.json
cd ../..
npm run example:build -- form-approval
cd dist/form-approval
npx @google/clasp push
```

Without a form, "見本のデータを入れる" (insert sample data) creates a "フォームの回答 1" sheet with 3 fictional responses (fictional `example.com` addresses: change them to your own before choosing a decision).

## Use

- **Approver**: when the email arrives, open the "承認" sheet, choose "承認" or "差し戻し"; write the reason in "コメント" when returning. The applicant is told within 10 minutes. **If unsure, leave "判断" empty** (a note in the comment is fine).
- **When returned**: the applicant applies again through the form (a new request number).
- **Run now**: "今すぐ取り込む・知らせる".
- **Stop**: "定時の動きを止める" (stop the schedule). The sheets are kept.
- **Check**: "点検する" lists what to fix (it fixes nothing).

## Settings ("設定" sheet)

| Item | Default | Meaning |
|------|---------|---------|
| 回答のシート / 承認のシート / 実行記録のシート | フォームの回答 1 / 承認 / 実行記録 | Sheet names |
| 列：タイムスタンプ / 列：メールアドレス | タイムスタンプ / メールアドレス | Header names in the response sheet |
| 写す列 | 件名, 金額 | Response-sheet headers copied to the approval sheet (comma-separated), for the approver to decide on |
| 申請番号の頭 | A- | Numbers like `A-0001` |
| 承認者の通知先 | approver@example.com | **Must change**; comma-separate several |
| 失敗の通知先 | ops@example.com | **Must change** |
| 件名の頭 | [申請] | Subject prefix |
| 送り主の名前 | 申請の受付 | Sender name of the applicant's email |
| 返信先 | (empty) | Reply-to for the applicant; empty means the trigger's owner |
| 承認のメールの文 / 差し戻しのメールの文 | (sample text) | `{申請番号}`, `{受付日時}`, `{結果}`, `{コメント}` are filled in; an empty comment becomes "（なし）" |
| 1 回に知らせる上限 | 50 | Emails to applicants per run (1–100); the rest go next run |

- Invalid values are reported on screen by item name, and nothing runs.
- **When running on the schedule (no screen), it emails "失敗の通知先" if at least that item can be read** (at most once an hour), since a 10-minute job would otherwise fail unnoticed.
- The settings sheet survives code replacement.

## Scopes

| Scope | Why |
|-------|-----|
| `https://www.googleapis.com/auth/spreadsheets.currentonly` | Read and write the responses, approval, settings and run-log sheets of this spreadsheet |
| `https://www.googleapis.com/auth/script.scriptapp` | Create and delete the 10-minute trigger; list triggers in the handover sheet |
| `https://www.googleapis.com/auth/script.send_mail` | Notify the approver and applicants; send failure notices |
| `https://www.googleapis.com/auth/script.container.ui` | Show the menu and messages |

No forms scope is used. Mail is sent with `MailApp`, so no Gmail read scope either.

## Never twice, never lost

- Before sending, "状態" is set to "送信中" (sending) and committed (`SpreadsheetApp.flush()`); after sending it becomes "知らせた（承認）" etc.
- If a run stops mid-send (failure or timeout), the row stays "送信中" and the next run does **not** resend it (we prefer a person checking over sending twice). "点検する" reports it; check the trigger owner's Gmail "Sent" folder, and if it was not sent, set "状態" back to "未判断" to send on the next run.
- Changing "判断" after notifying does not send again ("点検する" reports it).
- A run stops notifying when it reaches the per-run limit, nears 4.5 minutes, or the daily quota (`MailApp.getRemainingDailyQuota()`) is used up; the rest goes to the next run.
- Wrapped in `WitGas.guard` so it never runs twice at once (a menu run overlapping the trigger is "skipped").

## Daily sending limit

`MailApp` has a per-day recipient limit depending on the account type (see "Quotas" in Google's Apps Script documentation). Here, one email to the approver and one per applicant count. Near the limit the rest waits for the next day, and the run log shows the count under "次の回へ" (to next run).

## Business data

- The approval sheet holds the applicant's address and the copied columns. Mind the spreadsheet's sharing.
- The applicant's email contains the request number, received time, result and comment (it is the notice itself).
- The approver's email contains only counts and the spreadsheet URL.
- The run log and failure notices contain only counts (imported, notified, no address, to next run, still sending) and error types.
- Answers starting with `=` etc. are copied as text, so they never run as formulas.

## When something fails

| What happened | Screen | Run log | Email |
|---------------|--------|---------|-------|
| Settings and sheets not prepared yet | Asks to run "設定と表を用意する" | none | none |
| Invalid setting | Names the item | none | only on the schedule (no screen), to the failure address |
| No response sheet / missing headers | Names the sheet or columns | failure (`SheetFormatError`) | to the failure address |
| Could not send mail, etc. | Apps Script error | failure (error type) | to the failure address |
| Applicant address is not an email address | — | counted as "宛先なし" (no address) | not sent (state "宛先なし（知らせていない）") |

## How to upgrade

1. **Before**: copy the spreadsheet ("File → Make a copy"); the script is copied too. Triggers are not copied. The linked form may be copied as well, so do not hand out the copy's form; use the copy only for restoring (to be confirmed in manual check F9).
2. **Stop**: "定時の動きを止める".
3. **Replace**: paste the new `main.js` and the parts in `parts.json` (or `npm run example:build -- form-approval` then `clasp push`); use the new `appsscript.json` too.
4. **Run**: "設定と表を用意する". Only migration steps not yet run are run; the schema version goes up. Running it again changes nothing. Settings are kept.
5. **Check**: "点検する" shows no problems; "引き継ぎ書を作る" shows the new version.
6. **Start**: "定時の動きを始める".
7. **Rollback**: keep it stopped, paste the "承認" and "設定" sheets from the copy back into the original spreadsheet, and paste the previous version's files. The original spreadsheet is the one linked to the form, so do not swap the whole spreadsheet.

`CHANGELOG.md` records what changes in each version and whether it has migration steps.

## How to stop

- "定時の動きを止める" (run by the person who created the trigger). Check in the triggers page that no `runFormApproval` trigger is left.
- To stop accepting requests, turn off "Accepting responses" in the form's "Responses".
- To remove the menu, delete `onOpen` in `main.js`. If an `onOpen` already exists, move this example's menu code into it.

© 2026 wi-t.com Inc.
