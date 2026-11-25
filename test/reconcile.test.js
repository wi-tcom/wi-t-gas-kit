'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnv } = require('./helpers/gas-env');

/** vm の中で作られた配列・オブジェクトを、比べやすい普通の値にする */
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

const LEFT = [
  ['請求番号', '取引先', '金額', '備考'],
  ['A001', '山田商店', 1000, ''],
  ['A002', '佐藤工業', 2500, ''],
  ['A003', '鈴木物産', 3000, ''],
  ['A004', '田中建設', 4000, '']
];
const RIGHT = [
  ['請求番号', '取引先', '金額'],
  ['A001', '山田商店', 1000],
  ['A002', '佐藤工業', 2400],
  ['A004', '田中建設', 4000],
  ['A005', '高橋電機', 5000]
];

function summaryOf(r) {
  const s = plain(r.summary);
  return [s.matched, s.mismatched, s.leftOnly, s.rightOnly, s.duplicates, s.blankKey];
}

/** どの行もどれか 1 つの区分に入っているか（compare の外から数え直す） */
function assertEveryRowOnce(r) {
  const left = [];
  const right = [];
  r.matched.forEach((x) => { left.push(x.leftRow); right.push(x.rightRow); });
  r.mismatched.forEach((x) => { left.push(x.leftRow); right.push(x.rightRow); });
  r.leftOnly.forEach((x) => left.push(x.leftRow));
  r.rightOnly.forEach((x) => right.push(x.rightRow));
  r.duplicates.forEach((x) => { left.push(...x.leftRows); right.push(...x.rightRows); });
  r.blankKey.forEach((x) => (x.side === 'left' ? left : right).push(x.row));
  assert.equal(new Set(left).size, left.length, '左の行が重複して数えられていない');
  assert.equal(new Set(right).size, right.length, '右の行が重複して数えられていない');
  assert.equal(left.length, r.summary.leftRows);
  assert.equal(right.length, r.summary.rightRows);
}

test('キーで突き合わせ、一致・不一致・左だけ・右だけに分ける（行番号は見出しを 1 行目として数える）', () => {
  const env = createGasEnv();
  const r = env.WitGas.reconcile.compare(LEFT, RIGHT, { key: '請求番号' });
  assert.deepEqual(plain(r.columns), ['取引先', '金額'], '比べる列の既定は両方にある列（キーを除く）');
  assert.deepEqual(plain(r.matched), [
    { key: ['A001'], leftRow: 2, rightRow: 2 },
    { key: ['A004'], leftRow: 5, rightRow: 4 }
  ]);
  assert.deepEqual(plain(r.mismatched), [
    { key: ['A002'], leftRow: 3, rightRow: 3, diffs: [{ column: '金額', rightColumn: '金額', left: 2500, right: 2400 }] }
  ]);
  assert.deepEqual(plain(r.leftOnly), [{ key: ['A003'], leftRow: 4 }]);
  assert.deepEqual(plain(r.rightOnly), [{ key: ['A005'], rightRow: 5 }]);
  assert.deepEqual(summaryOf(r), [2, 1, 1, 1, 0, 0]);
  assert.equal(r.summary.leftRows, 4);
  assert.equal(r.summary.rightRows, 4);
  assertEveryRowOnce(r);
});

test('元の表は書き換えない', () => {
  const env = createGasEnv();
  const l = JSON.parse(JSON.stringify(LEFT));
  const rt = JSON.parse(JSON.stringify(RIGHT));
  env.WitGas.reconcile.compare(l, rt, { key: '請求番号', numberColumns: ['金額'], width: true });
  assert.deepEqual(l, LEFT);
  assert.deepEqual(rt, RIGHT);
});

