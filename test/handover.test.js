'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnv } = require('./helpers/gas-env');

const SS = 'https://www.googleapis.com/auth/spreadsheets';
const APP = 'https://www.googleapis.com/auth/script.scriptapp';
const MAIL = 'https://www.googleapis.com/auth/script.send_mail';

function setup() {
  const env = createGasEnv();
  const ss = env.SpreadsheetApp.addSpreadsheet('BOOK', { active: true, name: '請求管理' });
  const values = (name) => {
    const s = ss.getSheetByName(name || '引き継ぎ書');
    return s ? s.values().map((r) => Array.from(r)) : null;
  };
  /** 見出し（■ で始まる行）から次の空行までを返す */
  const section = (title, name) => {
    const v = values(name);
    const start = v.findIndex((r) => r[0] === '■ ' + title);
    assert.ok(start >= 0, 'section ' + title);
    const out = [];
    for (let i = start + 1; i < v.length && v[i].some((c) => c !== ''); i++) out.push(v[i]);
    return out;
  };
  return { env, ss, values, section };
}

function trim(rows) {
  return rows.map((r) => {
    const out = r.slice();
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  });
}

test('「引き継ぎ書」シートに、作成日時・スクリプト ID・タイムゾーンと各節を書く', () => {
  const { env, values } = setup();
  const res = env.WitGas.handover.write();
  const v = values();
  assert.equal(v[0][0], '引き継ぎ書');
  assert.equal(v[0][1].getTime(), env.clock.now());
  assert.deepEqual(trim(v.slice(1, 3)), [['スクリプト ID', '1ScriptIdForTests'], ['タイムゾーン', 'Asia/Tokyo']]);
  const titles = v.filter((r) => typeof r[0] === 'string' && r[0].startsWith('■ ')).map((r) => r[0]);
  assert.deepEqual(titles, ['■ 版', '■ トリガー', '■ 権限', '■ スクリプトのプロパティ', '■ シートの構成', '■ 設定値', '■ 止め方']);
  assert.equal(res.sheetName, '引き継ぎ書');
  assert.equal(res.rows, v.length);
  assert.deepEqual(Array.from(res.notes), []);
});

test('トリガー：関数・種類・起動元・ID を書き、WitGas.resume の続きのトリガーには印をつける', () => {
  const { env, section } = setup();
  const daily = env.ScriptApp.addOtherTrigger('dailySummary');
  const open = env.ScriptApp.addOtherTrigger('onOpenMenu', { eventType: 'ON_OPEN', source: 'SPREADSHEETS', sourceId: 'BOOK' });
  env.context.job = () => env.WitGas.resume.run({
    key: 'invoicePdf', total: 10, handler: 'job', step: () => { env.clock.advance(60000); }
  });
  env.context.job(); // 区切って続きのトリガーを張る
  const cont = env.ScriptApp.pending()[0];

  env.WitGas.handover.write();
  assert.deepEqual(trim(section('トリガー')), [
    ['関数', '種類', '起動元', 'ID', '備考'],
    ['dailySummary', '時間主導型', 'CLOCK', daily.getUniqueId()],
    ['onOpenMenu', '開いたとき', 'SPREADSHEETS（BOOK）', open.getUniqueId()],
    ['job', '時間主導型', 'CLOCK', cont.getUniqueId(), 'WitGas.resume の続き（invoicePdf）']
  ]);
});

test('トリガーがなければ（なし）、読めなければ（読めなかった）と書き、読めなかったものの節にエラー種別だけを書く', () => {
  const { env, section } = setup();
  env.WitGas.handover.write();
  assert.deepEqual(trim(section('トリガー')).slice(1), [['（なし）']]);

  const err = new Error('顧客 山田太郎 のせいで失敗');
  err.name = 'PermissionError';
  env.ScriptApp.failNextGetTriggers(err);
  const res = env.WitGas.handover.write();
  assert.deepEqual(trim(section('トリガー')).slice(1), [['（読めなかった）']]);
  assert.deepEqual(trim(section('読めなかったもの')), [['トリガー：読めなかった（PermissionError）']]);
  assert.deepEqual(Array.from(res.notes), ['トリガー：読めなかった（PermissionError）']);
});

