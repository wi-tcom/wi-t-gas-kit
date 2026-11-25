'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnv } = require('./helpers/gas-env');

const HEADER = ['開始', '終了', '処理名', '結果', '件数', 'エラー種別', 'メッセージ'];

function setup(options) {
  const env = createGasEnv(options);
  const ss = env.SpreadsheetApp.addSpreadsheet('SS1');
  const opts = { spreadsheetId: 'SS1' };
  const sheet = () => ss.getSheetByName('実行記録');
  return { env, ss, opts, sheet };
}

/** 日付を数値にして比べやすくする */
function plain(rows) {
  return Array.from(rows, (r) => Array.from(r, (v) => (v && typeof v.getTime === "function" ? v.getTime() : v)));
}

test('シートがなければ「実行記録」を作り、見出しを太字にして 1 行目を固定する', () => {
  const { env, opts, sheet } = setup();
  const res = env.WitGas.runlog.append({ name: '日次集計', result: 'success', count: 12 }, opts);
  const s = sheet();
  assert.ok(s);
  assert.deepEqual(s.values()[0], HEADER);
  assert.equal(s.getFrozenRows(), 1);
  assert.deepEqual(s._meta.fontWeights.map((f) => [f.row, f.numCols, f.w]), [[1, 7, 'bold']]);
  assert.deepEqual({ ...res }, { row: 2, trimmed: 0, timeZoneMismatch: false, timeZoneChanged: false });
  assert.deepEqual([...env.WitGas.runlog.HEADER], HEADER);
  assert.deepEqual({ ...s._meta.columnWidths }, { 1: 150, 2: 150, 3: 160, 4: 80, 5: 60, 6: 120, 7: 300 },
    '日時が切れて見えない幅にする（実機確認 W2）');
});

test('1 実行 1 行：開始・終了・処理名・結果・件数・エラー種別・メッセージ', () => {
  const { env, opts, sheet } = setup();
  const t0 = env.clock.now();
  const startedAt = new env.context.Date(t0);
  env.clock.advance(5000);
  env.WitGas.runlog.append({ name: '日次集計', result: 'success', startedAt, count: 12, message: 'cursor 4' }, opts);
  assert.deepEqual(plain(sheet().values())[1], [t0, t0 + 5000, '日次集計', '成功', 12, '', 'cursor 4']);
  // 日付の列に表示形式をつける
  assert.deepEqual(sheet()._meta.formats.map((f) => [f.row, f.col, f.numCols, f.fmt]), [[2, 1, 2, 'yyyy-mm-dd hh:mm:ss']]);
});

test('結果は 成功／失敗／スキップ／続きあり で書く', () => {
  const { env, opts, sheet } = setup();
  for (const result of ['success', 'failure', 'skipped', 'continued']) {
    env.WitGas.runlog.append({ name: 'x', result }, opts);
  }
  assert.deepEqual(sheet().values().slice(1).map((r) => r[3]), ['成功', '失敗', 'スキップ', '続きあり']);
});

test('終了を省けば今、開始を省けば終了と同じ', () => {
  const { env, opts, sheet } = setup();
  env.WitGas.runlog.append({ name: 'x', result: 'success' }, opts);
  const row = plain(sheet().values())[1];
  assert.equal(row[0], env.clock.now());
  assert.equal(row[1], env.clock.now());
  assert.equal(row[4], '', '件数を省けば空');
});

test('error を渡すと種別だけを書き、エラーのメッセージは書かない', () => {
  const { env, opts, sheet } = setup();
  const err = new TypeError('顧客 山田太郎 の行で失敗');
  env.WitGas.runlog.append({ name: '請求書PDF', result: 'failure', error: err }, opts);
  const row = sheet().values()[1];
  assert.equal(row[5], 'TypeError');
  assert.ok(!JSON.stringify(sheet().values()).includes('山田'));
});