test('複数列のキー', () => {
  const env = createGasEnv();
  const l = [['店', '日付', '売上'], ['渋谷', '1/5', 100], ['新宿', '1/5', 200], ['渋谷', '1/6', 300]];
  const r = [['店', '日付', '売上'], ['新宿', '1/5', 200], ['渋谷', '1/5', 150], ['渋谷', '1/7', 300]];
  const res = env.WitGas.reconcile.compare(l, r, { key: ['店', '日付'] });
  assert.deepEqual(plain(res.matched.map((x) => x.key)), [['新宿', '1/5']]);
  assert.deepEqual(plain(res.mismatched.map((x) => x.key)), [['渋谷', '1/5']]);
  assert.deepEqual(plain(res.leftOnly.map((x) => x.key)), [['渋谷', '1/6']]);
  assert.deepEqual(plain(res.rightOnly.map((x) => x.key)), [['渋谷', '1/7']]);
});

test('キーが重複した行は照合せず「キー重複」にまとめる（左・右・両方）', () => {
  const env = createGasEnv();
  const l = [['ID', '値'], ['1', 'a'], ['2', 'b'], ['2', 'b'], ['3', 'c'], ['4', 'd']];
  const r = [['ID', '値'], ['1', 'a'], ['2', 'b'], ['3', 'c'], ['3', 'x'], ['5', 'e'], ['5', 'e']];
  const res = env.WitGas.reconcile.compare(l, r, { key: 'ID' });
  assert.deepEqual(plain(res.duplicates), [
    { key: ['2'], leftRows: [3, 4], rightRows: [3] },
    { key: ['3'], leftRows: [5], rightRows: [4, 5] },
    { key: ['5'], leftRows: [], rightRows: [6, 7] }
  ]);
  assert.deepEqual(summaryOf(res), [1, 0, 1, 0, 3, 0]);
  assertEveryRowOnce(res);
});

test('キーが空の行は「キーなし」。すべて空の行は数えずに飛ばす', () => {
  const env = createGasEnv();
  const l = [['ID', '値'], ['1', 'a'], ['', 'b'], ['', ''], [], ['  ', 'c']];
  const r = [['ID', '値'], ['1', 'a'], [null, 'z'], ['', '']];
  const res = env.WitGas.reconcile.compare(l, r, { key: 'ID' });
  assert.deepEqual(plain(res.blankKey), [{ side: 'left', row: 3 }, { side: 'left', row: 6 }, { side: 'right', row: 3 }]);
  assert.equal(res.summary.leftRows, 3);
  assert.equal(res.summary.leftEmptyRows, 2);
  assert.equal(res.summary.rightEmptyRows, 1);
  assertEveryRowOnce(res);
});

test('比べる列を指定できる。列名が違う列は columnMap で対応させる（キーも）', () => {
  const env = createGasEnv();
  const l = [['伝票No', '金額', 'メモ'], ['1', 100, 'x']];
  const r = [['番号', '入金額', 'メモ'], ['1', 100, 'y']];
  const res = env.WitGas.reconcile.compare(l, r, { key: '伝票No', columnMap: { '伝票No': '番号', '金額': '入金額' } });
  assert.deepEqual(plain(res.columns), ['金額', 'メモ']);
  assert.deepEqual(plain(res.mismatched[0].diffs), [{ column: 'メモ', rightColumn: 'メモ', left: 'x', right: 'y' }]);

  const only = env.WitGas.reconcile.compare(l, r, { key: '伝票No', columns: ['金額'], columnMap: { '伝票No': '番号', '金額': '入金額' } });
  assert.equal(only.summary.matched, 1);
});

test('前後の空白は既定で無視する（全角の空白も）。trim: false なら区別する', () => {
  const env = createGasEnv();
  const l = [['ID', '名前'], [' 1 ', '山田　'], ['2', ' 佐藤']];
  const r = [['ID', '名前'], ['1', '山田'], ['2', '佐藤']];
  assert.equal(env.WitGas.reconcile.compare(l, r, { key: 'ID' }).summary.matched, 2);
  const strict = env.WitGas.reconcile.compare(l, r, { key: 'ID', trim: false });
  assert.deepEqual(summaryOf(strict), [0, 1, 1, 1, 0, 0]);
});

