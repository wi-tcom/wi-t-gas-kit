'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGasEnv } = require('../helpers/gas-env');
const { build, bundle } = require('../../scripts/build-example');

const DIR = path.join(__dirname, '..', '..', 'examples', 'gas-inspect');
const PARTS = JSON.parse(fs.readFileSync(path.join(DIR, 'parts.json'), 'utf8'));
const BUNDLE = JSON.parse(fs.readFileSync(path.join(DIR, 'bundle.json'), 'utf8'));
const CODE = bundle(DIR, PARTS, BUNDLE);

/** 先方の既存のプロジェクト（架空）。ロックも失敗の扱いもない関数・ある関数・トリガーが指す先のない関数など */
const CUSTOMER = `
function dailyReport() {
  var rows = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('売上').getDataRange().getValues();
  return summarize_(rows);
}
function summarize_(rows) { return rows.length; }

function onFormSubmitSafe(e) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;
  try {
    record_(e);
  } catch (err) {
    MailApp.sendEmail('ops@example.com', '失敗', String(err.name));
  } finally {
    lock.releaseLock();
  }
}
function record_(e) { return e; }

function swallow() {
  try { dailyReport(); } catch (err) { console.log('x'); }
}

function onEdit(e) { return e; }
function doGet() { return null; }
`;

/** 先方のプロジェクトに点検のファイルを 1 つ足した状態 */
function setup(options) {
  const o = options || {};
  const sources = [];
  if (o.customer !== false) sources.push({ name: 'customer.js', code: o.customer || CUSTOMER });
  sources.push({ name: 'wit-inspect.js', code: CODE });
  const env = createGasEnv({ files: [], sources, timeZone: o.timeZone });
  const ss = o.noSpreadsheet ? null : env.SpreadsheetApp.addSpreadsheet('BOOK', { active: true });
  if (ss && o.sheetTimeZone) ss.setSpreadsheetTimeZone(o.sheetTimeZone);
  env.ScriptApp.setAuthorizedScopes(o.scopes || [
    'https://www.googleapis.com/auth/script.scriptapp',
    'https://www.googleapis.com/auth/spreadsheets.currentonly',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/script.send_mail'
  ]);
  return { env, ss };
}

/** 点検結果の表（見出しより下）を {状態, 項目, 理由, 直し方, 確認} の形で */
function findings(res) {
  const start = res.rows.findIndex((r) => r[0] === '状態' && r[1] === '項目') + 1;
  return Array.from(res.rows).slice(start).map((r) => ({ state: r[0], item: r[1], reason: r[2], howTo: r[3], check: r[4] }));
}
function byItem(res, item) {
  return findings(res).filter((f) => f.item === item);
}
/** 表を作ってシートを置く（insertSheet ＋ setValues） */
function addSheet(ss, name, values) {
  const sh = ss.insertSheet(name);
  sh.getRange(1, 1, values.length, values[0].length).setValues(values);
  return sh;
}

test('足すのは WIT_INSPECT と witInspect の 2 つだけ。部品は閉じ込めて、先方のグローバルの WitGas に触らない', () => {
  const customerKit = 'var WitGas = { version: "0.2.0", lock: { VERSION: "0.2.0" }, resume: { VERSION: "0.1.0" } };';
  const { env } = setup({ customer: CUSTOMER + customerKit });
  const before = env.context.WitGas;
  assert.deepEqual(env.addedGlobals().sort(), ['WIT_INSPECT', 'WitGas', 'dailyReport', 'doGet', 'onEdit', 'onFormSubmitSafe',
    'record_', 'summarize_', 'swallow', 'witInspect'].sort());
  env.context.witInspect();
  assert.equal(env.context.WitGas, before);
  assert.deepEqual(Object.keys(env.context.WitGas).sort(), ['lock', 'resume', 'version']);
  assert.equal(env.context.WIT_INSPECT.VERSION, '1.0.0');
});

