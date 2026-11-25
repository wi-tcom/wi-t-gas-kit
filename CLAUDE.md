# CLAUDE.md — wi-t-gas-kit

## 目的
GAS（Google Apps Script）を「先方が安心して使い続けられる」形で納品するための部品集。
世の中の GAS 公開物は、開発の土台（clasp など）と個別機能の部品は充実しているが、
「止まらない・気づける・確かめられる・引き継げる」ための運用部品が手薄。そこを埋める。

- 受託・応募の実績として GitHub で公開する（2026-11-26 にオーナーが MIT ライセンスで公開すると決めた）。
- 当社の見本（帳票PDF・承認フロー・CSV照合）と、ERABAZU の部品の土台にする。

## 原則
- ユーザー（オーナー）とのやり取りは日本語。中国語を出さない。
- 言語は JavaScript（GAS の V8）。TypeScript は使わない。
- ライブラリ本体は外部依存なし。GAS のライブラリとしても、ファイルのコピーでも使えること。
- 開発は公式の土台に乗る：clasp でソースを管理する。テストは Node（GAS のサービスを偽物に差し替える）で動かす。
- 変更したら必ず `npm test` で ALL PASS を確認する。GitHub Actions でも同じテストを回す。
- 権限は最小限：`appsscript.json` の `oauthScopes` を明示し、使う理由を README に書く。
- 個人情報や業務データの中身を実行記録・通知に残さない（件数・ID・エラー種別まで）。
- 書いていない経験・実績を README や説明に書かない。数字は実測したものだけ。
- 著作権表記：英語は「© 2026 wi-t.com Inc.」、日本語は「© 2026 株式会社wi-t.com」。ライセンスは MIT（`LICENSE`。2026-11-26 にオーナーが決めた）。
- README は日本語（README.md）と英語（README.en.md）の2本。

## 安心の約束（すべての部品が満たすこと）
1. 持ち主と権限：先方のアカウント上で動き、権限は最小限。
2. 止まらない：6分の実行時間の上限を越えない。決まった時刻に自動で動く。二重に動かない。
3. 気づける：失敗したら通知し、実行の記録が残る。
4. 確かめられる：結果を元データと突き合わせられる。
5. 引き継げる：設定値・トリガー・権限・止め方が文書で分かる。

## 第1段で作る部品（この順で）

### 1. lock（二重実行の防止）
- `WitGas.lock.run(name, fn, opts)`：`LockService.getScriptLock()` で取得できたときだけ `fn` を実行し、必ず解放する。
- 取れなかったときは実行せず、結果 `{skipped:true, reason:'locked'}` を返し、実行記録に「スキップ」と残す。
- `opts.waitMs`（既定 0）。

### 2. resume（続き実行）
- `WitGas.resume.run({key, total|hasNext, step, budgetMs, handler})`
  - 1回の実行で `budgetMs`（既定 4.5分）を越える前に区切り、進み具合（カーソル）を `PropertiesService` に保存する。
  - 続きは時間指定のトリガー（1分後、1回だけ）を `handler` 関数名で張って再開する。完了したらカーソルとトリガーを必ず消す。
  - 途中で失敗しても、同じカーソルからやり直せる（同じ項目を二度処理しない／処理しても結果が変わらない書き方を README に示す）。
  - トリガーが残り続けないこと（掃除の関数 `WitGas.resume.cleanup(key)` も用意）。

### 3. runlog と notify（実行記録とエラー通知）
- `WitGas.runlog`：指定したスプレッドシートの「実行記録」シートに 1 実行 1 行で残す。
  列：開始・終了・処理名・結果（成功／失敗／スキップ／続きあり）・件数・エラー種別・メッセージ（短く）。
- `WitGas.notify`：失敗したら `MailApp` で指定アドレスに知らせる。同じ処理・同じエラーは 1 時間に 1 通まで（`CacheService` で抑える）。
- 記録の行数が増えすぎないよう、古い行を消す上限（既定 5,000 行）を持つ。

### まとめの入り口
- `WitGas.guard(name, fn, opts)`：lock → 実行 → runlog → 失敗時 notify を 1 行で包む。見本や納品物は基本これで包む。

## 第2段以降（第1段のあとで相談）
- reconcile（照合レポート）：2つの表・CSV をキーで突き合わせ、一致・不一致・片方だけ、を表にする。
- handover（引き継ぎ書の自動作成）：トリガー・権限・スクリプトのプロパティ（値は伏せる）・シート構成を一覧にして文書に出す。
- 見本3本：帳票PDFの一括作成、フォーム→承認→通知、CSV照合。いずれも guard で包む。

## テストの書き方
- `test/` に Node のテスト。`LockService`・`PropertiesService`・`ScriptApp`・`SpreadsheetApp`・`MailApp`・`CacheService`・`Utilities` を偽物に差し替える（`test/mocks/`）。
- 時間は偽の時計で進め、「4.5分で区切る」「1時間に1通」「トリガーが残らない」を確かめる。
- 実機（GAS 上）での確認手順は `docs/manual-check.md` に書き、オーナーが実行した結果を記録する。

## 構成（目安）
```
src/            GAS に送るソース（lock.js, resume.js, runlog.js, notify.js, guard.js）
appsscript.json
test/           Node のテストと偽物
docs/           実機確認の手順、設計メモ
.github/workflows/test.yml
README.md / README.en.md
```