test('権限：渡された権限と理由を書き、GAS が返す承認済みの権限と突き合わせる', () => {
  const { env, section } = setup();
  env.ScriptApp.setAuthorizedScopes([SS, MAIL, 'https://www.googleapis.com/auth/drive']);
  env.WitGas.handover.write({
    scopes: [
      { scope: SS, reason: '実行記録を書く' },
      { scope: APP, reason: '続きのトリガーを作る' },
      { scope: MAIL, reason: '失敗を知らせる' }
    ]
  });
  assert.deepEqual(trim(section('権限')), [
    ['権限', '理由', '承認済み'],
    [SS, '実行記録を書く', 'はい'],
    [APP, '続きのトリガーを作る', 'いいえ'],
    [MAIL, '失敗を知らせる', 'はい'],
    ['https://www.googleapis.com/auth/drive', '（理由が書かれていない）', 'はい']
  ]);
  assert.deepEqual(env.ScriptApp.stats.authModes, ['FULL']);
});

test('権限：承認済みの権限が分からないときは「分からない」。渡されていなければ appsscript.json を見るよう書く', () => {
  const { env, section } = setup();
  env.ScriptApp.setAuthorizedScopes(null); // getAuthorizedScopes が無い
  env.WitGas.handover.write({ scopes: [{ scope: SS, reason: '実行記録を書く' }] });
  assert.deepEqual(trim(section('権限')).slice(1), [[SS, '実行記録を書く', '分からない']]);

  env.ScriptApp.setAuthorizedScopes([]);
  env.WitGas.handover.write();
  assert.deepEqual(trim(section('権限')).slice(1), [['（渡されていない：appsscript.json の oauthScopes を見てください）']]);
});

test('スクリプトのプロパティ：キーだけを書き、値は書かない（WitGas.resume の途中は進み具合だけ書く）', () => {
  const { env, values, section } = setup();
  const props = env.PropertiesService.getScriptProperties();
  props.setProperty('API_TOKEN', 'secret-token-123');
  props.setProperty('担当者', '山田太郎');
  props.setProperty('WitGas.resume:invoicePdf', JSON.stringify({ v: 1, cursor: 4, runs: 2, firstStartedAt: 0, triggerId: '1001' }));
  props.setProperty('WitGas.resume:broken', '{');
  env.WitGas.handover.write();
  assert.deepEqual(trim(section('スクリプトのプロパティ')), [
    ['キー', '中身'],
    ['API_TOKEN', '（値は伏せる）'],
    ['WitGas.resume:broken', 'WitGas.resume の途中（読めない）'],
    ['WitGas.resume:invoicePdf', 'WitGas.resume の途中（cursor 4、runs 2、続きのトリガーあり）'],
    ['担当者', '（値は伏せる）']
  ]);
  const all = JSON.stringify(values());
  assert.ok(!all.includes('secret-token-123'));
  assert.ok(!all.includes('山田太郎'));
});

test('シートの構成：シート名・行数・列数を書く。見出しは headers: true のときだけ（既定は書かない）', () => {
  const { env, ss, section } = setup();
  const s = ss.insertSheet('請求');
  s.appendRow(['請求番号', '取引先', '金額']);
  s.appendRow(['INV-001', 'サンプル商店', 1000]);
  env.WitGas.handover.write();
  const rows = trim(section('シートの構成'));
  assert.deepEqual(rows[0], ['シート', '行数', '列数', '見出し（1 行目）']);
  assert.deepEqual(rows.slice(1), [['請求', 2, 3]], '引き継ぎ書のシートそのものは出さない');
  assert.ok(!JSON.stringify(rows).includes('サンプル商店'));

  env.WitGas.handover.write({ headers: true }); // 2 回目（引き継ぎ書のシートがある）でも出さない
  const withHeaders = trim(section('シートの構成'));
  assert.deepEqual(withHeaders.map((r) => r[0]), ['シート', '請求']);
  assert.deepEqual(withHeaders.find((r) => r[0] === '請求'), ['請求', 2, 3, '請求番号 / 取引先 / 金額']);
});