test('トリガー：関数がない・同じものが 2 つ・シンプルトリガーと同じ名前・時間主導型の重なりを見分ける', () => {
  const { env } = setup();
  env.ScriptApp.addOtherTrigger('dailyReport');
  env.ScriptApp.addOtherTrigger('dailyReport');
  env.ScriptApp.addOtherTrigger('removedFunction');
  env.ScriptApp.addOtherTrigger('onFormSubmitSafe', { eventType: 'ON_FORM_SUBMIT', source: 'SPREADSHEETS', sourceId: 'BOOK' });
  env.ScriptApp.addOtherTrigger('onFormSubmitSafe', { eventType: 'ON_FORM_SUBMIT', source: 'SPREADSHEETS', sourceId: 'BOOK' });
  env.ScriptApp.addOtherTrigger('onEdit', { eventType: 'ON_EDIT', source: 'SPREADSHEETS', sourceId: 'BOOK' });
  const before = env.ScriptApp.getProjectTriggers().map((t) => t.getUniqueId());

  const res = env.context.witInspect();

  assert.deepEqual(byItem(res, 'トリガーの数').map((f) => [String(f.state), String(f.reason)]), [['よい', '6 個（1 人・1 スクリプトあたり 20 個まで）。']]);
  assert.equal(byItem(res, 'トリガー：removedFunction')[0].state, '直したほうがよい');
  assert.match(byItem(res, 'トリガー：removedFunction')[0].reason, /見つからない/);
  assert.deepEqual(byItem(res, 'トリガー：dailyReport').map((f) => f.state), ['気をつける']);
  assert.deepEqual(byItem(res, 'トリガー：onFormSubmitSafe').map((f) => f.state), ['直したほうがよい']);
  assert.match(byItem(res, 'トリガー：onFormSubmitSafe')[0].reason, /2 回動く/);
  assert.deepEqual(byItem(res, 'トリガー：onEdit').map((f) => f.state), ['直したほうがよい']);
  assert.match(byItem(res, 'トリガー：onEdit')[0].reason, /シンプルトリガー/);
  assert.equal(byItem(res, '動き終わったトリガー')[0].state, '目で確かめる');

  // トリガーは作らない・消さない
  assert.deepEqual(env.ScriptApp.getProjectTriggers().map((t) => t.getUniqueId()), Array.from(before));
  assert.equal(env.ScriptApp.stats.deleted, 0);
});

test('関数：見つけた先方の関数の名前を並べる。点検のファイルの中の関数・標準の名前・サービスは入れない', () => {
  const { env } = setup();
  const res = env.context.witInspect();
  const f = byItem(res, '関数')[0];
  assert.equal(f.state, 'よい');
  assert.equal(f.reason, 'グローバルの関数 7 個を見た：dailyReport・doGet・onEdit・onFormSubmitSafe・record_・summarize_・swallow。');
});

test('トリガーで動く関数：ロックと失敗の扱いを、呼んでいる関数までたどって見る', () => {
  const { env } = setup();
  env.ScriptApp.addOtherTrigger('dailyReport');
  env.ScriptApp.addOtherTrigger('onFormSubmitSafe', { eventType: 'ON_FORM_SUBMIT', source: 'SPREADSHEETS', sourceId: 'BOOK' });
  env.ScriptApp.addOtherTrigger('swallow');
  const res = env.context.witInspect();

  assert.equal(byItem(res, '二重実行：dailyReport')[0].state, '気をつける');
  assert.equal(byItem(res, '二重実行：onFormSubmitSafe')[0].state, 'よい');
  assert.equal(byItem(res, '失敗の扱い：dailyReport')[0].state, '気をつける');
  assert.match(byItem(res, '失敗の扱い：dailyReport')[0].reason, /つかまえていない/);
  assert.equal(byItem(res, '失敗の扱い：onFormSubmitSafe')[0].state, 'よい');
  assert.match(byItem(res, '失敗の扱い：swallow')[0].reason, /人に知らせず/);
});

test('WitGas.guard で包んだ関数は、二重実行も失敗の扱いも「よい」', () => {
  const customer = 'function nightly() { return WitGas.guard("夜の集計", function () { return 1; }, { log: false, notify: false }); }';
  const { env } = setup({ customer });
  env.ScriptApp.addOtherTrigger('nightly');
  const res = env.context.witInspect();
  assert.equal(byItem(res, '二重実行：nightly')[0].state, 'よい');
  assert.equal(byItem(res, '失敗の扱い：nightly')[0].state, 'よい');
});

test('トリガーが 15 個以上なら気をつける。トリガーがなければ「ない」と出す', () => {
  const many = setup();
  for (let i = 0; i < 15; i++) many.env.ScriptApp.addOtherTrigger('dailyReport');
  assert.equal(byItem(many.env.context.witInspect(), 'トリガーの数')[0].state, '気をつける');

  const none = setup();
  const res = none.env.context.witInspect();
  assert.deepEqual(byItem(res, 'トリガーの数').map((f) => [String(f.state), String(f.reason)]), [['よい', 'この人が作ったトリガーはない。']]);
  assert.equal(byItem(res, '動き終わったトリガー').length, 0);
});

