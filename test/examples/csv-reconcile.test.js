'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGasEnv } = require('../helpers/gas-env');
const { build } = require('../../scripts/build-example');

const EXAMPLE = 'examples/csv-reconcile';
const PARTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', EXAMPLE, 'parts.json'), 'utf8'));

/** 見本が使う部品（parts.json）と見本のソースだけを読み込み、スプレッドシートに付いたスクリプトとして動かす */
function setup(options) {
  const env = createGasEnv({ files: PARTS, extra: [EXAMPLE + '/main.js'] });
  const ss = env.SpreadsheetApp.addSpreadsheet('BOOK', { active: true });
  if (!(options && options.noMigrate)) env.context.migrateCsvReconcile(); // 「設定と表を用意する」
  env.SpreadsheetApp.ui.alerts.length = 0;
  const values = (name) => {
    const s = ss.getSheetByName(name);
    return s ? s.values() : null;
  };
  return { env, ss, values, run: () => env.context.runCsvReconcile() };
}

test('開くと「照合」メニューを足す', () => {
  const { env } = setup();
  env.context.onOpen();
  const menu = env.SpreadsheetApp.ui.menus[0];
  assert.equal(menu.title, '照合');
  assert.deepEqual(menu.items.filter((i) => !i.separator).map((i) => [i.caption, i.functionName]), [
    ['照合する', 'runCsvReconcile'],
    ['設定と表を用意する（版上げのときも）', 'migrateCsvReconcile'],
    ['点検する', 'checkCsvReconcile'],
    ['見本のデータを入れる', 'setupCsvReconcileSample'],
    ['引き継ぎ書を作る', 'writeCsvReconcileHandover']
  ]);
  for (const i of menu.items) {
    if (i.functionName) assert.equal(typeof env.context[i.functionName], 'function', i.functionName);
  }
});

test('見本のデータで照合すると、照合結果・実行記録・画面の知らせが出る', () => {
  const { env, ss, values, run } = setup();
  assert.equal(env.context.setupCsvReconcileSample(), true);
  const res = run();

  const summary = '一致 2 / 不一致 2 / 会計だけ 1 / 銀行だけ 1 / キー重複 0 / キーなし 0';
  assert.equal(res.status, 'success');
  assert.equal(res.value, summary);

  const report = values('照合結果');
  assert.deepEqual(Array.from(report[1].slice(0, 3)), ['表', '会計：5 行', '銀行：5 行']);
  assert.deepEqual(report.slice(11).map((r) => Array.from(r)), [
    ['不一致', 'INV-002', 3, 3, '入金日', report[11][5], '2026/1/7'],
    ['不一致', 'INV-004', 5, 4, '金額 / 入金額', 220000, '200,000'],
    ['会計だけ', 'INV-003', 4, '', '', '', ''],
    ['銀行だけ', 'INV-006', '', 6, '', '', '']
  ]);
  assert.equal(typeof report[11][5].getTime, 'function', '会計の入金日はシートの日付のまま');

  const log = values('実行記録');
  assert.deepEqual(Array.from(log[1].slice(2)), ['CSV照合', '成功', 5, '', summary]);
  assert.ok(!JSON.stringify(log).includes('サンプル商店'), '実行記録に業務データが入らない');

  assert.deepEqual(ss.toasts.map((t) => t.message).slice(-1), [summary]);
  assert.equal(env.MailApp.sent.length, 0);
});

test('もう一度照合すると、照合結果を書き直し、実行記録は 1 行増える', () => {
  const { env, values, run } = setup();
  env.context.setupCsvReconcileSample();
  run();
  run();
  assert.equal(values('照合結果').length, 15);
  assert.equal(values('実行記録').length, 3);
});

test('CSV がまだ取り込まれていなければ、画面で知らせて何もしない（通知も記録もしない）', () => {
  const { env, ss, values, run } = setup();
  env.context.setupCsvReconcileSample();
  ss.getSheetByName('CSV貼り付け').clearContents();
  assert.equal(run(), null);
  assert.match(env.SpreadsheetApp.ui.alerts[0], /「会計」と「CSV貼り付け」に、見出しのある表を入れてから/);
  assert.equal(values('実行記録'), null);
  assert.equal(values('照合結果'), null);
  assert.equal(env.MailApp.sent.length, 0);
});

test('画面がないところ（エディタ・トリガー）から動かしたときは、知らせをログに出す', () => {
  const { env, run } = setup();
  env.SpreadsheetApp.withoutUi();
  assert.equal(run(), null);
  assert.ok(env.logs.some((l) => l.message.startsWith('[CSV照合] 「会計」と「CSV貼り付け」')));
});

