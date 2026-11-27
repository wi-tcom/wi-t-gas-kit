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
  if (!o.noMigrate) env.context.migratePdfBatch();
  env.SpreadsheetApp.ui.alerts.length = 0;
  const folder = () => env.Drive.folders()[0];
  const pdfs = () => (folder() ? env.Drive.filesIn(folder().id) : []);
  return { env, ss, values, folder, pdfs, run: () => env.context.runPdfBatch() };
}

test('開くと「帳票」メニューを足す（PDF を作る・途中でやめる・見本のデータ・引き継ぎ書）', () => {
  const { env } = setup();
  env.context.onOpen();
  const menu = env.SpreadsheetApp.ui.menus[0];
  assert.equal(menu.title, '帳票');
  assert.deepEqual(menu.items.filter((i) => !i.separator).map((i) => i.functionName),
    ['runPdfBatch', 'stopPdfBatch', 'migratePdfBatch', 'checkPdfBatch', 'setupPdfBatchSample', 'writePdfBatchHandover']);
  for (const i of menu.items) {
    if (i.functionName) assert.equal(typeof env.context[i.functionName], 'function', i.functionName);
  }
});

test('見本のデータ 30 件から PDF を 30 件作り、作成記録に 30 行、実行記録に「成功／30」を残す', () => {
  const { env, ss, values, folder, pdfs, run } = setup();
  assert.equal(env.context.setupPdfBatchSample(), true);
  assert.equal(values('明細').length, 31);
  assert.deepEqual(ss.getSheets().map((x) => x.getName()).sort(), ['作成記録', '明細', '設定'].sort());
  const res = run();
  assert.equal(res.status, 'success');
  assert.equal(pdfs().length, 30);
  assert.equal(folder().name, '見本 お見積書 PDF（wi-t-gas-kit）');
  const names = pdfs().map((f) => f.name);
  assert.equal(names[0], 'お見積書_Q-0001.pdf');
  assert.equal(new Set(names).size, 30);
  assert.equal(pdfs()[0].mimeType, 'application/pdf');
  assert.equal(pdfs()[0].blob.getContentType(), 'application/pdf');

  const rec = values('作成記録');
  assert.deepEqual(rec[0], ['見積番号', '作成日時', 'ファイル ID', 'ファイル名']);
  assert.equal(rec.length, 31);
  assert.equal(rec[1][2], pdfs()[0].id);

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
  const html = pdfs()[0].blob._source;
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
  const f = pdfs().find((x) => x.name === 'お見積書_Q-0002.pdf');
  env.Drive.trash(f.id);
  const row = values('作成記録').findIndex((r) => r[0] === 'Q-0002');
  rec.deleteRows(row + 1, 1);
  run();
  assert.ok(pdfs().some((x) => x.name === 'お見積書_Q-0002.pdf'));
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
  assert.equal(new Set(pdfs().map((f) => f.name)).size, 30, '同じ帳票を二度作らない');
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
  env.Drive.failNextCreate(Object.assign(new Error('Drive が混んでいる'), { name: 'Exception' }));
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
  const settings = env.context.pdfBatchReadSettings_(env.SpreadsheetApp.getActiveSpreadsheet());
  const newId = env.context.pdfBatchFolder_(settings);
  assert.equal(env.Drive.Files.get(newId).name, '見本 お見積書 PDF（wi-t-gas-kit）');
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

// ---- 版・設定・移行 ----

function setSetting(ss, key, value) {
  const sheet = ss.getSheetByName('設定');
  const row = sheet.values().findIndex((r) => r[0] === key);
  assert.ok(row > 0, key);
  sheet.getRange(row + 1, 2, 1, 1).setValues([[value]]);
}

test('「設定と表を用意する」：設定シートと作成記録を作り、スキーマの版を 1 にする。何度動かしても同じ', () => {
  const { env, ss, values } = setup({ noMigrate: true });
  const res = env.context.migratePdfBatch();
  assert.equal(res.status, 'success');
  assert.equal(env.PropertiesService.dump()['WitGas.schema:pdfBatch'], '1');
  const settings = values('設定');
  assert.deepEqual(settings[0], ['項目', '値', '説明']);
  assert.deepEqual(settings.slice(1).map((r) => r[0]), Array.from(env.context.PDF_BATCH_SETTINGS, (i) => i.key));
  assert.deepEqual(values('作成記録')[0], ['見積番号', '作成日時', 'ファイル ID', 'ファイル名']);
  assert.match(env.SpreadsheetApp.ui.alerts[0], /設定と表を用意しました（スキーマの版 0 → 1）/);

  setSetting(ss, '発行元', '先方の会社名');
  env.context.migratePdfBatch();
  assert.match(env.SpreadsheetApp.ui.alerts[1], /もう用意されています（スキーマの版 1）/);
  assert.equal(values('設定').find((r) => r[0] === '発行元')[1], '先方の会社名', '先方が変えた値は残る');
});

test('用意する前に「PDF を作る」と、日本語で知らせて何もしない', () => {
  const { env, values, run } = setup({ noMigrate: true });
  assert.equal(run(), null);
  assert.match(env.SpreadsheetApp.ui.alerts[0], /設定と表がまだ用意されていません/);
  assert.equal(values('実行記録'), null);
});

test('設定シートの値で、題・発行元・列名・フォルダ名を変えられる（コードは変えない）', () => {
  const { env, ss, pdfs, folder, run } = setup();
  setSetting(ss, '帳票の題', '納品書');
  setSetting(ss, '発行元', '架空の会社');
  setSetting(ss, 'PDF のフォルダ名', '納品書の置き場');
  setSetting(ss, '列：見積番号', '伝票番号');
  const s = ss.insertSheet('明細');
  s.appendRow(['伝票番号', '宛先', '品名', '数量', '単価', '日付']);
  s.appendRow(['D-1', '見本商店', 'ノート', 1, 100, '']);
  run();
  assert.equal(pdfs()[0].name, '納品書_D-1.pdf');
  assert.equal(folder().name, '納品書の置き場');
  assert.match(pdfs()[0].blob._source, /<h1>納品書<\/h1>[\s\S]*架空の会社/);
});

test('設定の値がおかしいときは、日本語で知らせて何もしない（項目名だけで、値は出さない）', () => {
  const { env, ss, values, run } = setup();
  env.context.setupPdfBatchSample();
  setSetting(ss, '失敗の通知先', '山田太郎');
  assert.equal(run(), null);
  assert.equal(env.SpreadsheetApp.ui.alerts.slice(-1)[0],
    '「設定」シートの「失敗の通知先」の値がメールアドレスになっていません。「設定」シートを直してから、もう一度実行してください。');
  setSetting(ss, '失敗の通知先', 'ops@example.com');
  setSetting(ss, '1 回の上限（ミリ秒）', 999999);
  assert.equal(run(), null);
  assert.match(env.SpreadsheetApp.ui.alerts.slice(-1)[0], /「1 回の上限（ミリ秒）」は 1〜360000 の整数/);
  assert.equal(values('実行記録'), null);
});

test('点検：問題がなければそう知らせ、あれば直すことを並べる（直しはしない）', () => {
  const { env, ss } = setup();
  env.context.setupPdfBatchSample();
  const ok = env.context.checkPdfBatch();
  assert.equal(ok.ok, true);
  assert.match(env.SpreadsheetApp.ui.alerts.slice(-1)[0], /点検：問題は見つかりませんでした（帳票 PDF の一括作成（pdf-batch） 1\.0\.0、スキーマの版 1）/);

  setSetting(ss, '列：単価', '値段');
  env.PropertiesService.getScriptProperties().setProperty('WitGas.schema:pdfBatch', '0');
  const ng = env.context.checkPdfBatch();
  assert.equal(ng.ok, false);
  assert.deepEqual(Array.from(ng.problems), [
    'スキーマの版が 0 です（この版のコードは 1）。「設定と表を用意する」を実行してください。',
    '「明細」の見出し（1 行目）に「値段」がありません。'
  ]);
});

test('版上げの練習：前の版（スキーマ 1）のデータに、段を足した新しい版を入れると、足した段だけが動く', () => {
  const { env, ss, values, run } = setup();
  env.context.setupPdfBatchSample();
  run();
  // 新しい版で「作成記録に『送信日時』の列を足す」段が増えたとする
  const steps = Array.from(env.context.PDF_BATCH_STEPS).concat([{
    version: 2,
    name: '作成記録に送信日時の列を足す',
    run: () => {
      const rec = ss.getSheetByName('作成記録');
      if (rec.values()[0][4] !== '送信日時') rec.getRange(1, 5, 1, 1).setValues([['送信日時']]);
    }
  }]);
  env.context.PDF_BATCH_STEPS = steps;
  const before = values('作成記録').length;
  env.context.migratePdfBatch();
  env.context.migratePdfBatch(); // 何度動かしても同じ
  assert.equal(env.PropertiesService.dump()['WitGas.schema:pdfBatch'], '2');
  assert.equal(values('作成記録')[0][4], '送信日時');
  assert.equal(values('作成記録').length, before, '作成記録の中身は変わらない');
  assert.equal(values('設定').find((r) => r[0] === '発行元')[1], '見本商事株式会社（架空）');
});

test('VERSION と CHANGELOG.md の一番上の版が同じ。引き継ぎ書に見本の名前と版が出る', () => {
  const { env, ss } = setup();
  const changelog = fs.readFileSync(path.join(DIR, 'CHANGELOG.md'), 'utf8');
  const top = changelog.match(/^## (\d+\.\d+\.\d+)/m)[1];
  assert.equal(env.context.PDF_BATCH_VERSION, top);
  env.context.writePdfBatchHandover();
  const v = ss.getSheetByName('引き継ぎ書').values().map((r) => Array.from(r));
  assert.ok(v.some((r) => r[0] === '帳票 PDF の一括作成（pdf-batch）' && r[1] === top && r[2] === '見本・納品物'));
  assert.ok(v.some((r) => r[0] === 'スキーマの版：pdfBatch' && r[1] === '1'));
  assert.ok(v.some((r) => r[0] === '設定：失敗の通知先' && r[1] === 'ops@example.com'));
});

test('フォルダがゴミ箱に入っていたら、新しいフォルダを作ってそこに作る', () => {
  const { env, folder, run } = setup();
  env.context.setupPdfBatchSample();
  run();
  const oldId = folder().id;
  env.Drive.trash(oldId);
  env.context.runPdfBatch(); // 作成記録があるので 0 件。フォルダは作り直す
  assert.notEqual(env.PropertiesService.dump().PDF_BATCH_FOLDER_ID, oldId);
});

test('ファイル名に「\'」があっても、同じ名前の検索が壊れない（「\\」はファイル名にするときに「_」にする）', () => {
  const { env, ss, pdfs, run } = setup();
  const s = ss.insertSheet('明細');
  s.appendRow(['見積番号', '宛先', '品名', '数量', '単価', '日付']);
  s.appendRow(["Q'1\\a", '見本商店', 'ノート', 1, 100, '']);
  run();
  ss.getSheetByName('作成記録').deleteRows(2, 1);
  run();
  assert.equal(pdfs().length, 1, '同じ名前を見つけて、作り直さない');
  assert.equal(pdfs()[0].name, "お見積書_Q'1_a.pdf");
  assert.ok(env.Drive.calls.some((c) => c.method === 'list' && c.params.q.includes("name = 'お見積書_Q\\'1_a.pdf'")));
});

test('appsscript.json で Drive API（v3）を使い、DriveApp は使わない', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'appsscript.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies.enabledAdvancedServices, [{ userSymbol: 'Drive', serviceId: 'drive', version: 'v3' }]);
  const code = fs.readFileSync(path.join(DIR, 'main.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/DriveApp/.test(code));
});