test('width: true なら全角と半角の違いを無視する（キーも）', () => {
  const env = createGasEnv();
  const l = [['ID', '名前'], ['Ａ０１', 'ｶﾞｽ']];
  const r = [['ID', '名前'], ['A01', 'ガス']];
  assert.equal(env.WitGas.reconcile.compare(l, r, { key: 'ID' }).summary.matched, 0);
  assert.equal(env.WitGas.reconcile.compare(l, r, { key: 'ID', width: true }).summary.matched, 1);
});

test('数の列：1000 と "1,000"・"¥1,000"・"1,000円"・"１，０００" を同じに、"△500"・"▲500" を -500 にする', () => {
  const env = createGasEnv();
  const l = [['ID', '金額'], ['1', 1000], ['2', 1000], ['3', 1000], ['4', 1000], ['5', -500], ['6', -500], ['7', 12.5]];
  const r = [['ID', '金額'], ['1', '1,000'], ['2', '¥1,000'], ['3', '1,000円'], ['4', '１，０００'], ['5', '△500'], ['6', '▲500'], ['7', '12.50']];
  const res = env.WitGas.reconcile.compare(l, r, { key: 'ID', numberColumns: ['金額'] });
  assert.equal(res.summary.matched, 7, JSON.stringify(plain(res.mismatched)));
});

test('数の列でなければ文字で比べる：1000 と "1000" は同じ、1000 と "1,000" は違う', () => {
  const env = createGasEnv();
  const l = [['ID', '金額'], ['1', 1000], ['2', 1000]];
  const r = [['ID', '金額'], ['1', '1000'], ['2', '1,000']];
  const res = env.WitGas.reconcile.compare(l, r, { key: 'ID' });
  assert.deepEqual(summaryOf(res), [1, 1, 0, 0, 0, 0]);
});

test('数として読めない値は文字のまま比べる', () => {
  const env = createGasEnv();
  const l = [['ID', '金額'], ['1', '未定'], ['2', '未定']];
  const r = [['ID', '金額'], ['1', '未定'], ['2', 0]];
  const res = env.WitGas.reconcile.compare(l, r, { key: 'ID', numberColumns: ['金額'] });
  assert.deepEqual(summaryOf(res), [1, 1, 0, 0, 0, 0]);
});

test('キーは数の列にしない限り文字で比べる（"001" と 1 は別のキー）', () => {
  const env = createGasEnv();
  const l = [['コード', '名'], ['001', 'a']];
  const r = [['コード', '名'], [1, 'a']];
  assert.equal(env.WitGas.reconcile.compare(l, r, { key: 'コード' }).summary.matched, 0);
  assert.equal(env.WitGas.reconcile.compare(l, r, { key: 'コード', numberColumns: ['コード'] }).summary.matched, 1);
});

test('日付の列：シートの日付と "2026/1/5"・"2026-01-05"・"2026年1月5日" を同じ日にする（スクリプトのタイムゾーンで）', () => {
  const env = createGasEnv();
  const jan5 = new env.context.Date(Date.UTC(2026, 0, 4, 15, 0, 0)); // 2026-01-05 00:00 JST
  const l = [['ID', '日付'], ['1', jan5], ['2', jan5], ['3', jan5], ['4', '２０２６／０１／０５'], ['5', jan5]];
  const r = [['ID', '日付'], ['1', '2026/1/5'], ['2', '2026-01-05'], ['3', '2026年1月5日'], ['4', '2026.1.5'], ['5', '2026/1/6']];
  const res = env.WitGas.reconcile.compare(l, r, { key: 'ID', dateColumns: ['日付'] });
  assert.deepEqual(summaryOf(res), [4, 1, 0, 0, 0, 0]);
  assert.deepEqual(plain(res.mismatched.map((x) => x.key)), [['5']]);

  const utc = env.WitGas.reconcile.compare(l, r, { key: 'ID', dateColumns: ['日付'], timeZone: 'UTC' });
  assert.equal(utc.summary.matched, 1, 'UTC で見ると 2026-01-04 になる（文字の 4 行目だけ一致）');
});