test('シートの構成：見出しは 20 列までにする。ほかのスプレッドシートも ID で並べられる', () => {
  const { env, values } = setup();
  const other = env.SpreadsheetApp.addSpreadsheet('LOG', { name: '実行記録置き場' });
  const wide = other.insertSheet('広い表');
  wide.appendRow(Array.from({ length: 25 }, (_, i) => 'c' + (i + 1)));
  env.WitGas.handover.write({ inspect: ['LOG'], headers: true });
  const v = values();
  const head = v.find((r) => r[0] === '■ シートの構成');
  assert.equal(head[1], '実行記録置き場（LOG）');
  const row = v.find((r) => r[0] === '広い表');
  assert.equal(row[3], Array.from({ length: 20 }, (_, i) => 'c' + (i + 1)).join(' / ') + ' / …');
});

test('設定値：secret の値は伏せる。オブジェクトは JSON の文字で書く。式として読まれないようにする', () => {
  const { env, section } = setup();
  env.WitGas.handover.write({
    settings: [
      { name: '通知先', value: 'ops@example.com', note: '失敗のメール' },
      { name: 'API キー', value: 'sk-123', secret: true },
      { name: '照合の設定', value: { key: '請求番号', numberColumns: ['金額'] } },
      { name: '式', value: '=1+1' },
      { name: '上限', value: 5000 }
    ]
  });
  assert.deepEqual(trim(section('設定値')), [
    ['名前', '値', '説明'],
    ['通知先', 'ops@example.com', '失敗のメール'],
    ['API キー', '（伏せる）'],
    ['照合の設定', '{"key":"請求番号","numberColumns":["金額"]}'],
    ['式', "'=1+1"],
    ['上限', 5000]
  ]);
});

test('止め方：順番の番号をつけて書く。なければ（書かれていない）', () => {
  const { env, section } = setup();
  env.WitGas.handover.write();
  assert.deepEqual(trim(section('止め方')), [['（書かれていない）']]);
  env.WitGas.handover.write({ stopSteps: ['トリガーの画面で dailySummary を消す', 'WitGas.resume.cleanup(\'invoicePdf\') を実行する'] });
  assert.deepEqual(trim(section('止め方')), [
    ['1', 'トリガーの画面で dailySummary を消す'],
    ['2', 'WitGas.resume.cleanup(\'invoicePdf\') を実行する']
  ]);
});

test('前の引き継ぎ書は書き直す。引き継ぎ書でないシートは消さずに止める。列幅は新しく作るときだけ決める', () => {
  const { env, ss, values } = setup();
  env.WitGas.handover.write({ stopSteps: ['一つめ', '二つめ'] });
  const sheet = ss.getSheetByName('引き継ぎ書');
  assert.deepEqual({ ...sheet._meta.columnWidths }, { 1: 220, 2: 260, 3: 200, 4: 200, 5: 200 });
  sheet.setColumnWidth(2, 400);
  const before = values().length;
  env.WitGas.handover.write({ stopSteps: ['一つめ'] });
  assert.equal(values().length, before - 1, '前の中身が残っていない');
  assert.equal(sheet._meta.columnWidths[2], 400, '先方が変えた幅を残す');

  const memo = ss.insertSheet('メモ');
  memo.appendRow(['大事なメモ']);
  assert.throws(() => env.WitGas.handover.write({ sheetName: 'メモ' }), /not a handover sheet/);
  assert.deepEqual(memo.values(), [['大事なメモ']]);
});

