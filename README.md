# wi-t-gas-kit

[English](README.en.md)

GAS（Google Apps Script）を「先方が安心して使い続けられる」形で納品するための部品集です。
開発の土台や個別機能の部品ではなく、**止まらない・気づける・確かめられる・引き継げる** ための運用部品を集めます。

- 言語は JavaScript（GAS の V8）。ライブラリ本体は外部依存なし。
- GAS のライブラリとしても、ファイルのコピーでも使えます。

## 進み具合

| 部品 | 内容 | 状態 |
|------|------|------|
| `WitGas.lock` | 二重実行の防止 | 実装済み（Node のテストのみ。実機確認は未） |
| `WitGas.resume` | 6 分の上限の前に区切って続きを実行 | 予定 |
| `WitGas.runlog` / `WitGas.notify` | 実行記録とエラー通知 | 予定 |
| `WitGas.guard` | 上の部品を 1 行で包む入り口 | 予定 |

## 入れ方

### ファイルをコピーする

`src/` の `.js` ファイルを、先方のスクリプトプロジェクトにそのまま貼ります（ファイル名は `.gs` でも構いません）。
グローバルに増える名前は `WitGas` だけです。ファイルの並び順には依存しません。

### clasp で送る

```bash
cp .clasp.json.example .clasp.json   # scriptId を先方のスクリプトIDに書き換える
npx @google/clasp push
```

`.claspignore` で、送るのは `appsscript.json` と `src/` だけにしています。

### GAS のライブラリとして使う

ライブラリとして追加するときは、識別子を `WitGasLib` などにし、次の 1 行で使います。

```js
var WitGas = WitGasLib.WitGas;
```

ライブラリ経由のときのロックの範囲（呼び出し側のプロジェクトごとか、共有か）は実機で確認してから書きます（[docs/manual-check.md](docs/manual-check.md) の L8）。
確実に呼び出し側のロックを使いたい場合は、`opts.lock` に `LockService.getScriptLock()` を渡してください。

## WitGas.lock — 二重実行の防止

スクリプトロック（`LockService.getScriptLock()`）が取れたときだけ処理を動かし、終わったら（失敗しても）必ず解放します。
取れなかったときは処理を動かさず、スキップとして返します。

```js
function dailyJob() {   // 時間主導型トリガーから呼ぶ関数
  var res = WitGas.lock.run('日次集計', function () {
    // ここに処理を書く
    return 120;          // 返した値は res.value に入る
  });
  if (res.skipped) return; // 前の回がまだ動いていた
}
```

### 返り値

| 場合 | 返り値 |
|------|--------|
| 実行した | `{ skipped: false, value: <fn の返り値> }` |
| ロックが取れずスキップした | `{ skipped: true, reason: 'locked', name: <処理名> }` |
| `fn` が失敗した | ロックを解放してから、同じエラーを投げる |

### オプション

| 名前 | 既定 | 内容 |
|------|------|------|
| `waitMs` | `0` | ロックが空くのを待つ最大ミリ秒。0 なら待たずにスキップ。 |
| `onSkip` | なし | スキップしたときに呼ぶ関数。`{name, result:'skipped', reason:'locked', startedAt, endedAt}` を受け取る。実行記録シート（`WitGas.runlog`、予定）につなぐ入口。 |
| `lock` | `LockService.getScriptLock()` | 使うロック。`tryLock(ms)` と `releaseLock()` を持つもの。 |

### 決まりごと

- スキップすると、実行ログ（`console.log`）に `[WitGas.lock] skipped: <処理名> (locked)` と残ります。
- ログに残すのは処理名とエラー種別だけです。**処理名に個人情報や業務データを入れないでください。**
- `fn` は同期関数にしてください。`Promise` を返すとロックが先に外れるため、エラーにします。
- 処理は成功したのにロックの解放に失敗したときは、解放のエラーを投げます（ロックが残ると次の回がすべてスキップされるため、成功扱いにしません）。
- 処理の失敗と解放の失敗が重なったときは、処理のエラーを投げ、解放の失敗はログに残します。

## 権限（oauthScopes）

`appsscript.json` の `oauthScopes` を明示し、必要なものだけを並べます。部品を追加するたびに、ここに理由を書きます。

| 権限 | 使う部品 | 理由 |
|------|----------|------|
| （なし） | `WitGas.lock` | `LockService` と `console` だけを使う。追加の権限を求めない想定（実機確認は L1） |

## 止め方

`WitGas.lock` はトリガーも保存データも作りません。止めたいときは、呼び出している関数のトリガーを消してください（「トリガー」画面から削除）。

## 開発

```bash
npm test
```

- テストは Node の `node:test` で動きます（Node 22 以上。外部パッケージなし）。
- `test/mocks/` に GAS のサービスの偽物と偽の時計があり、`test/helpers/gas-env.js` が `src/` を GAS と同じく 1 つの共有グローバルに読み込みます。
- GitHub Actions（`.github/workflows/test.yml`）でも同じテストを回します。
- 実機での確認手順と結果は [docs/manual-check.md](docs/manual-check.md) にあります。

© 2026 株式会社wi-t.com
