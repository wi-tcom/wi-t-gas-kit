'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGasEnv } = require('../helpers/gas-env');
const { build } = require('../../scripts/build-example');

const EXAMPLE = 'examples/form-approval';
const DIR = path.join(__dirname, '..', '..', EXAMPLE);
const PARTS = JSON.parse(fs.readFileSync(path.join(DIR, 'parts.json'), 'utf8'));
const MIN = 60 * 1000;

/** 見本が使う部品と見本のソースだけを読み込み、スプレッドシートに付いたスクリプトとして動かす */
function setup(options) {
  const o = options || {};
  const env = createGasEnv({ files: PARTS, extra: [EXAMPLE + '/main.js'] });
  const ss = env.SpreadsheetApp.addSpreadsheet('BOOK', { active: true });
  const values = (name) => {
    const s = ss.getSheetByName(name);
    return s ? s.values().map((r) => Array.from(r)) : null;
  };
  if (!o.noMigrate) {
    env.context.migrateFormApproval();
    setSetting(ss, '承認者の通知先', 'boss@example.org');
    setSetting(ss, '失敗の通知先', 'admin@example.org');
  }
  env.SpreadsheetApp.ui.alerts.length = 0;
  return { env, ss, values, run: () => env.context.runFormApproval() };
}

function setSetting(ss, key, value) {
  const sheet = ss.getSheetByName('設定');
  const row = sheet.values().findIndex((r) => r[0] === key);
  assert.ok(row > 0, key);
  sheet.getRange(row + 1, 2, 1, 1).setValues([[value]]);
}

/** フォームの回答が届いたことにする（回答のシートの末尾に 1 行） */
function answer(env, ss, mail, subject, amount, minute) {
  let sheet = ss.getSheetByName('フォームの回答 1');
  if (!sheet) {
    sheet = ss.insertSheet('フォームの回答 1');
    sheet.appendRow(['タイムスタンプ', 'メールアドレス', '件名', '金額', '理由']);
  }
  const m = String(minute || sheet.getLastRow()).padStart(2, '0');
  sheet.appendRow([new Date('2026-12-01T09:' + m + ':00+09:00'), mail, subject, amount, '（理由の文）']);
}

/** 承認のシートの「判断」と「コメント」を、承認者が入れたことにする */
function judge(ss, number, judgment, comment) {
  const sheet = ss.getSheetByName('承認');
  const v = sheet.values();
  const h = v[0];
  const r = v.findIndex((row) => row[0] === number);
  assert.ok(r > 0, number);
  sheet.getRange(r + 1, h.indexOf('判断') + 1, 1, 1).setValues([[judgment]]);
  if (comment !== undefined) sheet.getRange(r + 1, h.indexOf('コメント') + 1, 1, 1).setValues([[comment]]);
}

function ledger(values) {
  const v = values('承認');
  const h = v[0];
  return v.slice(1).map((r) => Object.fromEntries(h.map((name, i) => [name, r[i]])));
}

test('開くと「申請」メニューを足す', () => {
  const { env } = setup();
  env.context.onOpen();
  const menu = env.SpreadsheetApp.ui.menus[0];
  assert.equal(menu.title, '申請');
  assert.deepEqual(menu.items.filter((i) => !i.separator).map((i) => [i.caption, i.functionName]), [
    ['今すぐ取り込む・知らせる', 'runFormApproval'],
    ['定時の動きを始める（10 分ごと）', 'startFormApproval'],
    ['定時の動きを止める', 'stopFormApproval'],
    ['設定と表を用意する（版上げのときも）', 'migrateFormApproval'],
    ['点検する', 'checkFormApproval'],
    ['見本のデータを入れる', 'setupFormApprovalSample'],
    ['引き継ぎ書を作る', 'writeFormApprovalHandover']
  ]);
  for (const i of menu.items) {
    if (i.functionName) assert.equal(typeof env.context[i.functionName], 'function', i.functionName);
  }
});