test('トリガーの一覧を読めないときは、目で確かめる行にする', () => {
  const { env } = setup();
  env.ScriptApp.failNextGetTriggers(new Error('no permission'));
  env.ScriptApp.failNextGetTriggers(new Error('no permission'));
  const res = env.context.witInspect();
  assert.equal(byItem(res, 'トリガー')[0].state, '目で確かめる');
});

test('権限：広いものに気をつける、点検のために足したものは後片付けで外すと書く', () => {
  const { env } = setup();
  const res = env.context.witInspect();
  assert.equal(byItem(res, '権限：drive')[0].state, '気をつける');
  assert.match(byItem(res, '権限：drive')[0].reason, /drive\.file/);
  assert.equal(byItem(res, '権限：script.send_mail')[0].state, 'よい');
  assert.match(byItem(res, '権限：script.scriptapp')[0].howTo, /後片付けで外す/);
  assert.match(byItem(res, '権限：spreadsheets.currentonly')[0].howTo, /後片付けで外す/);
  assert.equal(byItem(res, '権限を appsscript.json に書いているか')[0].state, '目で確かめる');
});

test('ウェブアプリ（doGet）とタイムゾーンの違い', () => {
  const { env } = setup({ timeZone: 'Asia/Tokyo', sheetTimeZone: 'America/Los_Angeles' });
  const res = env.context.witInspect();
  assert.equal(byItem(res, 'ウェブアプリ：doGet')[0].state, '目で確かめる');
  assert.equal(byItem(res, 'タイムゾーン')[0].state, '気をつける');
  assert.match(byItem(res, 'タイムゾーン')[0].reason, /America\/Los_Angeles/);
});

test('先方の WitGas の部品の版がそろっていないと気づく', () => {
  const customerKit = 'var WitGas = { version: "0.2.0", lock: { VERSION: "0.2.0" }, resume: { VERSION: "0.1.0" } };';
  const { env, ss } = setup({ customer: CUSTOMER + customerKit });
  const res = env.context.witInspect();
  assert.equal(byItem(res, '部品集 WitGas')[0].state, '気をつける');
  assert.match(byItem(res, '部品集 WitGas')[0].reason, /resume/);
  // 引き継ぎ書の版の欄には、点検した先方の部品集が出る（点検のファイルに閉じ込めた部品ではなく）
  const handover = ss.getSheetByName('引き継ぎ書').values().map((r) => Array.from(r));
  assert.ok(handover.some((r) => r[0] === '部品集（WitGas.version）' && r[1] === '0.2.0'));
  assert.ok(handover.some((r) => r[0] === 'WitGas.resume' && r[1] === '0.1.0' && /違う/.test(r[2])));
});

test('先方に WitGas がなければ、部品集の行は出さず、引き継ぎ書は「入っていない」', () => {
  const { env, ss } = setup();
  const res = env.context.witInspect();
  assert.equal(byItem(res, '部品集 WitGas').length, 0);
  const handover = ss.getSheetByName('引き継ぎ書').values().map((r) => Array.from(r));
  assert.ok(handover.some((r) => r[0] === '部品集（WitGas.version）' && r[1] === '（入っていない）'));
  assert.ok(!handover.some((r) => /^WitGas\./.test(r[0])));
});

test('点検結果シート：まとめ・見出し・最後に「元に戻したか」の行。2 回動かしても形は同じ', () => {
  const { env, ss } = setup();
  env.ScriptApp.addOtherTrigger('dailyReport');
  const res = env.context.witInspect();
  assert.equal(res.sheetName, '点検結果');
  const v = ss.getSheetByName('点検結果').values();
  assert.equal(v[0][0], '点検結果');
  assert.deepEqual(Array.from(v[1].slice(0, 2)), ['点検の版', 'gas-inspect 1.0.0']);
  assert.equal(v[4][0], 'まとめ');
  const c = res.counts;
  assert.equal(v[4][1], '直したほうがよい ' + c.fix + ' / 気をつける ' + c.warn + ' / 目で確かめる ' + c.look + ' / よい ' + c.good);
  assert.deepEqual(Array.from(v[6]), ['状態', '項目', '理由', '直し方の例', '確認']);
  const last = Array.from(v[v.length - 1]);
  assert.equal(last[1], '後片付け：元に戻したか');
  assert.equal(last[0], '目で確かめる');
  assert.match(last[3], /wit-inspect のファイルを消す/);
  assert.match(last[3], /appsscript\.json を点検の前の形に戻す/);

  const rows1 = v.length;
  env.context.witInspect();
  assert.equal(ss.getSheetByName('点検結果').values().length, rows1);
});

