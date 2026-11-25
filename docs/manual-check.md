# 実機（GAS 上）での確認手順

Node のテストは GAS のサービスを偽物に差し替えて動かしています。
偽物と本物の動きが同じかどうかは、ここに書いた手順を GAS 上で実行して確かめます。
結果はオーナーが実行して、下の「結果の記録」に書き込みます。

## 準備

1. 確認用の新しいスプレッドシートを作り、「拡張機能 → Apps Script」を開く。
2. `src/` の各ファイル（`lock.js`・`resume.js`・`runlog.js`・`notify.js`・`guard.js`・`reconcile.js`）の中身を、スクリプトエディタの同じ名前の `.gs` ファイルに貼る。
3. 「プロジェクトの設定 → 『appsscript.json』マニフェスト ファイルをエディタで表示する」をオンにし、
   `appsscript.json` を本リポジトリのものに置き換える。
4. 次の確認用の関数を別ファイル `check.gs` に貼る。

```js
function checkLock_runs() {
  var res = WitGas.lock.run('確認_通常', function () { return 'ok'; });
  console.log(JSON.stringify(res)); // {"skipped":false,"value":"ok"}
}

function checkLock_nested() {
  var inner;
  WitGas.lock.run('確認_入れ子', function () {
    // 同じスクリプトロックを別の Lock で取りにいく
    inner = WitGas.lock.run('確認_入れ子', function () { return 'inner'; });
  });
  console.log(JSON.stringify(inner)); // 期待：{"skipped":true,"reason":"locked","name":"確認_入れ子"}
}

function checkLock_slow() {
  var res = WitGas.lock.run('確認_長い処理', function () {
    Utilities.sleep(60 * 1000); // 1 分間ロックを持つ
    return 'done';
  });
  console.log(JSON.stringify(res));
}

function checkLock_wait() {
  var t0 = Date.now();
  var res = WitGas.lock.run('確認_待つ', function () { return 'ok'; }, { waitMs: 10000 });
  console.log(JSON.stringify(res) + ' / ' + (Date.now() - t0) + 'ms');
}

function checkLock_error() {
  try {
    WitGas.lock.run('確認_失敗', function () { throw new Error('わざと'); });
  } catch (e) {
    console.log('投げられた: ' + e.message);
  }
  // 続けて取れれば、失敗しても解放されている
  console.log(JSON.stringify(WitGas.lock.run('確認_失敗後', function () { return 'ok'; })));
}
```

## 確認用の関数（resume）

`checkResume.gs` に貼ります。1 件 1 分の処理を 10 件するので、4 件ずつ 3 回に分かれる見込みです（全体で 15 分ほど）。

```js
function checkResume() {
  var res = WitGas.lock.run('確認_続き', function () {
    return WitGas.resume.run({
      key: '確認',
      total: 10,
      handler: 'checkResume',
      step: function (i) {
        Utilities.sleep(60 * 1000);
        console.log('item ' + i);
      }
    });
  });
  console.log(JSON.stringify(res));
}

function checkResume_fail() {
  var props = PropertiesService.getScriptProperties();
  WitGas.resume.run({
    key: '確認_失敗',
    total: 5,
    handler: 'checkResume_fail',
    step: function (i) {
      if (i === 2 && props.getProperty('確認_失敗済み') !== 'yes') {
        props.setProperty('確認_失敗済み', 'yes');
        throw new Error('わざと');
      }
      console.log('item ' + i);
    }
  });
}

function checkResume_status() {
  console.log(JSON.stringify(WitGas.resume.get('確認')));
  console.log(JSON.stringify(ScriptApp.getProjectTriggers().map(function (t) {
    return [t.getUniqueId(), t.getHandlerFunction(), String(t.getEventType())];
  })));
}

function checkResume_cleanup() {
  console.log(JSON.stringify(WitGas.resume.cleanup('確認')));
}

// R5 用：resume を使わずに 1 回だけのトリガーを作り、動いたあとも一覧に残るかを見る
function checkTrigger_oneShot() {
  ScriptApp.newTrigger('checkTrigger_noop').timeBased().after(60 * 1000).create();
}
function checkTrigger_noop() {
  console.log('fired');
}
```

## 確認用の関数（runlog・notify）

`checkLog.gs` に貼ります。`LOG_ID` には確認用とは別のスプレッドシートの ID を、`TO` には受け取れるアドレスを入れます。