test('「設定と表を用意する」：設定シートと承認のシート（判断は選ぶ形）を作り、スキーマの版を 1 にする。何度動かしても同じ', () => {
  const { env, ss, values } = setup({ noMigrate: true });
  env.context.migrateFormApproval();
  assert.equal(env.PropertiesService.dump()['WitGas.schema:formApproval'], '1');
  assert.deepEqual(values('設定').slice(1).map((r) => r[0]), Array.from(env.context.FORM_APPROVAL_SETTINGS, (i) => i.key));
  assert.deepEqual(values('承認')[0], ['申請番号', '受付日時', '申請者', '判断', 'コメント', '状態', '知らせた日時', '回答の行', '件名', '金額']);
  const validation = ss.getSheetByName('承認')._meta.validations[0];
  assert.equal(validation.col, 4);
  assert.deepEqual(Array.from(validation.rule.list), ['承認', '差し戻し']);
  assert.equal(validation.rule.allowInvalid, false);
  assert.match(env.SpreadsheetApp.ui.alerts[0], /スキーマの版 0 → 1/);

  setSetting(ss, '件名の頭', '[経費]');
  env.context.migrateFormApproval();
  assert.match(env.SpreadsheetApp.ui.alerts[1], /もう用意されています（スキーマの版 1）/);
  assert.equal(values('設定').find((r) => r[0] === '件名の頭')[1], '[経費]');
  assert.equal(values('承認').length, 1);
});

test('新しい回答を取り込み、申請番号を振って「未判断」にする。承認者には件数だけを知らせる', () => {
  const { env, ss, values, run } = setup();
  answer(env, ss, 'a@example.net', '出張旅費（大阪）', 32000);
  answer(env, ss, 'b@example.net', '書籍の購入', 4800);
  const res = run();
  assert.equal(res.status, 'success');
  const rows = ledger(values);
  assert.deepEqual(rows.map((r) => [r['申請番号'], r['申請者'], r['状態'], r['回答の行'], r['件名'], r['金額']]), [
    ['A-0001', 'a@example.net', '未判断', 2, '出張旅費（大阪）', 32000],
    ['A-0002', 'b@example.net', '未判断', 3, '書籍の購入', 4800]
  ]);
  assert.equal(env.MailApp.sent.length, 1);
  const m = env.MailApp.sent[0];
  assert.equal(m.to, 'boss@example.org');
  assert.equal(m.subject, '[申請] 新しい申請 2 件（判断待ち 2 件）');
  for (const secret of ['a@example.net', '出張旅費', '32000', '理由の文']) assert.ok(!m.body.includes(secret), secret);
  assert.ok(m.body.includes('https://docs.google.com/spreadsheets/d/BOOK/edit'));

  // もう一度動かしても、同じ回答は取り込まない・承認者にも知らせない
  run();
  assert.equal(ledger(values).length, 2);
  assert.equal(env.MailApp.sent.length, 1);

  // 1 件増えたら、その 1 件だけ
  answer(env, ss, 'c@example.net', '研修の参加費', 15000);
  run();
  assert.deepEqual(ledger(values).map((r) => r['申請番号']), ['A-0001', 'A-0002', 'A-0003']);
  assert.equal(env.MailApp.sent[1].subject, '[申請] 新しい申請 1 件（判断待ち 3 件）');
});