test('errorType を直接渡せばそれを使う', () => {
  const { env, opts, sheet } = setup();
  env.WitGas.runlog.append({ name: 'x', result: 'failure', errorType: 'Timeout', error: new Error('e') }, opts);
  assert.equal(sheet().values()[1][5], 'Timeout');
});

test('メッセージは改行をなくし 100 文字までに切る', () => {
  const { env, opts, sheet } = setup();
  env.WitGas.runlog.append({ name: 'x', result: 'success', message: 'a\nb\r\nc' + 'z'.repeat(200) }, opts);
  const msg = sheet().values()[1][6];
  assert.equal(msg.length, 100);
  assert.ok(msg.startsWith('a b c'));
  assert.ok(msg.endsWith('…'));
});

test('= + - @ で始まる文字は式として読まれないように先頭に \' をつける', () => {
  const { env, opts, sheet } = setup();
  env.WitGas.runlog.append({ name: '=HYPERLINK("http://x")', result: 'success', message: '-1件' }, opts);
  const row = sheet().values()[1];
  assert.equal(row[2], '\'=HYPERLINK("http://x")');
  assert.equal(row[6], "'-1件");
});

test('今あるシートの見出しは書き直さない。空のシートなら見出しを書く', () => {
  const { env, ss, opts, sheet } = setup();
  const s = ss.insertSheet('実行記録');
  s.appendRow(['Start', 'End', 'Job', 'Result', 'Count', 'Type', 'Msg']);
  env.WitGas.runlog.append({ name: 'x', result: 'success' }, opts);
  assert.equal(sheet().values()[0][0], 'Start');
  assert.equal(sheet().values().length, 2);

  const empty = ss.insertSheet('空');
  env.WitGas.runlog.append({ name: 'x', result: 'success' }, { ...opts, sheetName: '空' });
  assert.deepEqual(empty.values()[0], HEADER);
});

test('行が上限を越えたら古い行から消す（見出しは残す）', () => {
  const { env, opts, sheet } = setup();
  for (let i = 1; i <= 5; i++) {
    env.WitGas.runlog.append({ name: 'job' + i, result: 'success' }, { ...opts, maxRows: 3 });
  }
  const values = sheet().values();
  assert.deepEqual(values[0], HEADER);
  assert.deepEqual(values.slice(1).map((r) => r[2]), ['job3', 'job4', 'job5']);
});

test('上限の既定は 5,000 行：5,000 行あるところに足すと、一番古い 1 行を消して 5,000 行のまま', () => {
  const { env, ss, opts, sheet } = setup();
  assert.equal(env.WitGas.runlog.DEFAULT_MAX_ROWS, 5000);
  const s = ss.insertSheet('実行記録');
  s.appendRow(HEADER);
  for (let i = 1; i <= 5000; i++) s.appendRow([0, 0, 'old' + i, '成功', '', '', '']);
  const res = env.WitGas.runlog.append({ name: 'new', result: 'success' }, opts);
  const values = sheet().values();
  assert.equal(values.length, 5001);
  assert.equal(values[1][2], 'old2');
  assert.equal(values[5000][2], 'new');
  assert.deepEqual({ ...res }, { row: 5001, trimmed: 1, timeZoneMismatch: false, timeZoneChanged: false });
  assert.deepEqual(s._meta.deleteCalls, [[2, 1]]);
});

test('上限まではシートの行を消さない', () => {
  const { env, opts, sheet } = setup();
  for (let i = 0; i < 3; i++) env.WitGas.runlog.append({ name: 'x', result: 'success' }, { ...opts, maxRows: 3 });
  assert.deepEqual(sheet()._meta.deleteCalls, []);
});