```js
var LOG_ID = '（別のスプレッドシートの ID）';
var TO = '（受け取るアドレス）';

function checkRunlog_basic() {
  var t0 = new Date();
  ['success', 'failure', 'skipped', 'continued'].forEach(function (r) {
    WitGas.runlog.append({ name: '確認_記録', result: r, startedAt: t0, count: 1,
      error: r === 'failure' ? new TypeError('ここは書かれない') : undefined }, { spreadsheetId: LOG_ID });
  });
}

function checkRunlog_trim() {
  for (var i = 1; i <= 5; i++) {
    WitGas.runlog.append({ name: '確認_上限' + i, result: 'success' },
      { spreadsheetId: LOG_ID, sheetName: '確認_上限', maxRows: 3 });
  }
}

function checkRunlog_formula() {
  WitGas.runlog.append({ name: '=1+1', result: 'success', message: '@x' }, { spreadsheetId: LOG_ID });
}

function checkRunlog_active() {
  // スクリプトが付いたスプレッドシート（確認用）に書く
  WitGas.runlog.append({ name: '確認_開いている', result: 'success' });
}

function checkNotify() {
  var res1 = WitGas.notify.failure({ name: '確認_通知', error: new TypeError('ここは書かれない') }, { to: TO });
  var res2 = WitGas.notify.failure({ name: '確認_通知', error: new TypeError('x') }, { to: TO });
  var res3 = WitGas.notify.failure({ name: '確認_通知', error: new RangeError('x') }, { to: TO });
  console.log(JSON.stringify([res1, res2, res3]));
}
```

## 確認用の関数（guard）

`checkGuard.gs` に貼ります。`LOG_ID` と `TO` は上（`checkLog.gs`）のものを使います。

```js
var GUARD = { log: { spreadsheetId: LOG_ID }, notify: { to: TO } };

function checkGuard_ok() {
  var res = WitGas.guard('確認_guard成功', function (ctx) { ctx.setCount(3); return 'ok'; }, GUARD);
  console.log(JSON.stringify(res));
}

function checkGuard_fail() {
  WitGas.guard('確認_guard失敗', function () { throw new TypeError('ここは記録・通知に書かれない'); }, GUARD);
}

function checkGuard_slow() {
  WitGas.guard('確認_guard長い', function () { Utilities.sleep(60 * 1000); }, GUARD);
}

function checkGuard_resume() {
  return WitGas.guard('確認_guard続き', function () {
    return WitGas.resume.run({
      key: '確認_guard', total: 10, handler: 'checkGuard_resume',
      step: function () { Utilities.sleep(60 * 1000); }
    });
  }, GUARD);
}

function checkGuard_badConfig() {
  WitGas.guard('確認_guard設定', function () { console.log('ここは動かない'); },
    { log: { spreadsheetId: LOG_ID }, notify: { to: 'ops@example' } });
}
```

## 確認用の関数（reconcile）

`checkReconcile.gs` に貼ります。確認用のスプレッドシートに「会計」シートを作り、次の表を A1 から入れておきます（金額は数、日付はシートの日付で入れる）。

| 請求番号 | 金額 | 入金日 |
|----------|------|--------|
| A001 | 1000 | 2026/01/05 |
| A002 | 2500 | 2026/01/06 |
| A003 | 3000 | 2026/01/07 |
| ＡＢ１ | 500 | 2026/01/08 |

```js
var CSV = [
  '請求番号,入金額,入金日',
  'A001,"1,000",2026/1/5',
  'A002,"¥2,400",2026年1月6日',
  'AB1,500円,2026-01-08',
  'A005,△500,2026/1/9',
  ''
].join('\n');

function checkReconcile() {
  var ss = SpreadsheetApp.getActive();
  var books = ss.getSheetByName('会計').getDataRange().getValues();
  var bank = Utilities.parseCsv(CSV);
  var r = WitGas.reconcile.compare(books, bank, {
    key: '請求番号', columnMap: { '金額': '入金額' },
    numberColumns: ['金額'], dateColumns: ['入金日'], width: true
  });
  WitGas.reconcile.writeReport(r, { spreadsheet: ss, labels: { left: '会計', right: '銀行' } });
  console.log(WitGas.reconcile.summaryText(r, { left: '会計', right: '銀行' }));
}

function checkReconcile_refuse() {
  var r = WitGas.reconcile.compare([['ID'], ['1']], [['ID'], ['1']], { key: 'ID' });
  WitGas.reconcile.writeReport(r, { spreadsheet: SpreadsheetApp.getActive(), sheetName: '会計' });
}

function checkReconcile_large() {
  // 左右 1 万行ずつの照合と書き込みにかかる時間を測る（「実行数」の時間を記録する）
  var l = [['ID', '値']], r = [['ID', '値']];
  for (var i = 0; i < 10000; i++) { l.push(['K' + i, i]); r.push(['K' + i, i % 100 === 0 ? i + 1 : i]); }
  var t0 = Date.now();
  var res = WitGas.reconcile.compare(l, r, { key: 'ID' });
  var t1 = Date.now();
  WitGas.reconcile.writeReport(res, { spreadsheet: SpreadsheetApp.getActive(), sheetName: '照合_大' });
  console.log('compare ' + (t1 - t0) + 'ms / writeReport ' + (Date.now() - t1) + 'ms / ' + WitGas.reconcile.summaryText(res));
}
```