test('判断を選ぶと、次の回に申請者へ結果を知らせ、「知らせた」にする。二度は送らない', () => {
  const { env, ss, values, run } = setup();
  answer(env, ss, 'a@example.net', '出張旅費', 32000);
  answer(env, ss, 'b@example.net', '書籍の購入', 4800);
  run();
  judge(ss, 'A-0001', '承認', '気をつけて');
  judge(ss, 'A-0002', '差し戻し', '領収書をつけてください');
  env.clock.advance(10 * MIN);
  const res = run();
  assert.equal(res.count, 2);
  const mails = env.MailApp.sent.slice(1);
  assert.deepEqual(mails.map((m) => [m.to, m.subject, m.name]), [
    ['a@example.net', '[申請] 申請 A-0001：承認', '申請の受付'],
    ['b@example.net', '[申請] 申請 A-0002：差し戻し', '申請の受付']
  ]);
  assert.match(mails[0].body, /^申請 A-0001（2026-12-01 09:\d\d 受付）は承認されました。\n\nコメント：気をつけて/);
  assert.match(mails[1].body, /差し戻しになりました。\n\n理由：領収書をつけてください/);
  const rows = ledger(values);
  assert.deepEqual(rows.map((r) => r['状態']), ['知らせた（承認）', '知らせた（差し戻し）']);
  assert.ok(rows.every((r) => typeof r['知らせた日時'].getTime === 'function'));

  run();
  assert.equal(env.MailApp.sent.length, 3, '二度は送らない');
  // 実行記録：件数と内訳だけ
  const log = values('実行記録');
  const last = log[log.length - 1];
  assert.ok(last.includes('成功'));
  assert.ok(!JSON.stringify(log).includes('example.net'));
});

test('判断が空・コメントが空でも動く（コメントは「（なし）」）。差し込みと返信先を設定で変えられる', () => {
  const { env, ss, run } = setup();
  setSetting(ss, '承認のメールの文', '{申請番号} は {結果} です。{コメント}');
  setSetting(ss, '返信先', 'desk@example.org');
  setSetting(ss, '件名の頭', '[経費]');
  answer(env, ss, 'a@example.net', '出張旅費', 32000);
  answer(env, ss, 'b@example.net', '書籍', 100);
  run();
  judge(ss, 'A-0002', '承認');
  run();
  const m = env.MailApp.sent[env.MailApp.sent.length - 1];
  assert.equal(m.to, 'b@example.net');
  assert.equal(m.subject, '[経費] 申請 A-0002：承認');
  assert.equal(m.body, 'A-0002 は 承認 です。（なし）');
  assert.equal(m.replyTo, 'desk@example.org');
  assert.equal(env.MailApp.sent.length, 2, '判断が空の A-0001 には送らない');
});

test('送る前に「送信中」にして書き込みを確定する。送信で失敗したら「送信中」のまま残り、次の回も二度送らない', () => {
  const { env, ss, values, run } = setup();
  answer(env, ss, 'a@example.net', '出張旅費', 32000);
  answer(env, ss, 'b@example.net', '書籍', 100);
  run();
  judge(ss, 'A-0001', '承認');
  judge(ss, 'A-0002', '承認');
  const flushesBefore = env.SpreadsheetApp.calls.filter((c) => c.method === 'flush').length;
  env.MailApp.failNextSend(Object.assign(new Error('mail failed'), { name: 'Exception' }));
  assert.throws(() => run());
  assert.ok(env.SpreadsheetApp.calls.filter((c) => c.method === 'flush').length > flushesBefore);
  assert.deepEqual(ledger(values).map((r) => r['状態']), ['送信中', '未判断']);
  // 失敗は担当に知らせる（申請者のアドレスは書かない）
  const notice = env.MailApp.sent.find((m) => m.to === 'admin@example.org');
  assert.ok(notice);
  assert.ok(!notice.body.includes('example.net'));

  env.clock.advance(10 * MIN);
  env.LockService.newExecution();
  run();
  assert.deepEqual(ledger(values).map((r) => r['状態']), ['送信中', '知らせた（承認）']);
  assert.equal(env.MailApp.sent.filter((m) => m.to === 'a@example.net').length, 0, '送信中のものは送り直さない');
  const check = env.context.checkFormApproval();
  assert.ok(check.problems.some((p) => /「送信中」のままの申請が 1 件/.test(p)));
});

