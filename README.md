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
| `WitGas.resume` | 6 分の上限の前に区切って続きを実行 | 実装済み（Node のテストのみ。実機確認は未） |
| `WitGas.runlog` / `WitGas.notify` | 実行記録とエラー通知 | 実装済み（Node のテストのみ。実機確認は未） |
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

ライブラリ経由のときに、ロック・スクリプトのプロパティ・トリガーがどのプロジェクトのものになるかは、実機で確認してから書きます（[docs/manual-check.md](docs/manual-check.md) の L8・R7）。
確実に呼び出し側のものを使いたい場合は、呼び出し側から渡してください。

```js
WitGas.lock.run('集計', fn, { lock: LockService.getScriptLock() });
WitGas.resume.run({ /* ... */ properties: PropertiesService.getScriptProperties(), scriptApp: ScriptApp });
```

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
| `onSkip` | なし | スキップしたときに呼ぶ関数。`{name, result:'skipped', reason:'locked', startedAt, endedAt}` を受け取る。実行記録シート（`WitGas.runlog`）につなぐ入口。 |
| `lock` | `LockService.getScriptLock()` | 使うロック。`tryLock(ms)` と `releaseLock()` を持つもの。 |

### 決まりごと

- スキップすると、実行ログ（`console.log`）に `[WitGas.lock] skipped: <処理名> (locked)` と残ります。
- ログに残すのは処理名とエラー種別だけです。**処理名に個人情報や業務データを入れないでください。**
- `fn` は同期関数にしてください。`Promise` を返すとロックが先に外れるため、エラーにします。
- 処理は成功したのにロックの解放に失敗したときは、解放のエラーを投げます（ロックが残ると次の回がすべてスキップされるため、成功扱いにしません）。
- 処理の失敗と解放の失敗が重なったときは、処理のエラーを投げ、解放の失敗はログに残します。

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

`resume` 自体は二重実行を防ぎません。上の例のように `WitGas.lock.run` の中で呼んでください。

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

`{ done, cursor, processed, runs, scheduled, elapsedMs }`

- `done`：最後まで終わったら `true`。続きがあれば `false`（実行記録の「続きあり」）。
- `cursor`：次に処理する位置。`processed`：この回に処理した数。`runs`：何回目の実行か。
- `scheduled`：続きのトリガーを張ったら `true`。

### 区切り方

- 次の 1 件が「この回で一番長くかかった 1 件」と同じだけかかっても上限に収まるときだけ、次へ進みます。
- 時間は `run` を呼んだときから数えます。前に時間のかかる準備をするなら、その分 `budgetMs` を小さくしてください。
- 1 回の実行で最低 1 件は進めます（1 件が上限より長くても、進まないままトリガーが続くことはありません）。
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

### ロックとぶつかったとき

スクリプトロックはプロジェクト全体で 1 つです。続きの回がほかの処理とぶつかって `lock.run` がスキップすると、その回は何もしません。
カーソルは残っているので、次に `run` が呼ばれたとき（毎日のトリガーや手動）に続きから進みます。
すぐに続けたい場合は `lock.run` の `waitMs` を指定してください（待った時間も 6 分に含まれます）。

### 保存するもの

スクリプトのプロパティ `WitGas.resume:<key>` に、次の JSON を保存します。業務データは入りません。

```json
{"v":1,"cursor":4,"runs":1,"firstStartedAt":1767571200000,"triggerId":"1234567890"}
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

### 決まりごと

- `=`・`+`・`-`・`@` で始まる文字は、式として読まれないよう先頭に `'` をつけます。
- 今あるシートの見出しは書き直しません（列の並びは上の表のまま使ってください）。
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

## 権限（oauthScopes）

`appsscript.json` の `oauthScopes` を明示し、必要なものだけを並べます。部品を追加するたびに、ここに理由を書きます。

| 権限 | 使う部品 | 理由 |
|------|----------|------|
| （なし） | `WitGas.lock` | `LockService` と `console` だけを使う。追加の権限を求めない想定（実機確認は L1） |
| `https://www.googleapis.com/auth/script.scriptapp` | `WitGas.resume` | 続きを動かすトリガーを作る・消す（`ScriptApp`）。カーソルの保存（`PropertiesService`）は追加の権限を求めない想定（実機確認は R8） |

| `https://www.googleapis.com/auth/spreadsheets` | `WitGas.runlog` | 指定した ID のスプレッドシートを開いて書く（`SpreadsheetApp.openById`） |
| `https://www.googleapis.com/auth/script.send_mail` | `WitGas.notify` | 失敗を知らせるメールを送る（`MailApp`）。`CacheService`・`Utilities`・`Session` は追加の権限を求めない想定（実機確認は N1） |

使わない部品の権限は外してかまいません。
`runlog` を、スクリプトが付いたスプレッドシートにだけ書く（`spreadsheetId` を渡さない）場合は、
`spreadsheets` の代わりに `https://www.googleapis.com/auth/spreadsheets.currentonly` で足りる見込みです（実機確認は W7）。

## 止め方

- `WitGas.lock` はトリガーも保存データも作りません。
- `WitGas.resume` の途中で止めるには、スクリプトエディタで `WitGas.resume.cleanup('<key>')` を呼ぶ関数を実行します。
  手で止める場合は、「トリガー」画面から続きのトリガー（関数名が `handler`、1 回だけ動くもの）を消し、
  「プロジェクトの設定 → スクリプト プロパティ」から `WitGas.resume:<key>` を消します。
  トリガーだけを消すと、次に `run` が呼ばれたときにカーソルの続きから動きます。
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
- 実機での確認手順と結果は [docs/manual-check.md](docs/manual-check.md) にあります。

© 2026 株式会社wi-t.com