## 確認する項目

### lock

| # | 手順 | 期待する結果 |
|---|------|--------------|
| L1 | `appsscript.json` の `oauthScopes` を一時的に `[]` にして `checkLock_runs` を実行（終わったら元に戻す） | `{"skipped":false,"value":"ok"}`。権限の承認画面が出ない（lock は追加の権限なしで動く） |
| L2 | `checkLock_nested` を実行 | 内側が `{"skipped":true,"reason":"locked",...}` になり、実行ログに `[WitGas.lock] skipped: 確認_入れ子 (locked)` が出る |
| L3 | `checkLock_slow` を実行し、終わる前に別のタブで `checkLock_runs` を実行 | 後から実行した方が待たずに `skipped` を返す |
| L4 | `checkLock_slow` を実行し、終わる 10 秒以内前に `checkLock_wait` を実行 | 空くまで待ってから `{"skipped":false,...}`（表示された待ち時間が 10000ms 以下） |
| L5 | `checkLock_slow` を実行し、すぐに `checkLock_wait` を実行 | 約 10000ms 待ってから `skipped` を返す |
| L6 | `checkLock_error` を実行 | `投げられた: わざと` のあとに `{"skipped":false,"value":"ok"}` |
| L7 | 時間主導型トリガーで `checkLock_slow` を 1 分おきに動かし、数回分の実行ログを見る | 重なった回は `skipped` になり、二重に動いていない |
| L8 | GAS のライブラリとして追加し（識別子 `WitGasLib`）、`var WitGas = WitGasLib.WitGas;` で L1〜L3 を実行 | 同じ結果になる。ロックの範囲（呼び出し側のプロジェクトごとか、ライブラリ全体で共有か）を記録する |

### resume

| # | 手順 | 期待する結果 |
|---|------|--------------|
| R1 | `checkResume` を実行 | 承認画面で求められる権限が `script.scriptapp`（トリガーの管理）の 1 つだけ。4 件処理して `{"skipped":false,"value":{"done":false,"cursor":4,...,"scheduled":true}}` |
| R2 | R1 の直後に `checkResume_status` を実行 | `cursor: 4, scheduled: true`。トリガーが 1 つ（`checkResume`、CLOCK）。「プロジェクトの設定 → スクリプト プロパティ」に `WitGas.resume:確認` がある |
| R3 | 15 分ほど待ってから「実行数」画面と `checkResume_status` を見る | `checkResume` が 3 回動き、`item 0`〜`item 9` が 1 回ずつ出ている。どの回も 6 分を越えていない。最後の回は `done: true`。`get` は `null`、トリガー一覧は空、プロパティも消えている |
| R4 | `checkResume_fail` を 2 回実行（1 回目は失敗する）。最後にプロパティ `確認_失敗済み` を手で消す | 1 回目：`item 0`・`item 1` のあとエラー。プロパティの cursor が 2。トリガーは作られない。2 回目：`item 2`〜`item 4` だけ出て完了する |
| R5 | `checkTrigger_oneShot` を実行し、2 分以上待ってからトリガー画面と `checkResume_status` を見る | 動いたあとの 1 回だけのトリガーが一覧に残るかどうかを記録する（Node の偽物は「残る」として作ってある）。最後にそのトリガーを手で消す |
| R6 | `checkResume` を実行し、続きが動く前に `checkResume_cleanup` を実行 | `{"deletedTrigger":true,"deletedState":true}`。トリガーもプロパティも消え、そのあと続きは動かない |
| R7 | ライブラリとして追加し（識別子 `WitGasLib`）、R1〜R3 を実行 | 続きのトリガーとプロパティが、呼び出し側のプロジェクトにできるか、ライブラリ側にできるかを記録する |
| R8 | R1 の承認のあと、`oauthScopes` に `script.scriptapp` だけがある状態で R1〜R3 が動く | プロパティの保存で権限のエラーが出ない |

### runlog