test('1 回に知らせる上限と、1 日の送信の残りを越えない。残りは次の回に送る', () => {
  const { env, ss, values, run } = setup();
  setSetting(ss, '1 回に知らせる上限', 2);
  for (let i = 1; i <= 5; i++) answer(env, ss, 'p' + i + '@example.net', '件名' + i, i, i);
  run();
  for (let i = 1; i <= 5; i++) judge(ss, 'A-000' + i, '承認');
  run();
  assert.equal(ledger(values).filter((r) => r['状態'] === '知らせた（承認）').length, 2);
  env.MailApp.setQuota(1);
  run();
  assert.equal(ledger(values).filter((r) => r['状態'] === '知らせた（承認）').length, 3);
  env.MailApp.setQuota(100);
  run();
  assert.equal(ledger(values).filter((r) => r['状態'] === '知らせた（承認）').length, 5);
});

test('4.5 分を越えそうなら、知らせるのをやめて次の回にまわす', () => {
  const { env, ss, values, run } = setup();
  for (let i = 1; i <= 3; i++) answer(env, ss, 'p' + i + '@example.net', '件名' + i, i, i);
  run();
  for (let i = 1; i <= 3; i++) judge(ss, 'A-000' + i, '承認');
  const realSend = env.MailApp.sendEmail;
  env.MailApp.sendEmail = (m) => { env.clock.advance(2.5 * MIN); return realSend.call(env.MailApp, m); };
  const res = run();
  assert.equal(res.status, 'success');
  assert.equal(ledger(values).filter((r) => r['状態'] === '知らせた（承認）').length, 2);
  assert.equal(ledger(values).filter((r) => r['状態'] === '未判断').length, 1);
});

test('宛先がメールアドレスでなければ送らず「宛先なし」にする', () => {
  const { env, ss, values, run } = setup();
  answer(env, ss, '', '件名', 1);
  run();
  judge(ss, 'A-0001', '承認');
  run();
  assert.equal(ledger(values)[0]['状態'], '宛先なし（知らせていない）');
  assert.equal(env.MailApp.sent.length, 1, '承認者への 1 通だけ');
});

test('フォームの回答が式に見えても、承認のシートには文字として写す', () => {
  const { env, ss, values, run } = setup();
  answer(env, ss, 'a@example.net', '=IMPORTXML("https://example.com","//a")', 1);
  run();
  assert.equal(ledger(values)[0]['件名'], '\'=IMPORTXML("https://example.com","//a")');
});

test('回答のシートの見出しが足りないときは、日本語で知らせ、失敗として記録して担当に知らせる', () => {
  const { env, ss, values, run } = setup();
  setSetting(ss, '写す列', '件名, 部署');
  answer(env, ss, 'a@example.net', '件名', 1);
  const res = run();
  assert.equal(res.status, 'failure');
  assert.equal(env.SpreadsheetApp.ui.alerts.slice(-1)[0], '「フォームの回答 1」の見出し（1 行目）に「部署」がありません。');
  assert.ok(values('実行記録').some((r) => r.includes('SheetFormatError')));
  assert.ok(env.MailApp.sent.some((m) => m.to === 'admin@example.org'));
});

test('設定の誤り：画面があれば画面で知らせる。定時に動いているとき（画面がない）は担当にメールで知らせる', () => {
  const { env, ss, run } = setup();
  setSetting(ss, '1 回に知らせる上限', 500);
  assert.equal(run(), null);
  assert.match(env.SpreadsheetApp.ui.alerts.slice(-1)[0], /「1 回に知らせる上限」は 1〜100 の整数/);
  assert.equal(env.MailApp.sent.length, 0);

  env.SpreadsheetApp.withoutUi();
  assert.equal(run(), null);
  assert.equal(env.MailApp.sent.length, 1);
  assert.equal(env.MailApp.sent[0].to, 'admin@example.org');
  assert.match(env.MailApp.sent[0].subject, /SettingsError/);
  run(); // 1 時間に 1 通まで
  assert.equal(env.MailApp.sent.length, 1);
});

