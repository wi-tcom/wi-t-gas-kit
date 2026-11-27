'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGasEnv } = require('../helpers/gas-env');
const { build } = require('../../scripts/build-example');

const EXAMPLE = 'examples/pdf-batch';
const DIR = path.join(__dirname, '..', '..', EXAMPLE);
const PARTS = JSON.parse(fs.readFileSync(path.join(DIR, 'parts.json'), 'utf8'));
const MIN = 60 * 1000;

/** 見本が使う部品と見本のソースだけを読み込み、スプレッドシートに付いたスクリプトとして動かす */
function setup(options) {
  const env = createGasEnv({ files: PARTS, extra: [EXAMPLE + '/main.js'] });
  const ss = env.SpreadsheetApp.addSpreadsheet('BOOK', { active: true });
  const o = Object.assign({ pdfMs: 1000 }, options);
  // 1 枚の PDF にかかる時間を偽の時計で進める
  const realNewBlob = env.context.Utilities.newBlob;
  env.context.Utilities.newBlob = (...args) => {
    const b = realNewBlob(...args);
    const realGetAs = b.getAs;
    b.getAs = (type) => { env.clock.advance(o.pdfMs); return realGetAs(type); };
    return b;
  };
  const values = (name) => {
    const s = ss.getSheetByName(name);
    return s ? s.values().map((r) => Array.from(r)) : null;
  };
  const folder = () => env.DriveApp.folders()[0];
  const pdfs = () => (folder() ? env.DriveApp.filesIn(folder().getId()) : []);
  return { env, ss, values, folder, pdfs, run: () => env.context.runPdfBatch() };
}

test('開くと「帳票」メニューを足す（PDF を作る・途中でやめる・見本のデータ・引き継ぎ書）', () => {
  const { env } = setup();
  env.context.onOpen();
  const menu = env.SpreadsheetApp.ui.menus[0];
  assert.equal(menu.title, '帳票');
  assert.deepEqual(menu.items.filter((i) => !i.separator).map((i) => i.functionName),
    ['runPdfBatch', 'stopPdfBatch', 'setupPdfBatchSample', 'writePdfBatchHandover']);
  for (const i of menu.items) {
    if (i.functionName) assert.equal(typeof env.context[i.functionName], 'function', i.functionName);
  }
});

test('見本のデータ 30 件から PDF を 30 件作り、作成記録に 30 行、実行記録に「成功／30」を残す', () => {
  const { env, ss, values, folder, pdfs, run } = setup();
  assert.equal(env.context.setupPdfBatchSample(), true);
  assert.equal(values('明細').length, 31);
  const res = run();
  assert.equal(res.status, 'success');
  assert.equal(pdfs().length, 30);
  assert.equal(folder().getName(), '見本 お見積書 PDF（wi-t-gas-kit）');
  const names = pdfs().map((f) => f.getName());
  assert.equal(names[0], 'お見積書_Q-0001.pdf');
  assert.equal(new Set(names).size, 30);
  assert.equal(pdfs()[0].getMimeType(), 'application/pdf');

  const rec = values('作成記録');
  assert.deepEqual(rec[0], ['見積番号', '作成日時', 'ファイル ID', 'ファイル名']);
  assert.equal(rec.length, 31);
  assert.equal(rec[1][2], pdfs()[0].getId());

  const log = values('実行記録');
  assert.deepEqual(log[1].slice(2, 6), ['帳票PDF', '成功', 30, '']);
  assert.match(log[1][6], /^作成 30、作成済み 0、番号なし 0、不備 0、cursor 30$/);
  assert.match(ss.toasts.slice(-1)[0].message, /PDF を 30 件作りました/);
  assert.equal(env.MailApp.sent.length, 0);
});

test('帳票の中身：題・見積番号・宛先・品名・金額（数量×単価）・日付。HTML の特殊な字は逃がす', () => {
  const { env, ss, pdfs, run } = setup();
  const s = ss.insertSheet('明細');
  s.appendRow(['見積番号', '宛先', '品名', '数量', '単価', '日付']);
  s.appendRow(['Q-9', '<見本>&商店', 'ノート "A4"', 3, 1200, new env.context.Date(Date.UTC(2026, 11, 4, 15))]);
  run();
  const html = pdfs()[0].getBlob()._source;
  assert.match(html, /<h1>お見積書<\/h1>/);
  assert.match(html, /見積番号：Q-9/);
  assert.match(html, /&lt;見本&gt;&amp;商店 御中/);
  assert.match(html, /ノート &quot;A4&quot;/);
  assert.match(html, /¥1,200<\/td><td class="n">¥3,600/);
  assert.match(html, /日付：2026年12月5日/);
  assert.ok(!/請求書|インボイス/.test(html), '請求書とは名乗らない');
});