| # | 手順 | 期待する結果 |
|---|------|--------------|
| W1 | `checkRunlog_basic` を実行 | 承認画面で `spreadsheets` の権限を求められる。`LOG_ID` のスプレッドシートに「実行記録」シートができ、見出し（開始・終了・処理名・結果・件数・エラー種別・メッセージ）が太字で 1 行目が固定 |
| W2 | W1 のシートを見る | 4 行あり、結果が 成功・失敗・スキップ・続きあり。失敗の行のエラー種別が `TypeError` で、「ここは書かれない」がどこにもない。開始・終了が `yyyy-mm-dd hh:mm:ss` で表示される |
| W3 | `checkRunlog_trim` を実行 | 「確認_上限」シートに見出しと 3 行（確認_上限3〜5）だけが残る |
| W4 | `checkRunlog_formula` を実行 | 処理名のセルが `=1+1` の文字のまま表示され、`2` にならない。メッセージも `@x` の文字のまま |
| W5 | W3 を 5,000 行の上限で試す（任意）：`maxRows` を外し、5,001 回以上書く関数を `resume` で区切って動かす | 見出しと 5,000 行のまま、古い行から消える。1 回の追記にかかる時間を「実行数」から記録する |
| W6 | `checkRunlog_active` を実行 | 確認用のスプレッドシート（スクリプトが付いたもの）に「実行記録」ができる |
| W7 | `oauthScopes` の `spreadsheets` を `spreadsheets.currentonly` に変えて W6 と W1 を実行（終わったら戻す） | W6 は動き、W1（`openById`）は権限のエラーになるかを記録する |

### notify

| # | 手順 | 期待する結果 |
|---|------|--------------|
| N1 | `checkNotify` を実行 | 承認画面で `script.send_mail` の権限を求められる。結果が `[{"sent":true},{"sent":false,"reason":"throttled"},{"sent":true}]`。`CacheService`・`Session`・`Utilities` で権限のエラーが出ない |
| N2 | N1 のメールを見る | 2 通（`TypeError` と `RangeError`）。件名が `[WitGas] 失敗: 確認_通知 (TypeError)` など。本文の時刻が日本時間で、「ここは書かれない」がない |
| N3 | N1 から 1 時間以内にもう一度 `checkNotify` を実行 | 3 つとも `throttled` になり、メールは届かない |
| N4 | N1 から 1 時間以上たってから `checkNotify` を実行 | また 2 通届く |

### guard

| # | 手順 | 期待する結果 |
|---|------|--------------|
| G1 | `checkGuard_ok` を実行 | `status` が `success`、`count` が 3。実行記録に「確認_guard成功／成功／3」。メールは来ない |
| G2 | `checkGuard_fail` を実行 | 「実行数」画面で失敗になり、そこにエラーのメッセージが出る。実行記録に「失敗／TypeError」。メールが 1 通届き、本文に実行記録の URL がある。実行記録とメールに「ここは記録・通知に書かれない」がない |
| G3 | G2 を 1 時間以内にもう一度実行 | 実行記録に 2 行目の「失敗」。メールは来ない |
| G4 | `checkGuard_slow` を実行し、終わる前に別のタブでもう一度 `checkGuard_slow` を実行 | 後の方は待たずに終わり、実行記録に「スキップ」（メッセージ `locked`）。メールは来ない |
| G5 | `checkGuard_resume` を実行し、15 分ほど待つ | 実行記録に「続きあり（4, cursor 4, runs 1）」「続きあり（4, cursor 8, runs 2）」「成功（2, cursor 10, runs 3）」。トリガーとプロパティが残らない |
| G6 | `checkGuard_badConfig` を実行 | すぐにエラー（`opts.to has an invalid address`）。「ここは動かない」は出ず、実行記録もメールもない |

### reconcile

| # | 手順 | 期待する結果 |
|---|------|--------------|
| C1 | `checkReconcile` を実行 | ログに `一致 2 / 不一致 1 / 会計だけ 1 / 銀行だけ 1 / キー重複 0 / キーなし 0`（A001 はシートの日付と `"1,000"`、`ＡＢ１` は `AB1`・`500円` と一致する。A002 は金額が違う） |
| C2 | C1 のあと「照合結果」シートを見る | 上に件数、下に明細。不一致の行は `金額 / 入金額`、会計の値 2500、銀行の値 `¥2,400`。`会計だけ` に A003、`銀行だけ` に A005 |
| C3 | `checkReconcile_refuse` を実行 | `not a reconcile report` のエラーになり、「会計」シートは消えていない |
| C4 | `checkReconcile_large` を実行 | 6 分以内に終わる。ログの時間（compare と writeReport）を記録する。README に時間を書くのは、この記録のあとにする |
| C5 | C1 の `width: true` を外して実行 | ログが `一致 1 / 不一致 1 / 会計だけ 2 / 銀行だけ 2 / キー重複 0 / キーなし 0` になる（`ＡＢ１` と `AB1` が別のキーになる。`String.prototype.normalize` が GAS で動くことの確認） |

## 結果の記録

| 日付 | 確認した人 | # | 結果 | メモ |
|------|------------|---|------|------|
|      |            |   |      |      |

© 2026 株式会社wi-t.com