test('定時の動き：10 分ごとのトリガーを 1 つだけ張る。張り直しても 1 つ。止めると消える', () => {
  const { env } = setup();
  env.ScriptApp.addOtherTrigger('otherJob');
  env.context.startFormApproval();
  env.context.startFormApproval();
  const mine = () => env.ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'runFormApproval');
  assert.equal(mine().length, 1);
  assert.equal(mine()[0]._everyMinutes, 10);
  assert.match(env.SpreadsheetApp.ui.alerts.slice(-1)[0], /前のトリガー 1 個は張り直しました/);
  env.context.stopFormApproval();
  assert.equal(mine().length, 0);
  assert.equal(env.ScriptApp.getProjectTriggers().length, 1, 'ほかの処理のトリガーは消さない');
  env.context.stopFormApproval();
  assert.match(env.SpreadsheetApp.ui.alerts.slice(-1)[0], /もう止まっています/);
});

test('二重に動かない：ほかの実行がロックを持っていれば、取り込みも送信もしない', () => {
  const { env, ss, values, run } = setup();
  answer(env, ss, 'a@example.net', '件名', 1);
  env.LockService.holdByOther(); // ほかの実行が持っている
  const res = run();
  assert.equal(res.status, 'skipped');
  assert.equal(ledger(values).length, 0);
  assert.equal(env.MailApp.sent.length, 0);
});

test('点検：回答と承認のシートを突き合わせる。見本のアドレス・トリガーなし・取り込み漏れ・知らせたあとの変更に気づく', () => {
  const { env, ss, values, run } = setup({ noMigrate: true });
  env.context.migrateFormApproval();
  answer(env, ss, 'a@example.net', '件名', 1);
  answer(env, ss, 'b@example.net', '件名', 2);
  run();
  judge(ss, 'A-0001', '承認');
  run();
  judge(ss, 'A-0001', '差し戻し'); // 知らせたあとに変えた
  answer(env, ss, 'c@example.net', '件名', 3); // まだ取り込んでいない
  const r = env.context.checkFormApproval();
  assert.equal(r.ok, false);
  const expected = [
    /^「設定」シートの「承認者の通知先」が見本のアドレスのまま/,
    /^「設定」シートの「失敗の通知先」が見本のアドレスのまま/,
    /^定時の動きが止まっています（runFormApproval のトリガーがありません）/,
    /^まだ取り込んでいない回答が 1 件あります/,
    /^知らせたあとに「判断」が変わった申請が 1 件あります/
  ];
  assert.equal(r.problems.length, expected.length, r.problems.join('\n'));
  expected.forEach((re, i) => assert.match(r.problems[i], re));

  setSetting(ss, '承認者の通知先', 'boss@example.org');
  setSetting(ss, '失敗の通知先', 'admin@example.org');
  judge(ss, 'A-0001', '承認');
  env.context.startFormApproval();
  run();
  const ok = env.context.checkFormApproval();
  assert.equal(ok.ok, true, ok.problems.join('\n'));
  assert.equal(ok.counts.waiting, 2);
  assert.match(env.SpreadsheetApp.ui.alerts.slice(-1)[0], /問題は見つかりませんでした（フォーム → 承認 → 通知（form-approval） 1\.0\.0、スキーマの版 1、判断待ち 2 件）/);

  // 回答のシートの行を消すと気づく
  ss.getSheetByName('フォームの回答 1').deleteRows(2, 1);
  assert.ok(env.context.checkFormApproval().problems.some((p) => /回答のシートから消えた/.test(p)));
});

test('見本のデータ：回答のシートがなければ架空の 3 件を入れる。あれば入れない', () => {
  const { env, values, run } = setup();
  assert.equal(env.context.setupFormApprovalSample(), true);
  assert.deepEqual(values('フォームの回答 1')[0], ['タイムスタンプ', 'メールアドレス', '件名', '金額']);
  assert.equal(values('フォームの回答 1').length, 4);
  run();
  assert.equal(ledger(values).length, 3);
  assert.equal(env.context.setupFormApprovalSample(), false);
});