test('スプレッドシートは ID・オブジェクト・開いているもの（省略時）のどれでも指定できる', () => {
  const env = createGasEnv();
  const a = env.SpreadsheetApp.addSpreadsheet('A');
  const b = env.SpreadsheetApp.addSpreadsheet('B', { active: true });
  const c = env.SpreadsheetApp.addSpreadsheet('C');
  env.WitGas.runlog.append({ name: 'x', result: 'success' }, { spreadsheetId: 'A' });
  env.WitGas.runlog.append({ name: 'x', result: 'success' });
  env.WitGas.runlog.append({ name: 'x', result: 'success' }, { spreadsheet: c });
  for (const ss of [a, b, c]) assert.equal(ss.getSheetByName('実行記録').values().length, 2);
});

test('開いているスプレッドシートがなく ID もなければ投げる', () => {
  const env = createGasEnv();
  assert.throws(() => env.WitGas.runlog.append({ name: 'x', result: 'success' }), /no spreadsheet/);
});

test('引数がおかしいときはシートに触らずに投げる', () => {
  const { env, opts } = setup();
  const append = env.WitGas.runlog.append;
  const ok = { name: 'x', result: 'success' };
  const cases = [
    [undefined, opts],
    [{ ...ok, name: '' }, opts],
    [{ ...ok, name: 1 }, opts],
    [{ ...ok, result: 'ok' }, opts],
    [{ ...ok, result: undefined }, opts],
    [{ ...ok, result: 'toString' }, opts],
    [{ ...ok, count: -1 }, opts],
    [{ ...ok, count: 1.5 }, opts],
    [{ ...ok, count: '3' }, opts],
    [{ ...ok, startedAt: '2026-01-01' }, opts],
    [{ ...ok, endedAt: new Date(NaN) }, opts],
    [{ ...ok, message: 123 }, opts],
    [ok, { ...opts, maxRows: 0 }],
    [ok, { ...opts, maxRows: 2.5 }],
    [ok, { ...opts, sheetName: '' }],
    [ok, { spreadsheetId: '' }]
  ];
  for (const [entry, o] of cases) {
    assert.throws(() => append(entry, o), (e) => /Error$/.test(e.name) && /^WitGas\.runlog\.append:/.test(e.message),
      JSON.stringify([entry, o]));
  }
  assert.equal(env.SpreadsheetApp.calls.length, 0);
});

test('シートへの書き込みが失敗したらそのエラーを投げる', () => {
  const { env, ss, opts } = setup();
  const s = ss.insertSheet('実行記録');
  const err = new Error('Service Spreadsheets failed');
  s._appendError = err;
  assert.throws(() => env.WitGas.runlog.append({ name: 'x', result: 'success' }, opts), (e) => e === err);
});

test('記録先とスクリプトのタイムゾーンが違えば、実行ログに警告を出す（実機確認 W1）', () => {
  const env = createGasEnv();
  env.SpreadsheetApp.addSpreadsheet('LA', { timeZone: 'America/Los_Angeles' });
  const res = env.WitGas.runlog.append({ name: '日次集計', result: 'success' }, { spreadsheetId: 'LA' });
  assert.equal(res.timeZoneMismatch, true);
  assert.ok(env.logs.some((l) => l.level === 'warn' &&
    l.message === '[WitGas.runlog] time zone differs: spreadsheet America/Los_Angeles, script Asia/Tokyo (日次集計)'));
});

test('タイムゾーンが同じなら警告しない。タイムゾーンを返さないスプレッドシートでも止まらない', () => {
  const { env, opts } = setup();
  env.WitGas.runlog.append({ name: 'x', result: 'success' }, opts);
  assert.ok(!env.logs.some((l) => l.level === 'warn'));

  const rows = [];
  const fake = {
    getSheetByName: () => null,
    insertSheet: () => ({
      getLastRow: () => rows.length,
      getRange: () => ({ setValues: (v) => { rows.push(...v); return { setFontWeight() {} }; }, setNumberFormat() {} }),
      setFrozenRows() {},
      setColumnWidth() {},
      appendRow: (r) => rows.push(r),
      deleteRows() {}
    })
  };
  const res = env.WitGas.runlog.append({ name: 'x', result: 'success' }, { spreadsheet: fake });
  assert.equal(res.timeZoneMismatch, false);
  assert.equal(rows.length, 2);
});

