# 見本：CSV照合

[English](README.en.md)

「会計」シートの表と、取り込んだ CSV（銀行の入金明細など）を **請求番号で突き合わせ**、
一致・不一致・片方だけ を「照合結果」シートに出す見本です。スプレッドシートのメニューから動かします。

- 照合は `WitGas.reconcile`、実行は `WitGas.guard` で包んでいます。
- 実行のたびに「実行記録」シートへ 1 行（件数だけ）残し、失敗したらメールで知らせます。
- データはすべて架空です。

## シート

| シート | 中身 | 誰が書くか |
|--------|------|------------|
| 会計 | 手元の表（1 行目が見出し。請求番号・金額・入金日 など） | 先方 |
| CSV貼り付け | 取り込んだ CSV（1 行目が見出し。請求番号・入金額・入金日 など） | 先方（取り込み） |
| 照合結果 | 区分ごとの件数と明細 | このスクリプト（毎回書き直す） |
| 実行記録 | 1 実行 1 行（開始・終了・結果・件数・件数の内訳） | このスクリプト |

## 入れ方

### スクリプトエディタに貼る

1. 照合に使うスプレッドシートで「拡張機能 → Apps Script」を開く。
2. 次のファイルを、同じ名前で作って中身を貼る（`.gs` になってかまいません）。
   - リポジトリの `src/` から：`lock.js`・`runlog.js`・`notify.js`・`guard.js`・`reconcile.js`（`parts.json` に書いてあるもの）
   - この見本から：`main.js`
3. 「プロジェクトの設定 → 『appsscript.json』マニフェスト ファイルをエディタで表示する」をオンにし、
   `appsscript.json` をこの見本のものに置き換える。
4. `main.js` の `CSV_RECONCILE.notifyTo` を、失敗を知らせる先のアドレスに変える。
5. スプレッドシートを開き直すと、メニューに「照合」が出る。

### clasp で送る

```bash
cd examples/csv-reconcile
echo '{"scriptId":"（スプレッドシートに付いたスクリプトの ID）"}' > .clasp.json
cd ../..
npm run example:build -- csv-reconcile
cd dist/csv-reconcile
npx @google/clasp push
```

`npm run example:build` は、この見本の `appsscript.json`・`main.js` と、`parts.json` に書いた部品を `dist/csv-reconcile/` にまとめます。
`.clasp.json` はコミットしません。

## 使い方

### 見本のデータで試す

メニュー「照合 → 見本のデータを入れる」のあと、「照合 → 照合する」。
「会計」か「CSV貼り付け」にデータがあるときは、見本のデータは入れません（消さずに止めます）。

結果は次のとおりになります（`test/examples/csv-reconcile.test.js` で確かめています）。

```
一致 2 / 不一致 2 / 会計だけ 1 / 銀行だけ 1 / キー重複 0 / キーなし 0
```

### 本番の CSV を取り込む

1. 「CSV貼り付け」シートを選ぶ。
2. 「ファイル → インポート → アップロード」で CSV を選ぶ。
3. 「インポート場所」は **現在のシートを置換する** にする。
4. **「テキストを数値、日付、数式に変換する」をオフ** にする。
   オンのままだと、`001` のような番号の先頭の 0 が落ちたり、`=` で始まる値が式になったりします。
   金額（`"1,000"`）や日付（`2026/1/5`）は、文字のままでも照合のときにそろえます。
5. メニュー「照合 → 照合する」。

文字化けする場合は、CSV を UTF-8 で保存し直してから取り込んでください。

## 設定（`main.js` の `CSV_RECONCILE`）

| 名前 | 見本の値 | 内容 |
|------|----------|------|
| `name` | `CSV照合` | 実行記録・通知に出る処理名 |
| `leftSheet` / `rightSheet` | `会計` / `CSV貼り付け` | 照合する 2 つのシート |
| `reportSheet` / `logSheet` | `照合結果` / `実行記録` | 書き出すシート |
| `labels` | `{ left: '会計', right: '銀行' }` | 結果に出る呼び名（「会計だけ」「銀行の値」など） |
| `compare` | 下のとおり | `WitGas.reconcile.compare` に渡す設定 |
| `notifyTo` | `ops@example.com` | 失敗を知らせる先。**必ず変える** |