test('CSV の見出しに列がないときは、日本語で知らせ、失敗として記録してメールで知らせる（投げない）', () => {
  const { env, ss, values, run } = setup();
  env.context.setupCsvReconcileSample();
  ss.getSheetByName('CSV貼り付け').getRange(1, 3, 1, 1).setValues([['振込額']]);
  const res = run();
  assert.deepEqual({ ...res }, { status: 'failure', errorType: 'CsvFormatError' });
  assert.deepEqual(env.SpreadsheetApp.ui.alerts, [
    '「CSV貼り付け」の見出し（1 行目）に「入金額」がありません。CSV の形式（1 行目の列名）を確かめてください。'
  ]);
  const log = values('実行記録');
  assert.deepEqual(Array.from(log[1].slice(2, 6)), ['CSV照合', '失敗', '', 'CsvFormatError']);
  assert.equal(env.MailApp.sent.length, 1);
  assert.equal(env.MailApp.sent[0].subject, '[WitGas] 失敗: CSV照合 (CsvFormatError)');
  assert.equal(values('照合結果'), null);
});

test('会計側の見出しが足りないときも、どちらのシートの何が足りないかを知らせる', () => {
  const { env, ss, run } = setup();
  env.context.setupCsvReconcileSample();
  ss.getSheetByName('会計').getRange(1, 1, 1, 1).setValues([['番号']]);
  ss.getSheetByName('CSV貼り付け').getRange(1, 4, 1, 1).setValues([['日付']]);
  run();
  assert.deepEqual(env.SpreadsheetApp.ui.alerts[0].split('\n'), [
    '「会計」の見出し（1 行目）に「請求番号」がありません。',
    '「CSV貼り付け」の見出し（1 行目）に「入金日」がありません。CSV の形式（1 行目の列名）を確かめてください。'
  ]);
});

test('見出しの間違い以外の失敗は投げ直す（「実行数」画面に失敗として残す）', () => {
  const { env, ss, values, run } = setup();
  env.context.setupCsvReconcileSample();
  ss.insertSheet('照合結果').appendRow(['先方のメモ']); // 照合結果のシート名がほかの用途で使われている
  assert.throws(run, /not a reconcile report/);
  assert.equal(values('実行記録')[1][3], '失敗');
  assert.equal(env.MailApp.sent.length, 1);
  assert.deepEqual(env.SpreadsheetApp.ui.alerts, []);
});

test('ほかの照合が動いているときは動かさず、画面で知らせて「スキップ」を残す', () => {
  const { env, ss, values, run } = setup();
  env.context.setupCsvReconcileSample();
  env.LockService.holdByOther();
  const res = run();
  assert.equal(res.status, 'skipped');
  assert.match(ss.toasts.slice(-1)[0].message, /ほかの照合が動いている/);
  assert.equal(values('実行記録')[1][3], 'スキップ');
  assert.equal(values('照合結果'), null);
});

test('見本のデータは、会計・CSV貼り付けにデータがあれば入れない', () => {
  const { env, ss } = setup();
  const s = ss.insertSheet('会計');
  s.appendRow(['先方のデータ']);
  assert.equal(env.context.setupCsvReconcileSample(), false);
  assert.match(env.SpreadsheetApp.ui.alerts[0], /「会計」にデータがあるため/);
  assert.deepEqual(s.values(), [['先方のデータ']]);
  assert.equal(ss.getSheetByName('CSV貼り付け'), null);
});

test('見本のデータの CSV 側は文字のまま入れる（書式を @ にしてから書く）', () => {
  const { env, ss } = setup();
  env.context.setupCsvReconcileSample();
  const formats = ss.getSheetByName('CSV貼り付け')._meta.formats;
  assert.deepEqual(formats.map((f) => [f.row, f.col, f.numRows, f.numCols, f.fmt]), [[1, 1, 6, 4, '@']]);
});

test('グローバルに増やす名前は WitGas と、見本の接頭辞のついた名前とメニューの関数だけ', () => {
  const { env } = setup();
  const menu = ['onOpen', 'runCsvReconcile', 'migrateCsvReconcile', 'checkCsvReconcile', 'setupCsvReconcileSample', 'writeCsvReconcileHandover'];
  for (const name of env.addedGlobals()) {
    assert.ok(name === 'WitGas' || name.startsWith('CSV_RECONCILE') || name.startsWith('csvReconcile') || menu.includes(name), name);
  }
});