test('用意する前に動かすと、日本語で知らせて何もしない', () => {
  const { env, values, run } = setup({ noMigrate: true });
  assert.equal(run(), null);
  assert.match(env.SpreadsheetApp.ui.alerts[0], /設定と表がまだ用意されていません/);
  assert.equal(values('実行記録'), null);
  assert.equal(env.context.startFormApproval(), null);
  assert.equal(env.ScriptApp.getProjectTriggers().length, 0);
});

test('版上げの練習：スキーマ 1 のデータに、段を足した新しい版を入れると、足した段だけが動く', () => {
  const { env, ss, values, run } = setup();
  answer(env, ss, 'a@example.net', '件名', 1);
  run();
  env.context.FORM_APPROVAL_STEPS = Array.from(env.context.FORM_APPROVAL_STEPS).concat([{
    version: 2,
    name: '承認のシートに「判断した人」の列を足す',
    run: () => {
      const sh = ss.getSheetByName('承認');
      const h = sh.values()[0];
      if (h.indexOf('判断した人') < 0) sh.getRange(1, h.length + 1, 1, 1).setValues([['判断した人']]);
    }
  }]);
  env.context.migrateFormApproval();
  env.context.migrateFormApproval();
  assert.equal(env.PropertiesService.dump()['WitGas.schema:formApproval'], '2');
  assert.equal(values('承認')[0].slice(-1)[0], '判断した人');
  assert.equal(ledger(values).length, 1);
  assert.equal(values('設定').find((r) => r[0] === '承認者の通知先')[1], 'boss@example.org');
  run(); // 新しい列があっても動く
  assert.equal(ledger(values).length, 1);
});

test('引き継ぎ書：版・権限と理由・設定値・止め方。権限の一覧は appsscript.json と同じ', () => {
  const { env, ss } = setup();
  env.context.startFormApproval();
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'appsscript.json'), 'utf8')).oauthScopes;
  env.ScriptApp.setAuthorizedScopes(manifest);
  env.context.writeFormApprovalHandover();
  const v = ss.getSheetByName('引き継ぎ書').values().map((r) => Array.from(r));
  const changelog = fs.readFileSync(path.join(DIR, 'CHANGELOG.md'), 'utf8');
  const top = changelog.match(/^## (\d+\.\d+\.\d+)/m)[1];
  assert.equal(env.context.FORM_APPROVAL_VERSION, top);
  assert.ok(v.some((r) => r[0] === 'フォーム → 承認 → 通知（form-approval）' && r[1] === top));
  assert.ok(v.some((r) => r[0] === 'スキーマの版：formApproval' && r[1] === '1'));
  assert.ok(v.some((r) => r[0] === 'runFormApproval' && r[1] === '時間主導型'));
  assert.ok(v.some((r) => r[0] === '設定：承認者の通知先' && r[1] === 'boss@example.org'));
  assert.ok(JSON.stringify(v).includes('定時の動きを止める'));
  assert.deepEqual(Array.from(env.context.FORM_APPROVAL_SCOPES, (s) => s.scope), manifest);
  const scopeRows = v.filter((r) => manifest.includes(r[0]));
  assert.equal(scopeRows.length, manifest.length);
  assert.ok(scopeRows.every((r) => r[2] === 'はい'));
  assert.ok(!manifest.some((s) => /forms/.test(s)), 'フォームの権限は持たない');
});

test('npm run example:build で、GAS に送るファイルだけを dist にまとめる', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'witgas-build-'));
  try {
    const res = build('form-approval', out);
    assert.deepEqual(res.files.slice().sort(),
      ['appsscript.json', 'main.js'].concat(PARTS.map((p) => path.join('witgas', p))).sort());
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