test('日付の列でなければ、日付は時刻まで含めて比べる', () => {
  const env = createGasEnv();
  const a = new env.context.Date(Date.UTC(2026, 0, 4, 15, 0, 0));
  const b = new env.context.Date(Date.UTC(2026, 0, 4, 15, 0, 0));
  const c = new env.context.Date(Date.UTC(2026, 0, 4, 16, 0, 0));
  const res = env.WitGas.reconcile.compare([['ID', 't'], ['1', a], ['2', a]], [['ID', 't'], ['1', b], ['2', c]], { key: 'ID' });
  assert.deepEqual(summaryOf(res), [1, 1, 0, 0, 0, 0]);
});

test('true と "TRUE"、空と null は同じ。行が短い（CSV の列が足りない）ときは空として比べる', () => {
  const env = createGasEnv();
  const l = [['ID', 'フラグ', 'メモ'], ['1', true, ''], ['2', false, null]];
  const r = [['ID', 'フラグ', 'メモ'], ['1', 'TRUE'], ['2', 'FALSE', '']];
  assert.equal(env.WitGas.reconcile.compare(l, r, { key: 'ID' }).summary.matched, 2);
});

test('見出しの前後の空白は無視する', () => {
  const env = createGasEnv();
  const res = env.WitGas.reconcile.compare([[' ID ', '値'], ['1', 'a']], [['ID', ' 値'], ['1', 'a']], { key: 'ID' });
  assert.deepEqual(plain(res.columns), ['値']);
  assert.equal(res.summary.matched, 1);
});

test('大きめの表（左右 1 万行）でも、どの行もどれか 1 つの区分に入る', () => {
  const env = createGasEnv();
  const l = [['ID', '値']];
  const r = [['ID', '値']];
  for (let i = 0; i < 10000; i++) {
    if (i % 7 !== 0) l.push(['K' + i, i]);
    if (i % 11 !== 0) r.push(['K' + i, i % 13 === 0 ? i + 1 : i]);
    if (i % 997 === 0) l.push(['K' + i, i]);
    if (i % 1009 === 0) r.push(['', i]);
  }
  const res = env.WitGas.reconcile.compare(l, r, { key: 'ID' });
  assertEveryRowOnce(res);
  assert.ok(res.summary.mismatched > 0 && res.summary.leftOnly > 0 && res.summary.rightOnly > 0);
  assert.ok(res.summary.duplicates > 0 && res.summary.blankKey > 0);
});

test('summaryText は件数だけを返す（業務データを含まない）', () => {
  const env = createGasEnv();
  const r = env.WitGas.reconcile.compare(LEFT, RIGHT, { key: '請求番号' });
  assert.equal(env.WitGas.reconcile.summaryText(r), '一致 2 / 不一致 1 / 左だけ 1 / 右だけ 1 / キー重複 0 / キーなし 0');
  assert.equal(env.WitGas.reconcile.summaryText(r, { left: '会計', right: '銀行' }),
    '一致 2 / 不一致 1 / 会計だけ 1 / 銀行だけ 1 / キー重複 0 / キーなし 0');
  assert.throws(() => env.WitGas.reconcile.summaryText({}), /result must come from compare/);
});

test('引数がおかしいときは投げる。エラーには列名だけを書き、データの値は書かない', () => {
  const env = createGasEnv();
  const c = env.WitGas.reconcile.compare;
  const t = [['ID', '値'], ['顧客A', 1]];
  const cases = [
    [undefined, t, { key: 'ID' }],
    [[], t, { key: 'ID' }],
    [[['ID'], 'x'], t, { key: 'ID' }],
    [t, t, undefined],
    [t, t, { key: '' }],
    [t, t, { key: [] }],
    [t, t, { key: ['ID', 'ID'] }],
    [t, t, { key: 'ない列' }],
    [t, [['番号', '値']], { key: 'ID' }],
    [[['ID', '値', '値'], ['1', 1, 2]], t, { key: 'ID', columns: ['値'] }],
    [t, t, { key: 'ID', columns: ['ない列'] }],
    [t, t, { key: 'ID', columns: '値' }],
    [t, t, { key: 'ID', numberColumns: ['ない列'] }],
    [t, t, { key: 'ID', dateColumns: '値' }],
    [t, t, { key: 'ID', columnMap: { ID: '' } }],
    [t, t, { key: 'ID', columnMap: [] }],
    [t, t, { key: 'ID', trim: 'yes' }],
    [t, t, { key: 'ID', width: 1 }],
    [t, t, { key: 'ID', timeZone: '' }]
  ];
  for (const [l, r, o] of cases) {
    assert.throws(() => c(l, r, o), (e) => /Error$/.test(e.name) && /^WitGas\.reconcile\.compare:/.test(e.message) && !e.message.includes('顧客'),
      JSON.stringify([l, r, o]));
  }
});