```js
compare: {
  key: '請求番号',
  columns: ['金額', '入金日'],          // 比べる列（会計シートの列名）
  columnMap: { '金額': '入金額' },      // 列名が違う列：会計 → CSV
  numberColumns: ['金額'],              // "110,000" と 110000 を同じにする
  dateColumns: ['入金日'],              // シートの日付と "2026/1/5" を同じ日にする
  width: true                           // 全角と半角の違いを無視する
}
```

CSV の列名が違う場合は `columnMap` を、比べる列を増やす場合は `columns` を変えます。
詳しくはリポジトリの README の `WitGas.reconcile` を見てください。

## 結果の見方

「照合結果」シートの上に区分ごとの件数、その下に明細が出ます。

| 区分 | 意味 | よくある原因 |
|------|------|--------------|
| 一致 | 比べた列がすべて同じ | — |
| 不一致 | 請求番号は両方にあるが、金額か入金日が違う（違う列ごとに 1 行） | 入金額の誤り、振込手数料の差し引き、入金日のずれ |
| 会計だけ | 会計にあって CSV にない | 未入金 |
| 銀行だけ | CSV にあって会計にない | 会計への登録漏れ、請求番号の書き間違い |
| キー重複 | 同じ請求番号が 2 行以上ある | 二重登録、分割入金 |
| キーなし | 請求番号が空 | 番号の書き忘れ |

## 権限

| 権限 | 理由 |
|------|------|
| `https://www.googleapis.com/auth/spreadsheets.currentonly` | このスプレッドシートだけを読み書きする（ほかのスプレッドシートには触らない） |
| `https://www.googleapis.com/auth/script.container.ui` | メニューと、入力が足りないときの知らせを出す |
| `https://www.googleapis.com/auth/script.send_mail` | 失敗をメールで知らせる |

トリガーを作らないので、`script.scriptapp` は使いません。
`spreadsheets.currentonly` で足りることは、まだ GAS 上で確かめていません（`docs/manual-check.md` の E1）。足りなければ `spreadsheets` に変えます。

## 業務データの扱い

- 「照合結果」シートには、照合のために請求番号・金額・日付が入ります。このスプレッドシートの共有の範囲に気をつけてください。
- 「実行記録」とメールに書くのは、件数とエラー種別だけです。
- 失敗したときの詳しいエラーは、Apps Script の「実行数」画面で確認します。

## すでに `onOpen` がある場合

スクリプトに `onOpen` がすでにあると、どちらかが上書きされます。この見本の `onOpen` の中身（メニューを足す部分）を、今ある `onOpen` に移してください。

## 止め方

- トリガーもスクリプトのプロパティも作りません。メニューから動かしたときだけ動きます。
- 使わなくなったら、`main.js` の `onOpen` を消せばメニューが出なくなります。
- 「照合結果」と「実行記録」のシートは、消してもかまいません（次に照合したときに作り直します）。

## Drive やメールから CSV を読む場合

この見本は、権限を増やさないために「シートに取り込む」形にしています。
Drive に置かれた CSV やメールの添付から直接読む場合は、`runCsvReconcile` の `right` を次のように差し替えます。
**どちらも GAS 上では確かめていません。** 使うときは権限を足し、実機で確かめてから納品してください。

```js
// Drive のファイル
var blob = DriveApp.getFileById('（CSV のファイル ID）').getBlob();
var right = Utilities.parseCsv(blob.getDataAsString('UTF-8'));

// メールの添付
var thread = GmailApp.search('from:（送り元） has:attachment filename:csv newer_than:7d', 0, 1)[0];
var att = thread.getMessages().pop().getAttachments()[0];
var right = Utilities.parseCsv(att.getDataAsString('UTF-8'));
```

| 読み込み元 | 足す権限（見込み） | 気をつけること |
|------------|--------------------|----------------|
| Drive | `https://www.googleapis.com/auth/drive.readonly` | Drive の全ファイルを読める権限になる |
| メール | `https://mail.google.com/` | `GmailApp` は、読むだけでもメール全体（送信・削除を含む）の権限を求める見込み。先方への説明が要る |

文字コードが Shift_JIS の CSV は `getDataAsString('Shift_JIS')` にします（これも GAS 上では確かめていません）。

© 2026 株式会社wi-t.com