test('もう一度作ると、作成済みは飛ばして 0 件', () => {
  const { env, values, pdfs, run } = setup();
  env.context.setupPdfBatchSample();
  run();
  run();
  assert.equal(pdfs().length, 30);
  const log = values('実行記録');
  assert.deepEqual(log[2].slice(3, 5), ['成功', 0]);
  assert.match(log[2][6], /^作成 0、作成済み 30/);
});

test('作成記録の行を消すと、その帳票だけ作り直す（ファイルが残っていれば作らずに記録だけ戻す）', () => {
  const { env, ss, values, pdfs, run } = setup();
  env.context.setupPdfBatchSample();
  run();
  const rec = ss.getSheetByName('作成記録');
  rec.deleteRows(2, 1); // Q-0001 の記録を消す（PDF は残っている）
  run();
  assert.equal(pdfs().length, 30, '同じ名前の PDF があるので作らない（上書きもしない）');
  assert.equal(values('作成記録').length, 31, '記録は戻る');

  // PDF も消してから記録を消すと、作り直す
  const f = pdfs().find((x) => x.getName() === 'お見積書_Q-0002.pdf');
  f.setTrashed(true);
  const row = values('作成記録').findIndex((r) => r[0] === 'Q-0002');
  rec.deleteRows(row + 1, 1);
  run();
  assert.ok(pdfs().some((x) => x.getName() === 'お見積書_Q-0002.pdf'));
  assert.equal(pdfs().length, 30);
});

test('上限を越える前に区切り、続きのトリガーで残りを作る。最後にトリガーと進み具合が残らない', () => {
  const { env, values, pdfs, run } = setup({ pdfMs: 20000 }); // 1 件 20 秒
  env.context.setupPdfBatchSample();
  const first = run();
  assert.equal(first.status, 'continued');
  const firstCount = pdfs().length;
  assert.ok(firstCount > 0 && firstCount < 30);
  while (env.fireNext().fired) { /* 続きを動かす */ }
  assert.equal(pdfs().length, 30);
  assert.equal(new Set(pdfs().map((f) => f.getName())).size, 30, '同じ帳票を二度作らない');
  assert.equal(env.ScriptApp.getProjectTriggers().length, 0);
  assert.equal(env.PropertiesService.dump()['WitGas.resume:pdfBatch'], undefined);
  const results = values('実行記録').slice(1).map((r) => r[3]);
  assert.equal(results[results.length - 1], '成功');
  assert.ok(results.slice(0, -1).every((x) => x === '続きあり'));
  const created = values('実行記録').slice(1).reduce((a, r) => a + r[4], 0);
  assert.equal(created, 30, '実行記録の件数の合計が 30');
});

test('作る途中で失敗したら、失敗した帳票から続けられ、二重に作らない', () => {
  const { env, pdfs, run } = setup();
  env.context.setupPdfBatchSample();
  env.DriveApp.failNextCreateFile(Object.assign(new Error('Drive が混んでいる'), { name: 'Exception' }));
  assert.throws(run, /Drive が混んでいる/);
  assert.equal(pdfs().length, 0);
  assert.equal(env.MailApp.sent.length, 1);
  run();
  assert.equal(pdfs().length, 30);
});

test('明細の見出しが足りないときは、日本語で知らせ、失敗として記録してメールで知らせる（投げない）', () => {
  const { env, ss, values, run } = setup();
  env.context.setupPdfBatchSample();
  ss.getSheetByName('明細').getRange(1, 5, 1, 1).setValues([['値段']]);
  const res = run();
  assert.deepEqual({ ...res }, { status: 'failure', errorType: 'SheetFormatError' });
  assert.deepEqual(env.SpreadsheetApp.ui.alerts, ['「明細」の見出し（1 行目）に「単価」がありません。']);
  assert.deepEqual(values('実行記録')[1].slice(2, 6), ['帳票PDF', '失敗', '', 'SheetFormatError']);
  assert.equal(env.MailApp.sent.length, 1);
  assert.equal(env.MailApp.sent[0].subject, '[WitGas] 失敗: 帳票PDF (SheetFormatError)');
});