// ---- writeReport ----

function report(env, ss, sheetName) {
  return ss.getSheetByName(sheetName || '照合結果').values();
}

test('writeReport：要約（区分ごとの件数）と明細をシートに書く', () => {
  const env = createGasEnv();
  const ss = env.SpreadsheetApp.addSpreadsheet('SS');
  const r = env.WitGas.reconcile.compare(LEFT, RIGHT, { key: '請求番号' });
  const res = env.WitGas.reconcile.writeReport(r, { spreadsheetId: 'SS' });
  const v = report(env, ss);

  assert.equal(v[0][0], '照合日時');
  assert.equal(v[0][1].getTime(), env.clock.now());
  assert.deepEqual(v[1].slice(0, 3), ['表', '左：4 行', '右：4 行']);
  assert.deepEqual(v.slice(2, 9).map((x) => x.slice(0, 2)), [
    ['区分', '件数'], ['一致', 2], ['不一致', 1], ['左だけ', 1], ['右だけ', 1], ['キー重複', 0], ['キーなし', 0]
  ]);
  assert.deepEqual(v[10], ['区分', 'キー', '左の行', '右の行', '列', '左の値', '右の値']);
  assert.deepEqual(v.slice(11), [
    ['不一致', 'A002', 3, 3, '金額', 2500, 2400],
    ['左だけ', 'A003', 4, '', '', '', ''],
    ['右だけ', 'A005', '', 5, '', '', '']
  ]);
  assert.deepEqual({ ...res }, { sheetName: '照合結果', detailRows: 3 });
});

test('writeReport：表の呼び名・一致した行・重複・キーなし・列名の対応も書く', () => {
  const env = createGasEnv();
  const ss = env.SpreadsheetApp.addSpreadsheet('SS', { active: true });
  const l = [['伝票', '額'], ['1', 100], ['2', 200], ['2', 200], ['', 5]];
  const r = [['番号', '入金'], ['1', 150], ['3', 300], ['9', 1]];
  const res = env.WitGas.reconcile.compare(l, r, { key: '伝票', columnMap: { '伝票': '番号', '額': '入金' } });
  env.WitGas.reconcile.writeReport(res, { labels: { left: '会計', right: '銀行' }, includeMatched: true });
  const v = report(env, ss);
  assert.deepEqual(v[10], ['区分', 'キー', '会計の行', '銀行の行', '列', '会計の値', '銀行の値']);
  assert.deepEqual(v.slice(11), [
    ['不一致', '1', 2, 2, '額 / 入金', 100, 150],
    ['銀行だけ', '3', '', 3, '', '', ''],
    ['銀行だけ', '9', '', 4, '', '', ''],
    ['キー重複', '2', '3, 4', '', '', '', ''],
    ['キーなし', '', 5, '', '', '', '']
  ]);
});

test('writeReport：= + - @ で始まる値は式として読まれないようにする', () => {
  const env = createGasEnv();
  const ss = env.SpreadsheetApp.addSpreadsheet('SS');
  const res = env.WitGas.reconcile.compare([['ID', 'メモ'], ['=1+1', '@x'], ['2', '-a']], [['ID', 'メモ'], ['=1+1', '+y']], { key: 'ID' });
  env.WitGas.reconcile.writeReport(res, { spreadsheetId: 'SS' });
  const v = report(env, ss);
  assert.deepEqual(v[11], ['不一致', "'=1+1", 2, 2, 'メモ', "'@x", "'+y"]);
});

