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
function setup() {
  const env = createGasEnv({ files: PARTS, extra: [EXAMPLE + '/main.js'] });
  const ss = env.SpreadsheetApp.addSpreadsheet('BOOK', { active: true });
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
    ['見本のデータを入れる', 'setupCsvReconcileSample']
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

test('CSV の見出しが違う（列がない）ときは失敗として記録し、メールで知らせてからエラーを投げる', () => {
  const { env, ss, values, run } = setup();
  env.context.setupCsvReconcileSample();
  const sheet = ss.getSheetByName('CSV貼り付け');
  sheet.getRange(1, 3, 1, 1).setValues([['振込額']]);
  assert.throws(run, /column "入金額" not found/);
  const log = values('実行記録');
  assert.deepEqual(Array.from(log[1].slice(2, 6)), ['CSV照合', '失敗', '', 'Error']);
  assert.equal(env.MailApp.sent.length, 1);
  assert.equal(env.MailApp.sent[0].to, 'ops@example.com');
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

test('グローバルに増やす名前は WitGas と見本の関数だけ', () => {
  const { env } = setup();
  assert.deepEqual(env.addedGlobals().sort(), [
    'CSV_RECONCILE', 'WitGas', 'csvReconcileAlert_', 'csvReconcileReadTable_',
    'onOpen', 'runCsvReconcile', 'setupCsvReconcileSample'
  ]);
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