test('明細が空なら画面で知らせるだけ（実行記録にも通知にも残さない）', () => {
  const { env, values, run } = setup();
  assert.equal(run(), null);
  assert.match(env.SpreadsheetApp.ui.alerts[0], /「明細」シートに、見出しと 1 行以上の明細を入れてから/);
  assert.equal(values('実行記録'), null);
  assert.equal(env.MailApp.sent.length, 0);
});

test('見積番号が空の行と、数量・単価が数でない行は作らずに数える。業務データは実行記録に残さない', () => {
  const { ss, values, pdfs, run } = setup();
  const s = ss.insertSheet('明細');
  s.appendRow(['見積番号', '宛先', '品名', '数量', '単価', '日付']);
  s.appendRow(['Q-1', '見本商店', 'ノート', 2, '1,000', '2026/12/1']);
  s.appendRow(['', '見本商店', 'ノート', 2, 100, '']);
  s.appendRow(['Q-3', '見本商店', 'ノート', '二', 100, '']);
  run();
  assert.equal(pdfs().length, 1);
  const log = values('実行記録')[1];
  assert.match(log[6], /^作成 1、作成済み 0、番号なし 1、不備 1/);
  assert.ok(!JSON.stringify(log).includes('見本商店'));
});

test('見本のデータは、明細か作成記録にデータがあれば入れない', () => {
  const { env, ss } = setup();
  ss.insertSheet('明細').appendRow(['先方のデータ']);
  assert.equal(env.context.setupPdfBatchSample(), false);
  assert.match(env.SpreadsheetApp.ui.alerts[0], /「明細」にデータがあるため/);
  assert.deepEqual(ss.getSheetByName('明細').values(), [['先方のデータ']]);
});

test('フォルダはスクリプトが作り、2 回目からは同じフォルダを使う。消されていたら作り直す', () => {
  const { env, run } = setup();
  env.context.setupPdfBatchSample();
  run();
  const id = env.PropertiesService.dump().PDF_BATCH_FOLDER_ID;
  assert.ok(id);
  env.PropertiesService.getScriptProperties().setProperty('PDF_BATCH_FOLDER_ID', 'D-gone');
  assert.equal(env.context.pdfBatchFolder_(env.context.PDF_BATCH).getName(), '見本 お見積書 PDF（wi-t-gas-kit）');
  assert.notEqual(env.PropertiesService.dump().PDF_BATCH_FOLDER_ID, 'D-gone');
});

test('作成を途中でやめると、続きのトリガーと進み具合が消え、作った PDF は残る', () => {
  const { env, pdfs, run } = setup({ pdfMs: 20000 });
  env.context.setupPdfBatchSample();
  run();
  const made = pdfs().length;
  const r = env.context.stopPdfBatch();
  assert.equal(r.deletedState, true);
  assert.equal(env.ScriptApp.getProjectTriggers().length, 0);
  assert.equal(pdfs().length, made);
  assert.match(env.SpreadsheetApp.ui.alerts.slice(-1)[0], /作成を止めました/);
});

test('引き継ぎ書：権限と理由・設定値・止め方を書く。権限の一覧は appsscript.json と同じ', () => {
  const { env, ss, run } = setup({ pdfMs: 20000 });
  env.context.setupPdfBatchSample();
  run(); // 続きのトリガーがある状態
  env.ScriptApp.setAuthorizedScopes(JSON.parse(fs.readFileSync(path.join(DIR, 'appsscript.json'), 'utf8')).oauthScopes);
  env.context.writePdfBatchHandover();
  const v = ss.getSheetByName('引き継ぎ書').values();
  const flat = JSON.stringify(v);
  assert.ok(flat.includes('WitGas.resume の続き（pdfBatch）'));
  assert.ok(flat.includes('作成を途中でやめる'));
  assert.ok(flat.includes('PDF_BATCH_FOLDER_ID'));
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'appsscript.json'), 'utf8')).oauthScopes;
  assert.deepEqual(Array.from(env.context.PDF_BATCH_SCOPES, (s) => s.scope), manifest);
  const scopeRows = v.filter((r) => manifest.includes(r[0]));
  assert.equal(scopeRows.length, manifest.length);
  assert.ok(scopeRows.every((r) => r[2] === 'はい'));
});

test('npm run example:build で、GAS に送るファイルだけを dist にまとめる', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'witgas-build-'));
  try {
    const res = build('pdf-batch', out);
    assert.deepEqual(res.files.slice().sort(),
      ['appsscript.json', 'main.js'].concat(PARTS.map((p) => path.join('witgas', p))).sort());
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