test('writeReport：前の照合結果は書き換える。照合結果でないシートは消さずに止める', () => {
  const env = createGasEnv();
  const ss = env.SpreadsheetApp.addSpreadsheet('SS');
  const r1 = env.WitGas.reconcile.compare(LEFT, RIGHT, { key: '請求番号' });
  env.WitGas.reconcile.writeReport(r1, { spreadsheetId: 'SS' });
  const r2 = env.WitGas.reconcile.compare(LEFT, LEFT, { key: '請求番号' });
  const res = env.WitGas.reconcile.writeReport(r2, { spreadsheetId: 'SS' });
  assert.equal(res.detailRows, 0);
  assert.equal(report(env, ss).length, 11, '前の明細が残っていない');

  const data = ss.insertSheet('売上');
  data.appendRow(['日付', '金額']);
  assert.throws(() => env.WitGas.reconcile.writeReport(r1, { spreadsheetId: 'SS', sheetName: '売上' }), /not a reconcile report/);
  assert.deepEqual(data.values(), [['日付', '金額']]);

  const empty = ss.insertSheet('空');
  env.WitGas.reconcile.writeReport(r1, { spreadsheetId: 'SS', sheetName: '空' });
  assert.equal(empty.values()[0][0], '照合日時');
});

test('writeReport：引数がおかしいときはシートに触らずに投げる', () => {
  const env = createGasEnv();
  env.SpreadsheetApp.addSpreadsheet('SS');
  const r = env.WitGas.reconcile.compare(LEFT, RIGHT, { key: '請求番号' });
  const w = env.WitGas.reconcile.writeReport;
  for (const [res, o] of [[{}, {}], [r, { sheetName: '' }], [r, { labels: { left: '会計' } }], [r, { spreadsheetId: '' }]]) {
    assert.throws(() => w(res, o), (e) => /^WitGas\.reconcile\.writeReport:/.test(e.message));
  }
  assert.equal(env.SpreadsheetApp.calls.length, 0);
  assert.throws(() => w(r, {}), /no spreadsheet/);
});

test('guard と組み合わせる：実行記録には件数だけ、照合結果のシートには明細', () => {
  const env = createGasEnv();
  const ss = env.SpreadsheetApp.addSpreadsheet('SS');
  const GUARD = { log: { spreadsheetId: 'SS' }, notify: { to: 'ops@example.com' } };
  const res = env.WitGas.guard('請求照合', (ctx) => {
    const r = env.WitGas.reconcile.compare(LEFT, RIGHT, { key: '請求番号' });
    env.WitGas.reconcile.writeReport(r, { spreadsheetId: 'SS' });
    ctx.setCount(r.summary.leftRows);
    ctx.setMessage(env.WitGas.reconcile.summaryText(r));
    return plain(r.summary);
  }, GUARD);
  assert.equal(res.status, 'success');
  const log = ss.getSheetByName('実行記録').values()[1];
  assert.deepEqual(Array.from(log.slice(2)), ['請求照合', '成功', 4, '', '一致 2 / 不一致 1 / 左だけ 1 / 右だけ 1 / キー重複 0 / キーなし 0']);
  assert.ok(!JSON.stringify(log).includes('山田'));
  assert.equal(ss.getSheetByName('照合結果').values()[11][1], 'A002');
});

test('writeReport：シートを新しく作るときだけ列幅を決める（照合日時が切れないように。2 回目からは変えない）', () => {
  const env = createGasEnv();
  const ss = env.SpreadsheetApp.addSpreadsheet('SS');
  const r = env.WitGas.reconcile.compare(LEFT, RIGHT, { key: '請求番号' });
  env.WitGas.reconcile.writeReport(r, { spreadsheetId: 'SS' });
  const sheet = ss.getSheetByName('照合結果');
  assert.deepEqual({ ...sheet._meta.columnWidths }, { 1: 100, 2: 150, 3: 70, 4: 70, 5: 140, 6: 150, 7: 150 });
  sheet.setColumnWidth(2, 300); // 先方が広げた
  env.WitGas.reconcile.writeReport(r, { spreadsheetId: 'SS' });
  assert.equal(sheet._meta.columnWidths[2], 300);
});
