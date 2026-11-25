# 実機（GAS 上）での確認手順

Node のテストは GAS のサービスを偽物に差し替えて動かしています。
偽物と本物の動きが同じかどうかは、ここに書いた手順を GAS 上で実行して確かめます。
結果はオーナーが実行して、下の「結果の記録」に書き込みます。

## 準備

1. 確認用の新しいスプレッドシートを作り、「拡張機能 → Apps Script」を開く。
2. `src/lock.js` の中身を、スクリプトエディタの新しいファイル `lock.gs` に貼る。
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

## 確認する項目

| # | 手順 | 期待する結果 |
|---|------|--------------|
| L1 | `checkLock_runs` を実行 | `{"skipped":false,"value":"ok"}`。権限の承認画面が出ない（`oauthScopes: []` のまま動く） |
| L2 | `checkLock_nested` を実行 | 内側が `{"skipped":true,"reason":"locked",...}` になり、実行ログに `[WitGas.lock] skipped: 確認_入れ子 (locked)` が出る |
| L3 | `checkLock_slow` を実行し、終わる前に別のタブで `checkLock_runs` を実行 | 後から実行した方が待たずに `skipped` を返す |
| L4 | `checkLock_slow` を実行し、終わる 10 秒以内前に `checkLock_wait` を実行 | 空くまで待ってから `{"skipped":false,...}`（表示された待ち時間が 10000ms 以下） |
| L5 | `checkLock_slow` を実行し、すぐに `checkLock_wait` を実行 | 約 10000ms 待ってから `skipped` を返す |
| L6 | `checkLock_error` を実行 | `投げられた: わざと` のあとに `{"skipped":false,"value":"ok"}` |
| L7 | 時間主導型トリガーで `checkLock_slow` を 1 分おきに動かし、数回分の実行ログを見る | 重なった回は `skipped` になり、二重に動いていない |
| L8 | GAS のライブラリとして追加し（識別子 `WitGasLib`）、`var WitGas = WitGasLib.WitGas;` で L1〜L3 を実行 | 同じ結果になる。ロックの範囲（呼び出し側のプロジェクトごとか、ライブラリ全体で共有か）を記録する |

## 結果の記録

| 日付 | 確認した人 | # | 結果 | メモ |
|------|------------|---|------|------|
|      |            |   |      |      |

© 2026 株式会社wi-t.com