test('collect は中身を返すだけでシートには書かない', () => {
  const { env, ss } = setup();
  env.ScriptApp.addOtherTrigger('dailySummary');
  const info = env.WitGas.handover.collect({ settings: [{ name: 'a', value: 1 }] });
  assert.equal(info.scriptId, '1ScriptIdForTests');
  assert.equal(info.triggers.length, 1);
  assert.equal(info.triggers[0].handler, 'dailySummary');
  assert.equal(info.sheets[0].name, '請求管理');
  assert.equal(ss.getSheetByName('引き継ぎ書'), null);
});

test('引数がおかしいときはシートに触らずに投げる', () => {
  const { env, ss } = setup();
  const w = env.WitGas.handover.write;
  const cases = [
    { sheetName: '' },
    { headers: 'yes' },
    { scopes: 'x' },
    { scopes: [{ scope: SS }] },
    { settings: [{ value: 1 }] },
    { settings: [{ name: 'a', secret: 'yes' }] },
    { stopSteps: [1] },
    { inspect: 'BOOK' },
    { inspect: [''] },
    { spreadsheetId: '' }
  ];
  for (const c of cases) {
    assert.throws(() => w(c), (e) => /^WitGas\.handover\.write:/.test(e.message), JSON.stringify(c));
  }
  assert.equal(ss.getSheetByName('引き継ぎ書'), null);
});

test('開いているスプレッドシートがなく ID もなければ投げる', () => {
  const env = createGasEnv();
  assert.throws(() => env.WitGas.handover.write(), /no spreadsheet/);
});

test('guard で包んで作れる（実行記録には件数だけ）', () => {
  const { env, ss } = setup();
  const res = env.WitGas.guard('引き継ぎ書を作る', (ctx) => {
    const r = env.WitGas.handover.write({ stopSteps: ['a'] });
    ctx.setCount(r.rows);
  }, { log: { spreadsheet: ss }, notify: false });
  assert.equal(res.status, 'success');
  assert.equal(ss.getSheetByName('実行記録').values()[1][3], '成功');
});

test('版：見本の名前と版、部品集の版、入っている部品ごとの版、スキーマの版を書く', () => {
  const { env, section } = setup();
  env.PropertiesService.getScriptProperties().setProperty('WitGas.schema:pdfBatch', '2');
  env.WitGas.handover.write({ app: { name: '帳票 PDF', version: '1.2.0' } });
  const rows = trim(section('版'));
  assert.deepEqual(rows[0], ['名前', '版', '備考']);
  assert.deepEqual(rows[1], ['帳票 PDF', '1.2.0', '見本・納品物']);
  assert.deepEqual(rows[2], ['部品集（WitGas.version）', '0.2.0']);
  const parts = rows.filter((r) => String(r[0]).startsWith('WitGas.'));
  assert.deepEqual(parts.map((r) => r[0]), [
    'WitGas.guard', 'WitGas.handover', 'WitGas.lock', 'WitGas.migrate', 'WitGas.notify',
    'WitGas.reconcile', 'WitGas.resume', 'WitGas.runlog', 'WitGas.settings'
  ]);
  assert.ok(parts.every((r) => r[1] === '0.2.0' && r.length === 2), '版がそろっていれば備考は空');
  assert.deepEqual(rows[rows.length - 1], ['スキーマの版：pdfBatch', '2', 'WitGas.migrate']);
  assert.deepEqual(trim(section('スクリプトのプロパティ')).slice(1), [['WitGas.schema:pdfBatch', 'スキーマの版（2）']]);
});

test('版：部品集の版と違う部品には印をつける（ファイルの入れ替え忘れに気づけるように）', () => {
  const { env, section } = setup();
  env.WitGas.lock.VERSION = '0.1.0';
  env.WitGas.handover.write();
  const row = trim(section('版')).find((r) => r[0] === 'WitGas.lock');
  assert.deepEqual(row, ['WitGas.lock', '0.1.0', '部品集の版と違う（入れ替え忘れの見込み）']);
  assert.throws(() => env.WitGas.handover.write({ app: { name: 'x' } }), /opts\.app must be \{name, version\}/);
});