test('matchTimeZone: true なら、実行記録のシートを新しく作るとき記録先のタイムゾーンをスクリプトに合わせてから書く（実機確認 W8）', () => {
  const env = createGasEnv();
  const ss = env.SpreadsheetApp.addSpreadsheet('NEW', { timeZone: 'America/Los_Angeles' });
  const res = env.WitGas.runlog.append({ name: '日次集計', result: 'success' }, { spreadsheetId: 'NEW', matchTimeZone: true });
  assert.equal(ss.getSpreadsheetTimeZone(), 'Asia/Tokyo');
  assert.equal(res.timeZoneChanged, true);
  assert.equal(res.timeZoneMismatch, false);
  assert.ok(env.logs.some((l) => l.level === 'log' &&
    l.message === '[WitGas.runlog] set spreadsheet time zone to Asia/Tokyo (was America/Los_Angeles) (日次集計)'));
  assert.ok(!env.logs.some((l) => l.level === 'warn'));
});

test('matchTimeZone: true でも、実行記録にもう行があれば記録先の設定は変えず、警告だけ出す', () => {
  const env = createGasEnv();
  const ss = env.SpreadsheetApp.addSpreadsheet('OLD', { timeZone: 'America/Los_Angeles' });
  const s = ss.insertSheet('実行記録');
  s.appendRow(HEADER);
  s.appendRow([0, 0, '前の記録', '成功', '', '', '']);
  const res = env.WitGas.runlog.append({ name: 'x', result: 'success' }, { spreadsheetId: 'OLD', matchTimeZone: true });
  assert.equal(ss.getSpreadsheetTimeZone(), 'America/Los_Angeles');
  assert.equal(res.timeZoneChanged, false);
  assert.equal(res.timeZoneMismatch, true);
  assert.ok(env.logs.some((l) => l.level === 'warn' && l.message.startsWith('[WitGas.runlog] time zone differs:')));
});

test('matchTimeZone の既定はオフ（先方のファイルの設定を勝手に変えない）', () => {
  const env = createGasEnv();
  const ss = env.SpreadsheetApp.addSpreadsheet('NEW', { timeZone: 'America/Los_Angeles' });
  env.WitGas.runlog.append({ name: 'x', result: 'success' }, { spreadsheetId: 'NEW' });
  assert.equal(ss.getSpreadsheetTimeZone(), 'America/Los_Angeles');
});

test('タイムゾーンを変えられなかったときは警告を出して書き続ける', () => {
  const env = createGasEnv();
  const ss = env.SpreadsheetApp.addSpreadsheet('NEW', { timeZone: 'America/Los_Angeles' });
  ss.setSpreadsheetTimeZone = () => { throw new Error('denied'); };
  const res = env.WitGas.runlog.append({ name: 'x', result: 'success' }, { spreadsheetId: 'NEW', matchTimeZone: true });
  assert.equal(res.timeZoneMismatch, true);
  assert.equal(res.row, 2);
  assert.ok(env.logs.some((l) => l.level === 'warn' && l.message === '[WitGas.runlog] could not set spreadsheet time zone (Error) (x)'));
});

test('matchTimeZone は真偽値だけ（validateOptions でも確かめる）', () => {
  const { env, opts } = setup();
  assert.throws(() => env.WitGas.runlog.append({ name: 'x', result: 'success' }, { ...opts, matchTimeZone: 'yes' }),
    /^TypeError: WitGas\.runlog\.append: opts\.matchTimeZone must be a boolean/);
  assert.throws(() => env.WitGas.runlog.validateOptions({ matchTimeZone: 1 }), /opts\.matchTimeZone must be a boolean/);
});
