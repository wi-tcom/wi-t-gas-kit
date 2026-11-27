# wi-t-gas-kit

[English](README.en.md)

GAS（Google Apps Script）を「先方が安心して使い続けられる」形で納品するための部品集です。
開発の土台や個別機能の部品ではなく、**止まらない・気づける・確かめられる・引き継げる** ための運用部品を集めます。

- 言語は JavaScript（GAS の V8）。ライブラリ本体は外部依存なし。
- GAS のライブラリとしても、ファイルのコピーでも使えます。

## 進み具合

| 部品 | 内容 | 状態 |
|------|------|------|
| `WitGas.lock` | 二重実行の防止 | 実装済み（実機確認：一部済み。[結果](docs/manual-check.md#結果の記録)） |
| `WitGas.resume` | 6 分の上限の前に区切って続きを実行 | 実装済み（実機確認：一部済み。[結果](docs/manual-check.md#結果の記録)） |
| `WitGas.runlog` / `WitGas.notify` | 実行記録とエラー通知 | 実装済み（実機確認：一部済み。[結果](docs/manual-check.md#結果の記録)） |
| `WitGas.guard` | 上の部品を 1 行で包む入り口 | 実装済み（実機確認：一部済み。[結果](docs/manual-check.md#結果の記録)） |
| `WitGas.settings` / `WitGas.migrate` | 設定シートの読み書き／データの形の移行 | 実装済み（Node のテストのみ。実機確認は未） |
| `WitGas.handover` | 引き継ぎ書をシートに書く | 実装済み（実機確認：H1〜H6 合格。[結果](docs/manual-check.md#結果の記録)） |
| `WitGas.reconcile` | 2 つの表をキーで突き合わせる | 実装済み（実機確認：一部済み。見本「CSV照合」と C6 で確認、C1〜C5 は未。[結果](docs/manual-check.md#結果の記録)） |

### 見本

| 見本 | 内容 | 状態 |
|------|------|------|
| [CSV照合](examples/csv-reconcile/README.md) | 会計シートと取り込んだ CSV を請求番号で照合し、結果をシートに出す（メニューから実行）。設定シート・版上げの手順つき（版 1.0.0） | 実装済み（実機確認：一部済み。E1〜E5・E7・E8 は合格、E6 は未。[結果](docs/manual-check.md#結果の記録)） |
| [帳票 PDF の一括作成](examples/pdf-batch/README.md) | 明細の 1 行を 1 枚の「お見積書」の PDF にし、スクリプトが作ったフォルダにまとめる。区切って続き・設定シート・版上げの手順つき（版 1.0.0） | 実装済み（Node のテストのみ。実機確認は未。P0 の下調べは済み） |

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

ライブラリ経由のときに、ロック・スクリプトのプロパティ・トリガーがどのプロジェクトのものになるかは、実機で確認してから書きます（[docs/manual-check.md](docs/manual-check.md) の L8・R7）。
確実に呼び出し側のものを使いたい場合は、呼び出し側から渡してください。

```js
WitGas.lock.run('集計', fn, { lock: LockService.getScriptLock() });
WitGas.resume.run({ /* ... */ properties: PropertiesService.getScriptProperties(), scriptApp: ScriptApp });
```

## WitGas.guard — まとめの入り口（まずはこれ）

lock（二重実行の防止）→ 実行 → runlog（実行記録）→ 失敗したら notify（通知）を 1 行で包みます。
見本や納品物は、基本これで包みます。

```js
// 設定は 1 か所にまとめる（引き継ぎのときに見る場所）
var GUARD = {
  log:    { spreadsheetId: '1AbC...（実行記録を置くスプレッドシートの ID）' },
  notify: { to: 'ops@example.com' }
};

function dailySummary() {   // 時間主導型トリガーから呼ぶ
  WitGas.guard('日次集計', function (ctx) {
    var n = summarize_();    // ここに処理を書く
    ctx.setCount(n);         // 実行記録の「件数」に出る
  }, GUARD);
}
```

| 起きたこと | 実行記録 | 通知 | 戻り値の `status` |
|------------|----------|------|-------------------|
| 最後まで動いた | 成功 | なし | `success` |
| `resume` が区切った | 続きあり | なし | `continued` |
| 前の回がまだ動いていた | スキップ | なし | `skipped` |
| 失敗した | 失敗（エラー種別） | あり（1 時間に 1 通まで） | — （エラーを投げ直す） |

### resume と組み合わせる

`fn` が `WitGas.resume.run` の結果を返すと、区切った回は「続きあり」、最後の回は「成功」になり、
件数にはその回に処理した数、メッセージには `cursor 4, runs 1` のような進み具合が入ります。

```js
function makeInvoices() {   // 毎日のトリガーからも、続きのトリガーからもこの関数が呼ばれる
  return WitGas.guard('請求書PDF', function () {
    var rows = loadRows_();
    return WitGas.resume.run({
      key: 'invoicePdf',
      total: rows.length,
      handler: 'makeInvoices',
      step: function (i) { /* 1 行ずつ処理（下の「二度処理しても困らない書き方」を参照） */ }
    });
  }, GUARD);
}
```

### opts

| 名前 | 既定 | 内容 |
|------|------|------|
| `log` | （必須） | 実行記録の設定（`WitGas.runlog.append` の opts）。残さないなら `false`。 |
| `notify` | （必須） | 通知の設定（`WitGas.notify.failure` の opts）。送らないなら `false`。 |
| `waitMs` | `0` | ロックが空くのを待つ最大ミリ秒。 |
| `lock` | スクリプトロック | 使うロック（`WitGas.lock.run` の `opts.lock`）。 |
| `rethrow` | `true` | 失敗したとき、記録と通知のあとにエラーを投げ直す。`false` なら投げずに `{status:'failure', errorType}` を返す。 |

`log` と `notify` は、書き忘れを防ぐため必須にしています。使わないときは `false` と書いてください。

### ctx（fn の引数）

- `ctx.setCount(n)`：件数を決める。`ctx.addCount(n)`：件数を足す（`n` を省けば 1）。
- `ctx.setMessage(s)`：実行記録のメッセージ（100 文字まで）。個人情報や業務データを入れないでください。
- 失敗した場合も、それまでに数えた件数は実行記録と通知に残ります。

### 決まりごと

- **設定は毎回、処理の前に確かめます。** 送り先の書き間違いなどは、失敗が起きてからではなく、最初の実行でエラーになります（このときは記録も通知もしません）。
- 失敗したときは、実行記録 → 通知 → 投げ直し の順です。投げ直すので、Apps Script の「実行数」画面でも「失敗」になり、エラーのメッセージはそこで確認できます。
  実行記録と通知に残すのはエラー種別だけです。
- 実行記録が書けなかったときは、処理の結果は変えずに、エラー種別 `runlog:<種別>` で通知します。
- 通知が送れなかったときは、ログに残して、元のエラーを投げ直します。
- 通知の本文には、`log.spreadsheetId`（または `log.spreadsheet`）から作った実行記録の URL が入ります。`notify.linkUrl` を渡せばそちらを使います。
- `guard` だけをコピーする場合は、`lock.js`（と、記録・通知を使うなら `runlog.js`・`notify.js`）も一緒に入れてください。

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
| 入れ子で呼ばれた（下の「入れ子」） | `{ skipped: false, value: <fn の返り値>, nested: true }` |
| `fn` が失敗した | ロックを解放してから、同じエラーを投げる |

### オプション

| 名前 | 既定 | 内容 |
|------|------|------|
| `waitMs` | `0` | ロックが空くのを待つ最大ミリ秒。0 なら待たずにスキップ。 |
| `onSkip` | なし | スキップしたときに呼ぶ関数。`{name, result:'skipped', reason:'locked', startedAt, endedAt}` を受け取る。実行記録シート（`WitGas.runlog`）につなぐ入口。`WitGas.guard` はここを使って「スキップ」を記録します。 |
| `lock` | `LockService.getScriptLock()` | 使うロック。`tryLock(ms)` と `releaseLock()` を持つもの。 |

### 決まりごと

- スキップすると、実行ログ（`console.log`）に `[WitGas.lock] skipped: <処理名> (locked)` と残ります。
- ログに残すのは処理名とエラー種別だけです。**処理名に個人情報や業務データを入れないでください。**
- `fn` は同期関数にしてください。`Promise` を返すとロックが先に外れるため、エラーにします。
- 処理は成功したのにロックの解放に失敗したときは、解放のエラーを投げます（ロックが残ると次の回がすべてスキップされるため、成功扱いにしません）。
- 処理の失敗と解放の失敗が重なったときは、処理のエラーを投げ、解放の失敗はログに残します。
- **入れ子**：`fn` の中から、同じ実行でもう一度 `lock.run`（や `guard`）を呼ぶと、外側のロックのまま中身を動かします。取り直しも解放もしません（`waitMs`・`lock`・`onSkip` は使いません）。
  本物のスクリプトロックは同じ実行の中では取り直せてしまい、内側で解放すると外側の処理が終わる前にロックが外れるためです（2026-11-25 の実機確認 L2）。

## WitGas.resume — 続き実行

1 回の実行で決めた時間（既定 4.5 分）を越える前に区切り、進み具合（カーソル）をスクリプトのプロパティに保存して、
1 分後に 1 回だけ動くトリガーで続きを動かします。終わったら、カーソルとトリガーを消します。

```js
function makeInvoices() {   // 毎日のトリガーからも、続きのトリガーからもこの関数が呼ばれる
  WitGas.lock.run('請求書PDF', function () {
    var sheet = SpreadsheetApp.getActive().getSheetByName('請求');
    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
    return WitGas.resume.run({
      key: 'invoicePdf',
      total: rows.length,
      handler: 'makeInvoices',              // 続きのトリガーが呼ぶ関数名（この関数自身）
      step: function (i) {
        if (rows[i][4] === '済') return;     // 済んだ行は飛ばす
        createPdf_(rows[i]);                 // 同じ名前のファイルがあれば作り直さない
        sheet.getRange(i + 2, 5).setValue('済');
      }
    });
  });
}
```

`resume` 自体は二重実行を防ぎません。上の例のように `WitGas.lock.run` の中で呼ぶか、`WitGas.guard` で包んでください（実行記録と通知もつきます）。

### 引数

| 名前 | 既定 | 内容 |
|------|------|------|
| `key` | （必須） | 処理を見分ける名前。プロパティ `WitGas.resume:<key>` に保存する。 |
| `total` | — | 項目の数。カーソルは 0 から `total - 1` まで進む。`hasNext` とどちらか一方。 |
| `hasNext` | — | `function(cursor)`。その項目があれば `true`。件数が先に分からないとき。 |
| `step` | （必須） | `function(cursor)`。1 項目を処理する。何も返さなければ次は `cursor + 1`。`cursor` より大きい整数を返すと、そこから続ける（100 行ずつまとめて処理する、など）。同期関数にすること。 |
| `handler` | （必須） | 続きのトリガーが呼ぶ関数名。トップレベルの関数で、普通は `run` を呼んでいる関数自身。 |
| `budgetMs` | `270000`（4.5 分） | 1 回の実行で使う時間の上限。1〜360000。 |
| `properties` / `scriptApp` | `PropertiesService.getScriptProperties()` / `ScriptApp` | 差し替えるときだけ渡す。 |

### 返り値

`{ done, cursor, processed, runs, scheduled, elapsedMs, setupMs, stalled }`

- `done`：最後まで終わったら `true`。続きがあれば `false`（実行記録の「続きあり」）。
- `cursor`：次に処理する位置。`processed`：この回に処理した数。`runs`：何回目の実行か。
- `scheduled`：続きのトリガーを張ったら `true`。
- `setupMs`：`run` を呼んでから最初の項目に入るまでの時間。`stalled`：最初の項目の前で区切ったら `true`（下の「区切り方」）。

### 区切り方

- 続きのトリガーは「1 分後」を指定していますが、2026-11-25・27 の実機確認では、区切ってから **約 65〜94 秒後** に動きました。
  全体の時間は「1 回の時間（最長 4.5 分）＋待ち（約 1.5 分）」×回数 が目安です。たとえば 1 件 1 分の 10 件は 3 回に分かれ、約 13 分でした。

- 次の 1 件が「この回で一番長くかかった 1 件」と同じだけかかっても上限に収まるときだけ、次へ進みます。
- 時間は `run` を呼んだときから数えます。前に時間のかかる準備をするなら、その分 `budgetMs` を小さくしてください。
- 最初の 1 件は、前の回で一番長くかかった 1 件の時間で見込みます。最初の項目に入る前（保存した進み具合の読み出しや、動き終わったトリガーの片付け）で上限の大半を使っていたら、その回は何も処理せずに続きを張って終えます（返り値の `stalled` が `true`、件数 0）。
  これが **3 回続いたら**、続きを張らずにエラー（`ResumeStallError`）にします。進まないまま続きのトリガーが続くのを防ぐためです。カーソルは残るので、原因を直してから `run` を呼べば続きから進みます。
  2026-11-26 の実機確認で、続きの回が 6 分を越えた（392.8 秒）ため足しました。2026-11-27 に同じ条件（トリガー 3 つ、うち 2 つは動き終わったもの）で確かめたときは再現せず、準備にかかった時間は 297〜330ms でした。原因は分かっていないので、どの回も最初に `[WitGas.resume] start: ... (setup …ms)` を、区切りと完了のときに `longest step …ms` をログに出します。
- 前の回がないとき（1 回目）と、1 件だけで上限を越える処理では、最低 1 件は進めます（進まないままトリガーが続くことはありません）。
  ただし 1 件が 6 分の上限を越えるような処理は、`step` を小さく分けてください。

### 失敗したとき

- `step` が失敗したら、**失敗した項目のカーソル**を保存し、続きのトリガーは張らずにエラーを投げます（同じ失敗を 1 分おきに繰り返さないため）。
- 次に `run` が呼ばれると（毎日のトリガーや手動で）、その項目からやり直します。
- 保存が壊れていたら、最初からやり直さずにエラーにします（処理済みの項目をもう一度処理しないため）。`WitGas.resume.cleanup(key)` で消すと最初からになります。
- トリガーが作れないとき（1 プロジェクト 20 個の上限など）も、カーソルは保存してからエラーを投げます。

### 同じ項目を二度処理しても困らない書き方

カーソルを保存するのは「区切ったとき」と「失敗したとき」だけです。そのため、次の場合は項目がもう一度処理されます。

- 失敗した項目（やり直すため）
- 実行が強制終了された場合（6 分の上限を越えた、など）：その回に処理した項目すべて

各項目は「二度処理しても結果が変わらない」書き方にしてください。

1. **済みの印**：項目ごとに「済」などの印を書き、印があれば飛ばす。
2. **上書きする**：`appendRow` で足すのではなく、決まったセルに `setValue` で書く。
3. **決まった名前で作る**：ファイルは決まった名前にし、もうあれば作らない（または上書きする）。
4. **取り消せないもの（メール送信など）**：送る前に「送信中」、送ったあとに「済」と書く。「送信中」のまま止まった項目は自動で送り直さず、人が確かめる。
5. 処理中に行を消したり並べ替えたりしない（カーソルは位置なので、ずれる）。必要なら ID で済みの印を管理する。

### 動き終わったトリガー

1 回だけ動くトリガーは、動いたあとも「無効」として一覧に残ります（2026-11-25 の実機確認 R5）。
`resume` は、次の回の最初にこのトリガーを消し、終わったときには続きのトリガーを残しません。
次の場合だけ、動き終わったトリガーが一覧に残ります。

- 続きの回が、ほかの処理とぶつかってスキップしたとき（下の「ロックとぶつかったとき」）：次に `run` が呼ばれたときか、`cleanup(key)` で消えます。

### ロックとぶつかったとき

スクリプトロックはプロジェクト全体で 1 つです。続きの回がほかの処理とぶつかって `lock.run` がスキップすると、その回は何もしません。
カーソルは残っているので、次に `run` が呼ばれたとき（毎日のトリガーや手動）に続きから進みます。
すぐに続けたい場合は `lock.run` の `waitMs` を指定してください（待った時間も 6 分に含まれます）。

### 保存するもの

スクリプトのプロパティ `WitGas.resume:<key>` に、次の JSON を保存します。業務データは入りません。

```json
{"v":1,"cursor":4,"runs":1,"firstStartedAt":1767571200000,"triggerId":"1234567890","lastStepMs":60000,"stalls":0}
```

### そのほかの関数

- `WitGas.resume.get(key)`：保存している進み具合 `{cursor, runs, firstStartedAt, scheduled}`。なければ `null`。
- `WitGas.resume.cleanup(key)`：続きのトリガーと保存を消す。途中でやめるとき、最初からやり直すとき。利用者が自分で作ったトリガーは、同じ関数名でも消しません。

## WitGas.runlog — 実行記録

指定したスプレッドシートの「実行記録」シートに、1 実行 1 行で残します。シートがなければ作ります。

```js
var LOG = { spreadsheetId: '1AbC...（実行記録を置くスプレッドシートの ID）' };

WitGas.runlog.append({
  name: '日次集計',
  result: 'success',          // 'success' | 'failure' | 'skipped' | 'continued'
  startedAt: startedAt,
  count: 120
}, LOG);
```

| 開始 | 終了 | 処理名 | 結果 | 件数 | エラー種別 | メッセージ |
|------|------|--------|------|------|------------|------------|
| 2026-01-05 09:00:00 | 2026-01-05 09:03:12 | 日次集計 | 成功 | 120 | | |
| 2026-01-05 10:00:00 | 2026-01-05 10:00:01 | 請求書PDF | 失敗 | | TypeError | |

### entry（1 行の中身）

| 名前 | 内容 |
|------|------|
| `name` | 処理名（必須）。100 文字まで。 |
| `result` | `success`→成功、`failure`→失敗、`skipped`→スキップ、`continued`→続きあり（必須）。 |
| `startedAt` / `endedAt` | 開始・終了の `Date`。終了を省けば今、開始を省けば終了と同じ。 |
| `count` | 件数（0 以上の整数）。 |
| `error` | エラー。**種別（`TypeError` など）だけを書き、エラーのメッセージは書きません**（業務データを含みうるため）。 |
| `errorType` | 種別を直接書くとき。 |
| `message` | 短いメッセージ。改行はなくし、100 文字までに切ります。個人情報や業務データを入れないでください。 |

### opts

| 名前 | 既定 | 内容 |
|------|------|------|
| `spreadsheetId` | — | 書くスプレッドシートの ID。 |
| `spreadsheet` | — | スプレッドシートのオブジェクト（ID の代わり）。 |
| （どちらもない） | 開いているスプレッドシート | スプレッドシートに付いたスクリプトのとき。なければエラー。 |
| `sheetName` | `実行記録` | シート名。 |
| `maxRows` | `5000` | 残す行数（見出しを除く）。越えたら古い行から消す。 |
| `matchTimeZone` | `false` | 「実行記録」シートを新しく作るとき（空のとき）だけ、記録先のタイムゾーンがスクリプトと違えば、記録先をスクリプトのタイムゾーンに合わせる。すでに行があるときは変えずに警告だけ出す。先方のファイルの設定を変えるので、既定はオフ。 |

### 決まりごと

- `=`・`+`・`-`・`@` で始まる文字は、式として読まれないよう先頭に `'` をつけます。
- 今あるシートの見出しは書き直しません（列の並びは上の表のまま使ってください）。
- シートを作るときに列幅も決めます（開始・終了は 150 ピクセル。日時が切れずに見える幅）。
- **記録先のタイムゾーンに気をつけてください。** 新しく作ったスプレッドシートは、一度シートを編集するまで、タイムゾーンが `America/Los_Angeles`（太平洋時間）で保存されています。「ファイル → 設定」の画面には「東京」と表示されるので、画面では気づけません（2026-11-26 の実機確認 W8。表題を変えるだけでは変わらず、シート名の変更などシートの編集で `Asia/Tokyo` に変わった）。
  「拡張機能 → Apps Script」でスクリプトを付けたときにも `Asia/Tokyo` に変わりました（同 E8）。そのため、スクリプトが付いたスプレッドシートに書く場合は、今回の確認ではずれは起きませんでした。ずれるのは、**別のスプレッドシートを記録先にして `spreadsheetId` で書き、そのスプレッドシートを作ったまま一度も編集していないとき** です。
  このまま書くと、記録の時刻が 17 時間ずれて表示されます。あとからタイムゾーンを直しても、書いた時刻は直りません。
  - 記録先を新しく作ったら、書く前に一度シートを編集する（シート名を変える、など）。
  - または `matchTimeZone: true` にして、「実行記録」シートを新しく作るときに合わせる。
    **`matchTimeZone` が働くのは、「実行記録」シートを新しく作るとき（シートが空のとき）だけです。** すでに行がある「実行記録」シートに書くときは、記録先のタイムゾーンが太平洋時間のままでも設定は変えず、下の警告を出すだけです（そのシートの時刻はもうずれているので、合わせると前の行と後の行で時刻の基準が混ざるため）。このときは、記録先のシートを一度編集して（シート名を変える、など）タイムゾーンを `Asia/Tokyo` にしてから、「実行記録」シートを作り直してください（設定画面はもともと「東京」と表示されているので、画面を見るだけでは直りません）。
  - 違ったまま書いたときは、実行ログに `[WitGas.runlog] time zone differs: ...` と警告を出し、返り値の `timeZoneMismatch` が `true` になります。合わせたときは `timeZoneChanged` が `true` です。
- 書き込みに失敗したらエラーを投げます。

## WitGas.notify — エラー通知

失敗したら、`MailApp` で指定アドレスに知らせます。同じ処理・同じエラー種別は 1 時間に 1 通までです。

```js
WitGas.notify.failure(
  { name: '請求書PDF', error: e, count: 3 },
  { to: 'ops@example.com', linkUrl: '（実行記録のシートの URL）' }
);
// → { sent: true }  または  { sent: false, reason: 'throttled' }
```

届くメール：

```
件名：[WitGas] 失敗: 請求書PDF (TypeError)

処理が失敗しました。

処理名：請求書PDF
エラー種別：TypeError
時刻：2026-01-05 10:00:01（Asia/Tokyo）
件数：3
実行記録：https://docs.google.com/spreadsheets/d/...

同じ処理・同じエラー種別のお知らせは 1 時間に 1 通までです。
回数や詳しい時刻は実行記録と、Apps Script の「実行数」画面で確認してください。
```

### info と opts

| 名前 | 既定 | 内容 |
|------|------|------|
| `info.name` | （必須） | 処理名。 |
| `info.error` / `info.errorType` | 種別 `Error` | 種別だけを使います。**エラーのメッセージはメールに書きません。** |
| `info.at` | 今 | 起きた時刻。 |
| `info.count` | — | 件数。 |
| `opts.to` | （必須） | 送り先。カンマ区切りの文字列か配列。 |
| `opts.throttleMs` | `3600000`（1 時間） | 同じ通知を抑える時間。1 分〜6 時間。 |
| `opts.subjectPrefix` | `[WitGas]` | 件名の頭。先方の名前などに変えられます。 |
| `opts.linkUrl` | — | 本文に載せる URL（`https://` で始まるもの）。 |
| `opts.timeZone` | スクリプトのタイムゾーン | 時刻の表示に使う。 |

### 決まりごと

- 抑えるための目印は `CacheService` のスクリプトのキャッシュに置きます（キーは `WitGas.notify:` ＋処理名と種別から作った値）。
- 送れたときだけ目印を置きます。送れなかったらエラーを投げ、次の失敗でもう一度送ります。
- `CacheService` は期限の前に消えることがあります。そのときは 1 時間以内でももう 1 通届きます。
  また、同時に 2 つの実行が失敗すると、2 通届くことがあります。「多くても 1 通」ではなく「ふつうは 1 通」と考えてください。
- 処理名と種別の改行はなくします（件名が壊れないように）。

## WitGas.reconcile — 照合

2 つの表をキーで突き合わせ、**一致・不一致・左だけ・右だけ・キー重複・キーなし** に分けます。
どの行も必ずどれか 1 つの区分に入るので、区分ごとの件数を足すと元の行数と合います（合わなければエラーにします）。

```js
function reconcileInvoices() {
  WitGas.guard('請求照合', function (ctx) {
    var ss = SpreadsheetApp.getActive();
    var books = ss.getSheetByName('会計').getDataRange().getValues();
    var bank  = Utilities.parseCsv(csvText);               // CSV の文字列（読み込み方は場面による）
    var r = WitGas.reconcile.compare(books, bank, {
      key: '請求番号',
      columnMap: { '金額': '入金額' },                     // 列名が違う列だけ
      numberColumns: ['金額'],
      dateColumns: ['入金日']
    });
    WitGas.reconcile.writeReport(r, { spreadsheet: ss, labels: { left: '会計', right: '銀行' } });
    ctx.setCount(r.summary.leftRows);
    ctx.setMessage(WitGas.reconcile.summaryText(r, { left: '会計', right: '銀行' }));
  }, GUARD);
}
```

### compare(left, right, opts)

表は 2 次元配列で、1 行目が見出しです（シートの `getValues()` や `Utilities.parseCsv()` の結果をそのまま渡せます）。
列は見出しの名前で指定します。

| 名前 | 既定 | 内容 |
|------|------|------|
| `key` | （必須） | キーの列名。複数列なら配列（`['店', '日付']`）。 |
| `columns` | 両方にある列（キーを除く） | 比べる列名。 |
| `columnMap` | — | 左の列名 → 右の列名。名前が違う列だけ書く（キーも可）。 |
| `numberColumns` | — | 数として比べる列。`1,000`・`¥1,000`・`1,000円`・`１，０００` は 1000、`△500`・`▲500` は -500 にそろえる。読めない値は文字のまま比べる。 |
| `dateColumns` | — | 日付として比べる列。シートの日付と `2026/1/5`・`2026-01-05`・`2026年1月5日` を同じ日にそろえる。 |
| `trim` | `true` | 前後の空白（全角の空白も）を無視する。 |
| `width` | `false` | 全角と半角の違いを無視する（`Ａ０１` と `A01`、`ｶﾞｽ` と `ガス`）。 |
| `timeZone` | スクリプトのタイムゾーン | シートの日付を日にちにするときのタイムゾーン。 |

**比べ方の決まり**

- 数の列でなければ文字として比べます。`1000` と `"1000"` は同じ、`1000` と `"1,000"` は違います。
- キーも同じ決まりです。`"001"` と `1` は別のキーです（コードの先頭の 0 を落とさないため）。同じにしたいときはキーの列を `numberColumns` に入れます。
- 日付の列でなければ、シートの日付は時刻まで含めて比べます。
- 空・`null`・足りない列（CSV の行が短い）は、どれも空として比べます。`true` と `"TRUE"` は同じです。
- キーが重複している行は照合せず、両方の表の行をまとめて「キー重複」にします。キーが空の行は「キーなし」です。
- すべての列が空の行は数えずに飛ばします（件数は `summary.leftEmptyRows`・`rightEmptyRows`）。

**結果**

```js
{
  key: ['請求番号'], columns: ['取引先', '金額'],
  matched:    [{ key: ['A001'], leftRow: 2, rightRow: 2 }],
  mismatched: [{ key: ['A002'], leftRow: 3, rightRow: 3,
                 diffs: [{ column: '金額', rightColumn: '入金額', left: 2500, right: 2400 }] }],
  leftOnly:   [{ key: ['A003'], leftRow: 4 }],
  rightOnly:  [{ key: ['A005'], rightRow: 5 }],
  duplicates: [{ key: ['A009'], leftRows: [8, 9], rightRows: [7] }],
  blankKey:   [{ side: 'left', row: 10 }],
  summary: { matched, mismatched, leftOnly, rightOnly, duplicates, blankKey,
             leftRows, rightRows, leftEmptyRows, rightEmptyRows }
}
```

行番号は、見出しを 1 行目として数えます（A1 から始まるシートの `getDataRange()` なら、シートの行番号と同じです）。

### writeReport(result, opts)

結果を「照合結果」シートに書きます。上に区分ごとの件数、その下に明細（不一致は違う列ごとに 1 行）です。

| 名前 | 既定 | 内容 |
|------|------|------|
| `spreadsheetId` / `spreadsheet` | 開いているスプレッドシート | 書く先。 |
| `sheetName` | `照合結果` | シート名。 |
| `labels` | `{ left: '左', right: '右' }` | 表の呼び名。「会計だけ」「銀行の値」のように出る。 |
| `includeMatched` | `false` | 一致した行も明細に書く。 |

- 書く先のシートは、**空か、前に `writeReport` で書いたもの（A1 が「照合日時」）に限ります**。ほかのシートを指定すると、消さずにエラーにします。
- 前の照合結果は消してから書きます。
- シートを新しく作るとき（空のとき）だけ列幅を決めます（照合日時が切れずに見える幅）。2 回目からは、先方が変えた列幅を残します。
- `=`・`+`・`-`・`@` で始まる値は、式として読まれないよう先頭に `'` をつけます。

### summaryText(result, labels)

`一致 120 / 不一致 3 / 左だけ 1 / 右だけ 0 / キー重複 0 / キーなし 0` のような件数だけの文を返します。実行記録のメッセージに使えます。

### 業務データの扱い

照合結果のシートには、照合のためにキーと値（業務データ）を書きます。先方のスプレッドシートの中に置き、共有の範囲に気をつけてください。
実行記録と通知には `summaryText` の件数だけを書きます。エラーのメッセージには列名だけを書き、データの値は書きません。

## WitGas.handover — 引き継ぎ書

引き継ぎに要ることを集めて、スプレッドシートの「引き継ぎ書」シートに書きます。
納品のときや、担当が替わるときに作り直してください。

```js
function writeHandover() {   // スクリプトエディタから実行する
  WitGas.handover.write({
    scopes: [                // appsscript.json の oauthScopes と、使う理由
      { scope: 'https://www.googleapis.com/auth/spreadsheets', reason: '実行記録と照合結果を書く' },
      { scope: 'https://www.googleapis.com/auth/script.scriptapp', reason: '続きのトリガーを作る・消す' },
      { scope: 'https://www.googleapis.com/auth/script.send_mail', reason: '失敗をメールで知らせる' }
    ],
    settings: [              // 設定値。secret: true の値は伏せる
      { name: '通知先', value: GUARD.notify.to, note: '失敗のメールの送り先' },
      { name: '実行記録', value: 'このスプレッドシートの「実行記録」シート' }
    ],
    stopSteps: [             // 止め方（順番に）
      'トリガーの画面で dailySummary のトリガーを消す',
      "途中で止めるなら WitGas.resume.cleanup('invoicePdf') を実行する"
    ]
  });
}
```

### 書くこと

| 節 | 中身 | どこから |
|----|------|----------|
| （頭） | 作成日時・スクリプト ID・タイムゾーン | GAS |
| 版 | 見本・納品物の名前と版、部品集の版、入っている部品ごとの版（部品集の版と違えば印）、スキーマの版 | `opts.app`、各部品の `VERSION`、`WitGas.schema:*` |
| トリガー | 関数・種類（時間主導型・開いたとき など）・起動元・ID。`WitGas.resume` の続きのトリガーには印をつける | `ScriptApp.getProjectTriggers()` |
| 権限 | 権限・理由・承認済みか | `opts.scopes`（呼び出し側が書く）と、GAS が返す承認済みの権限 |
| スクリプトのプロパティ | キーだけ。**値は書かない**。`WitGas.resume` の途中なら進み具合（cursor・runs） | `PropertiesService` |
| シートの構成 | シート名・行数・列数（`headers: true` なら 1 行目も） | 書き先のスプレッドシート（`opts.inspect` でほかも） |
| 設定値 | 名前・値・説明。`secret: true` の値は伏せる | `opts.settings` |
| 止め方 | 番号つきの手順 | `opts.stopSteps` |
| 読めなかったもの | 権限が足りないなどで読めなかった項目と、エラー種別 | — |

### opts

| 名前 | 既定 | 内容 |
|------|------|------|
| `spreadsheetId` / `spreadsheet` | 開いているスプレッドシート | 書き先。 |
| `sheetName` | `引き継ぎ書` | シート名。 |
| `scopes` | — | `[{scope, reason}]`。`appsscript.json` の `oauthScopes` と同じものを、理由をつけて書く。 |
| `settings` | — | `[{name, value, note?, secret?}]`。 |
| `stopSteps` | — | 止め方の手順（文字の配列）。 |
| `app` | — | `{name, version}`。見本・納品物の名前と版（`main.js` の `VERSION`）。 |
| `triggers` | `true` | `false` ならトリガーの一覧を読まず、「出していない」と書く。トリガーを使わず `script.scriptapp` の権限を持たない見本向け（部品集 0.3.0 から）。 |
| `inspect` | 書き先 | 構成を書くスプレッドシート（オブジェクトか ID の配列）。 |
| `headers` | `false` | 各シートの 1 行目（見出し）も書く。1 行目が見出しでないシートがあると、業務データが引き継ぎ書に載るので、既定はオフ。 |

`WitGas.handover.collect(opts)` は、同じ中身をオブジェクトで返すだけで、シートには書きません。

### 決まりごと

- **権限は呼び出し側が書きます。** GAS は実行中に自分の `appsscript.json` を読めないためです。
  かわりに、GAS が返す「承認済みの権限」と突き合わせ、書いた権限が承認されていなければ「いいえ」、
  承認されているのに書かれていない権限は「（理由が書かれていない）」として出します。
  承認済みの権限を GAS が返さないときは「分からない」と書きます。
- **トリガーは、引き継ぎ書を作った人が作ったものだけが出ます**（`getProjectTriggers()` の決まり）。ほかの人が作ったトリガーを載せるには、その人が引き継ぎ書を作ってください。
- 動き終わった 1 回だけのトリガー（トリガーの画面で「無効」と出るもの）も、ほかと同じく「時間主導型」として並びます。GAS から無効かどうかを読めないためです（2026-11-26 の実機確認）。
- 時間主導型のトリガーの時刻（毎日 9 時、など）は GAS から読めないので、トリガーの画面で確かめてください。
- 書き先のシートは、**空か、前に `write` で書いた引き継ぎ書（A1 が「引き継ぎ書」）に限ります**。ほかのシートを指定すると、消さずにエラーにします。
- 「引き継ぎ書」シートそのものは、シートの構成に入れません。
- シートを新しく作るときだけ列幅を決めます。`=`・`+`・`-`・`@` で始まる値は、式として読まれないよう先頭に `'` をつけます。

## WitGas.settings — 設定シート

先方ごとに変える値（シート名・通知先・列名・上限など）を「設定」シートに置き、コードから読みます。コードを入れ替えても、設定シートの値は消えません。

```js
var ITEMS = [
  { key: '明細のシート', value: '明細', note: '帳票のもとの表' },
  { key: '1 回の上限（ミリ秒）', value: 270000, type: 'number' },
  { key: '失敗の通知先', value: 'ops@example.com', type: 'email', required: true }
];
WitGas.settings.ensure({ items: ITEMS });       // なければ作る。足りない項目だけ足す（今ある値は書き換えない）
var s = WitGas.settings.read({ items: ITEMS }); // s['失敗の通知先'] など
```

- シートの形：1 行目が見出し（項目・値・説明）、2 行目から 1 項目 1 行。
- `type` は `string`（既定）・`number`・`boolean`（「はい」「いいえ」も可）・`email`。`required: true` は空を許さない。
- 値が型に合わないときは `SettingsError` を投げます。メッセージは「「設定」シートの「失敗の通知先」の値がメールアドレスになっていません。」のように項目名だけで、値は書きません。
- 鍵などの秘密の値はシートに置かず、スクリプトのプロパティに置いてください。

## WitGas.migrate — データの形の移行

版上げでシートや列の形が変わるときに、決まった順の「段」を動かします。今の形の版（スキーマの版）は、スクリプトのプロパティ `WitGas.schema:<key>` に持ちます。

```js
var STEPS = [
  { version: 1, name: '設定シートと作成記録を作る', run: function () { /* なければ作る */ } },
  { version: 2, name: '作成記録に「送信日時」の列を足す', run: function () { /* なければ足す */ } }
];
WitGas.migrate.run({ key: 'pdfBatch', steps: STEPS });  // → { from, to, ran }
WitGas.migrate.needed({ key: 'pdfBatch', steps: STEPS }); // まだ動いていない段があれば true
```

- まだ動いていない段だけを、版の小さい順に動かし、1 段ごとに版を保存します。何度呼んでも、済んだ段は動きません。
- 段は「何度動かしても結果が変わらない」書き方にしてください（なければ作る、なければ足す）。途中で失敗しても、そこまでの版が残り、直してもう一度呼べば続きから動きます。
- データの形がコードより新しいとき（古いコードに戻したとき）は、触らずにエラーにします。
- 二重に動かないよう、`WitGas.guard` で包んで呼んでください。

## 部品の版

- 部品集の版は `WitGas.version`（いまは `0.3.0`）。各部品も同じ番号の `VERSION` を持ちます（`WitGas.lock.VERSION` など）。
- 版を上げるときは、`src/` のファイルを入れ替えるだけです。部品は手で直さないでください（先方ごとの手直しは見本の `main.js` に書く）。
- 引き継ぎ書の「版」の欄に、入っている部品と版が出ます。部品集の版と違う部品には印がつくので、入れ替え忘れに気づけます。
- 考え方は [docs/design/versioning.md](docs/design/versioning.md) にあります。

## 権限（oauthScopes）

`appsscript.json` の `oauthScopes` を明示し、必要なものだけを並べます。部品を追加するたびに、ここに理由を書きます。

| 権限 | 使う部品 | 理由 |
|------|----------|------|
| （追加なし） | `WitGas.settings`・`WitGas.migrate` | 設定シートは開いているスプレッドシート（`spreadsheets.currentonly` で足りる見込み）、スキーマの版はスクリプトのプロパティ |
| （追加なし） | `WitGas.handover` | トリガーの一覧に `script.scriptapp`、書き込みとほかのスプレッドシートを開くのに `spreadsheets` を使う（どちらもこの表のほかの行にあるもの）。`script.scriptapp` がなければトリガーは「読めなかった」と書く。承認済みの権限を読むのに追加の権限は要らない想定（実機確認は H2） |
| （追加なし） | `WitGas.guard` | 中で使う部品（lock・runlog・notify）の権限だけ。`log: false` なら `spreadsheets`、`notify: false` なら `script.send_mail` は要らない |
| （なし） | `WitGas.lock` | `LockService` と `console` だけを使う。追加の権限を求めない想定（実機確認は L1） |
| `https://www.googleapis.com/auth/script.scriptapp` | `WitGas.resume` | 続きを動かすトリガーを作る・消す（`ScriptApp`）。カーソルの保存（`PropertiesService`）は追加の権限を求めない想定（実機確認は R8） |
| `https://www.googleapis.com/auth/spreadsheets` | `WitGas.runlog`・`WitGas.reconcile` | 指定した ID のスプレッドシートを開いて書く（`SpreadsheetApp.openById`）。`reconcile.compare` だけなら権限は要らない（`writeReport` で使う） |
| `https://www.googleapis.com/auth/script.send_mail` | `WitGas.notify` | 失敗を知らせるメールを送る（`MailApp`）。`CacheService`・`Utilities`・`Session` は追加の権限を求めない想定（実機確認は N1） |

使わない部品の権限は外してかまいません。
`runlog` を、スクリプトが付いたスプレッドシートにだけ書く（`spreadsheetId` を渡さない）場合は、
`spreadsheets` の代わりに `https://www.googleapis.com/auth/spreadsheets.currentonly` で足りる見込みです（実機確認は W7）。

## 止め方

- `WitGas.lock` はトリガーも保存データも作りません。`WitGas.reconcile` も作りません（「照合結果」シートは消してかまいません）。
- `WitGas.resume` の途中で止めるには、スクリプトエディタで `WitGas.resume.cleanup('<key>')` を呼ぶ関数を実行します。
  手で止める場合は、「トリガー」画面から続きのトリガー（関数名が `handler`、1 回だけ動くもの）を消し、
  「プロジェクトの設定 → スクリプト プロパティ」から `WitGas.resume:<key>` を消します。
  トリガーだけを消すと、次に `run` が呼ばれたときにカーソルの続きから動きます。
- `WitGas.handover` はトリガーもスクリプトのプロパティも作りません。「引き継ぎ書」シートは消してかまいません。
- `WitGas.guard` はトリガーもスクリプトのプロパティも作りません（中で `resume` を使う場合は、上の `resume` の止め方に従ってください）。
- `WitGas.runlog` と `WitGas.notify` は、トリガーもスクリプトのプロパティも作りません。
  記録をやめるには呼んでいる行を消し、通知の宛先を変えるには `opts.to` を変えます。「実行記録」シートは消しても次に書くときに作り直されます。
- どの場合も、毎日など決まった時刻に呼んでいるトリガーは利用者が作ったものです。完全に止めるならそれも消してください。

## 開発

```bash
npm test
```

- テストは Node の `node:test` で動きます（Node 22 以上。外部パッケージなし）。
- `test/mocks/` に GAS のサービスの偽物と偽の時計があり、`test/helpers/gas-env.js` が `src/` を GAS と同じく 1 つの共有グローバルに読み込みます。
- GitHub Actions（`.github/workflows/test.yml`）でも同じテストを回します。
- 見本は `examples/<名前>/` にあり、`test/examples/` で、見本が使う部品と見本のソースだけを読み込んでテストします。
- `npm run example:build -- <名前>` で、見本を GAS に送れる形（`dist/<名前>/`）にまとめます。
- 実機での確認手順と結果は [docs/manual-check.md](docs/manual-check.md) にあります。

## ライセンス

MIT ライセンスです（[LICENSE](LICENSE)）。

© 2026 株式会社wi-t.com