test('npm run example:build は、GAS に送るファイルだけを dist にまとめる', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'witgas-build-'));
  try {
    const res = build('csv-reconcile', out);
    const files = res.files.slice().sort();
    assert.deepEqual(files, ['appsscript.json', 'main.js'].concat(PARTS.map((p) => path.join('witgas', p))).sort());
    const manifest = JSON.parse(fs.readFileSync(path.join(res.outDir, 'appsscript.json'), 'utf8'));
    assert.deepEqual(manifest.oauthScopes, [
      'https://www.googleapis.com/auth/spreadsheets.currentonly',
      'https://www.googleapis.com/auth/script.container.ui',
      'https://www.googleapis.com/auth/script.send_mail'
    ]);
    assert.throws(() => build('../src', out), /example name is required/);
    assert.throws(() => build('nothing-here', out), /no such example/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('実行記録を初めて作るとき、このスプレッドシートのタイムゾーンをスクリプトに合わせる（新しいファイルは太平洋時間のことがある）', () => {
  const env = createGasEnv({ files: PARTS, extra: [EXAMPLE + '/main.js'] });
  const ss = env.SpreadsheetApp.addSpreadsheet('BOOK', { active: true, timeZone: 'America/Los_Angeles' });
  env.context.setupCsvReconcileSample();
  env.context.runCsvReconcile();
  assert.equal(ss.getSpreadsheetTimeZone(), 'Asia/Tokyo');
});

// ---- 版・設定・移行 ----

const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', EXAMPLE, 'appsscript.json'), 'utf8'));

function setSetting(ss, key, value) {
  const sheet = ss.getSheetByName('設定');
  const row = sheet.values().findIndex((r) => r[0] === key);
  assert.ok(row > 0, key);
  sheet.getRange(row + 1, 2, 1, 1).setValues([[value]]);
}

test('「設定と表を用意する」：設定シート（13 項目）を作り、スキーマの版を 1 にする。何度動かしても同じ', () => {
  const { env, ss, values } = setup({ noMigrate: true });
  env.context.migrateCsvReconcile();
  assert.equal(env.PropertiesService.dump()['WitGas.schema:csvReconcile'], '1');
  assert.deepEqual(Array.from(values('設定')[0]), ['項目', '値', '説明']);
  assert.equal(values('設定').length, 14);
  assert.match(env.SpreadsheetApp.ui.alerts[0], /設定を用意しました（スキーマの版 0 → 1）/);
  setSetting(ss, '呼び名（CSV）', '信金');
  env.context.migrateCsvReconcile();
  assert.match(env.SpreadsheetApp.ui.alerts[1], /もう用意されています（スキーマの版 1）/);
  assert.equal(values('設定').find((r) => r[0] === '呼び名（CSV）')[1], '信金');
});

test('前の形（版番号なし）からの版上げ：コードを入れ替えたあと、用意する前に照合すると知らせ、用意すれば元のデータのまま照合できる', () => {
  const { env, ss, values, run } = setup({ noMigrate: true });
  // 前の形で使っていたスプレッドシート：会計・CSV貼り付け・照合結果・実行記録があり、設定とスキーマの版はない
  const l = ss.insertSheet('会計');
  l.appendRow(['請求番号', '取引先', '金額', '入金日']);
  l.appendRow(['INV-001', '見本商店', 1000, '2026/1/5']);
  const r = ss.insertSheet('CSV貼り付け');
  r.appendRow(['請求番号', '振込名義', '入金額', '入金日']);
  r.appendRow(['INV-001', 'ﾐﾎﾝ', '1,000', '2026/1/5']);
  ss.insertSheet('実行記録').appendRow(['開始', '終了', '処理名', '結果', '件数', 'エラー種別', 'メッセージ']);

  assert.equal(run(), null);
  assert.match(env.SpreadsheetApp.ui.alerts[0], /設定がまだ用意されていません（版上げの途中かもしれません）/);
  env.context.migrateCsvReconcile();
  const res = run();
  assert.equal(res.status, 'success');
  assert.equal(res.value, '一致 1 / 不一致 0 / 会計だけ 0 / 銀行だけ 0 / キー重複 0 / キーなし 0');
  assert.deepEqual(Array.from(values('会計')[1]), ['INV-001', '見本商店', 1000, '2026/1/5'], '元のデータは変わらない');
  const check = env.context.checkCsvReconcile();
  assert.deepEqual(Array.from(check.problems), ['「失敗の通知先」が見本のまま（ops@example.com）です。先方の担当のアドレスに変えてください。'],
    '前の形のコードにあった通知先は設定シートに入れ直す必要がある');
});

test('設定シートの値で、キー・比べる列・列の対応・呼び名を変えられる（コードは変えない）', () => {
  const { ss, values, run } = setup();
  setSetting(ss, 'キーの列', '伝票番号');
  setSetting(ss, '比べる列', '額');
  setSetting(ss, '列の対応', '伝票番号=番号、額=振込額');
  setSetting(ss, '数の列', '額');
  setSetting(ss, '日付の列', '');
  setSetting(ss, '呼び名（CSV）', '信金');
  ss.insertSheet('会計').appendRow(['伝票番号', '額']);
  ss.getSheetByName('会計').appendRow(['D-1', 500]);
  ss.getSheetByName('会計').appendRow(['D-2', 700]);
  ss.insertSheet('CSV貼り付け').appendRow(['番号', '振込額']);
  ss.getSheetByName('CSV貼り付け').appendRow(['D-1', '500']);
  const res = run();
  assert.equal(res.value, '一致 1 / 不一致 0 / 会計だけ 1 / 信金だけ 0 / キー重複 0 / キーなし 0');
  assert.ok(values('照合結果').some((row) => row[0] === '会計だけ' && row[1] === 'D-2'));
});

test('設定の値がおかしいときは、日本語で知らせて何もしない（項目名だけで、値は出さない）', () => {
  const { env, ss, values, run } = setup();
  env.context.setupCsvReconcileSample();
  const cases = [
    ['列の対応', '金額 入金額', '「設定」シートの「列の対応」は「会計の列名=CSV の列名」をカンマで区切って書いてください。'],
    ['数の列', '値引き', '「設定」シートの「数の列」には「キーの列」か「比べる列」にある列名を書いてください。'],
    ['比べる列', '', '「設定」シートの「比べる列」が空です。'],
    ['失敗の通知先', '山田太郎', '「設定」シートの「失敗の通知先」の値がメールアドレスになっていません。']
  ];
  for (const [key, value, message] of cases) {
    const keep = values('設定').find((r) => r[0] === key)[1];
    setSetting(ss, key, value);
    assert.equal(run(), null, key);
    assert.equal(env.SpreadsheetApp.ui.alerts.slice(-1)[0], message + '「設定」シートを直してから、もう一度実行してください。');
    setSetting(ss, key, keep);
  }
  assert.equal(values('実行記録'), null);
  assert.equal(env.MailApp.sent.length, 0);
});

test('点検：通知先を変えていれば問題なし。見出しの不足やスキーマの版の違いを並べる（直しはしない）', () => {
  const { env, ss } = setup();
  env.context.setupCsvReconcileSample();
  setSetting(ss, '失敗の通知先', 'team@example.jp');
  const ok = env.context.checkCsvReconcile();
  assert.equal(ok.ok, true);
  assert.match(env.SpreadsheetApp.ui.alerts.slice(-1)[0], /点検：問題は見つかりませんでした（CSV照合（csv-reconcile） 1\.0\.0、スキーマの版 1）/);

  ss.getSheetByName('CSV貼り付け').getRange(1, 3, 1, 1).setValues([['振込額']]);
  env.PropertiesService.getScriptProperties().setProperty('WitGas.schema:csvReconcile', '0');
  const ng = env.context.checkCsvReconcile();
  assert.deepEqual(Array.from(ng.problems), [
    'スキーマの版が 0 です（この版のコードは 1）。「設定と表を用意する」を実行してください。',
    '「CSV貼り付け」の見出し（1 行目）に「入金額」がありません。CSV の形式（1 行目の列名）を確かめてください。'
  ]);
});

test('引き継ぎ書：見本の名前と版、権限（appsscript.json と同じ）、設定値。トリガーは読まない', () => {
  const { env, ss } = setup();
  env.ScriptApp.setAuthorizedScopes(MANIFEST.oauthScopes);
  env.ScriptApp.failNextGetTriggers(new Error('should not be called'));
  const res = env.context.writeCsvReconcileHandover();
  assert.deepEqual(Array.from(res.notes), []);
  const v = ss.getSheetByName('引き継ぎ書').values().map((r) => Array.from(r));
  const changelog = fs.readFileSync(path.join(__dirname, '..', '..', EXAMPLE, 'CHANGELOG.md'), 'utf8');
  const top = changelog.match(/^## (\d+\.\d+\.\d+)/m)[1];
  assert.equal(env.context.CSV_RECONCILE_VERSION, top);
  assert.ok(v.some((r) => r[0] === 'CSV照合（csv-reconcile）' && r[1] === top));
  assert.ok(v.some((r) => r[0] === '（出していない：この見本・納品物はトリガーを使わないため、一覧を読む権限を持たない）'));
  assert.deepEqual(Array.from(env.context.CSV_RECONCILE_SCOPES, (x) => x.scope), MANIFEST.oauthScopes);
  assert.ok(v.filter((r) => MANIFEST.oauthScopes.includes(r[0])).every((r) => r[2] === 'はい'));
  assert.ok(v.some((r) => r[0] === '設定：キーの列' && r[1] === '請求番号'));
});
