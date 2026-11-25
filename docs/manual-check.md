# 実機（GAS 上）での確認手順

Node のテストは GAS のサービスを偽物に差し替えて動かしています。
偽物と本物の動きが同じかどうかは、ここに書いた手順を GAS 上で実行して確かめます。
結果はオーナーが実行して、下の「結果の記録」に書き込みます。

## 準備

1. 確認用の新しいスプレッドシートを作り、「拡張機能 → Apps Script」を開く。
2. `src/lock.js` と `src/resume.js` の中身を、スクリプトエディタの新しいファイル `lock.gs`・`resume.gs` に貼る。
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

## 結果の記録

| 日付 | 確認した人 | # | 結果 | メモ |
|------|------------|---|------|------|
|      |            |   |      |      |

© 2026 株式会社wi-t.com