test('関数の中身やシートの値は、点検結果にも引き継ぎ書にも書かない', () => {
  const { env, ss } = setup();
  addSheet(ss, '売上', [['顧客名', '金額'], ['山田太郎', 1000]]);
  env.ScriptApp.addOtherTrigger('dailyReport');
  env.ScriptApp.addOtherTrigger('onFormSubmitSafe', { eventType: 'ON_FORM_SUBMIT', source: 'SPREADSHEETS', sourceId: 'BOOK' });
  env.context.witInspect();
  const all = ['点検結果', '引き継ぎ書'].map((n) => JSON.stringify(ss.getSheetByName(n).values())).join('\n');
  for (const secret of ['山田太郎', 'getDataRange', 'ops@example.com', 'tryLock', '顧客名']) {
    assert.ok(!all.includes(secret), secret);
  }
});

test('同じ名前の別のシートがあれば、点検結果も引き継ぎ書も書かずに止める', () => {
  const { env, ss } = setup();
  addSheet(ss, '点検結果', [['先方のメモ']]);
  assert.throws(() => env.context.witInspect(), (e) => e.name === 'SheetInUseError');
  assert.deepEqual(Array.from(ss.getSheetByName('点検結果').values()[0]), ['先方のメモ']);
  assert.equal(ss.getSheetByName('引き継ぎ書'), null);
});

test('「引き継ぎ書」が別のシートなら、点検結果だけを書き、その旨を残す', () => {
  const { env, ss } = setup();
  addSheet(ss, '引き継ぎ書', [['先方の引き継ぎメモ']]);
  const res = env.context.witInspect();
  assert.equal(byItem(res, '引き継ぎ書')[0].state, '目で確かめる');
  assert.deepEqual(Array.from(ss.getSheetByName('引き継ぎ書').values()[0]), ['先方の引き継ぎメモ']);
});

test('スプレッドシートに付いていないスクリプトでは、実行ログに出す', () => {
  const { env } = setup({ noSpreadsheet: true });
  const res = env.context.witInspect();
  assert.equal(res.sheetName, null);
  assert.ok(env.logs.some((l) => l.message.startsWith('まとめ | ')));
  assert.ok(env.logs.some((l) => l.message.includes('後片付け：元に戻したか')));
  assert.equal(byItem(res, '引き継ぎ書')[0].state, '目で確かめる');
});

test('ビルドすると wit-inspect.js が 1 つだけでき、appsscript.json は出さない', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'witgas-inspect-'));
  try {
    const r = build('gas-inspect', out);
    assert.deepEqual(r.files, ['wit-inspect.js']);
    assert.deepEqual(fs.readdirSync(r.outDir), ['wit-inspect.js']);
    assert.equal(fs.readFileSync(path.join(r.outDir, 'wit-inspect.js'), 'utf8'), CODE);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('VERSION と CHANGELOG.md の一番上の版が同じ。appsscript.json は点検のために足す 2 つの権限だけ', () => {
  const changelog = fs.readFileSync(path.join(DIR, 'CHANGELOG.md'), 'utf8');
  const top = changelog.match(/^## (\d+\.\d+\.\d+)/m)[1];
  const { env } = setup();
  assert.equal(env.context.WIT_INSPECT.VERSION, top);
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'appsscript.json'), 'utf8'));
  assert.deepEqual(manifest.oauthScopes, [
    'https://www.googleapis.com/auth/script.scriptapp',
    'https://www.googleapis.com/auth/spreadsheets.currentonly'
  ]);
  for (const f of ['README.md', 'README.en.md']) {
    const readme = fs.readFileSync(path.join(DIR, f), 'utf8');
    for (const s of manifest.oauthScopes) assert.ok(readme.includes(s.replace('https://www.googleapis.com/auth/', '')), f + ': ' + s);
  }
});
