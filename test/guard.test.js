'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnv } = require('./helpers/gas-env');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const TO = 'ops@example.com';

function setup(options) {
  const env = createGasEnv(options);
  const ss = env.SpreadsheetApp.addSpreadsheet('LOG');
  const GUARD = { log: { spreadsheetId: 'LOG' }, notify: { to: TO } };
  const rows = () => {
    const s = ss.getSheetByName('実行記録');
    return s ? s.values().slice(1) : [];
  };
  /** 結果・件数・エラー種別・メッセージの列だけ */
  const summary = () => rows().map((r) => [r[2], r[3], r[4], r[5], r[6]]);
  return { env, ss, GUARD, rows, summary };
}

function boom() {
  throw new TypeError('顧客 山田太郎 の行で失敗');
}

test('成功：fn の結果を返し、実行記録に「成功」と件数を残す。メールは送らない', () => {
  const { env, GUARD, summary } = setup();
  const t0 = env.clock.now();
  const res = env.WitGas.guard('日次集計', (ctx) => {
    env.clock.advance(3000);
    ctx.setCount(12);
    ctx.setMessage('3 シート');
    return 'ok';
  }, GUARD);
  assert.equal(res.status, 'success');
  assert.equal(res.value, 'ok');
  assert.equal(res.count, 12);
  assert.equal(res.startedAt.getTime(), t0);
  assert.equal(res.endedAt.getTime(), t0 + 3000);
  assert.deepEqual(summary(), [['日次集計', '成功', 12, '', '3 シート']]);
  assert.equal(env.MailApp.sent.length, 0);
  assert.equal(env.LockService.isHeld(), false);
});

test('失敗：実行記録に「失敗」とエラー種別を残し、通知してから同じエラーを投げる', () => {
  const { env, GUARD, summary } = setup();
  let thrown;
  assert.throws(() => env.WitGas.guard('請求書PDF', boom, GUARD), (e) => { thrown = e; return e.name === 'TypeError'; });
  assert.match(thrown.message, /山田太郎/, '投げ直すのは元のエラーそのもの');
  assert.deepEqual(summary(), [['請求書PDF', '失敗', '', 'TypeError', '']]);
  assert.equal(env.MailApp.sent.length, 1);
  const m = env.MailApp.sent[0];
  assert.equal(m.subject, '[WitGas] 失敗: 請求書PDF (TypeError)');
  assert.match(m.body, /実行記録：https:\/\/docs\.google\.com\/spreadsheets\/d\/LOG\/edit/);
  assert.equal(env.LockService.isHeld(), false);
});

test('失敗の中身（エラーのメッセージ）は実行記録・メール・ログのどこにも残さない', () => {
  const { env, GUARD, rows } = setup();
  assert.throws(() => env.WitGas.guard('請求書PDF', boom, GUARD));
  assert.ok(!JSON.stringify(rows()).includes('山田'));
  assert.ok(!JSON.stringify(env.MailApp.sent).includes('山田'));
  for (const l of env.logs) assert.ok(!l.message.includes('山田'), l.message);
  assert.ok(env.logs.some((l) => l.level === 'error' && l.message === '[WitGas.guard] failed: 請求書PDF (TypeError)'));
});

test('rethrow: false なら投げずに status: failure を返す', () => {
  const { env, GUARD } = setup();
  const res = env.WitGas.guard('請求書PDF', boom, { ...GUARD, rethrow: false });
  assert.equal(res.status, 'failure');
  assert.equal(res.errorType, 'TypeError');
  assert.equal(res.value, undefined);
  assert.equal(env.MailApp.sent.length, 1);
});

test('失敗する前に数えた件数も残す', () => {
  const { env, GUARD, summary } = setup();
  assert.throws(() => env.WitGas.guard('請求書PDF', (ctx) => { ctx.addCount(); ctx.addCount(); boom(); }, GUARD));
  assert.deepEqual(summary(), [['請求書PDF', '失敗', 2, 'TypeError', '']]);
  assert.match(env.MailApp.sent[0].body, /件数：2/);
});

test('同じ失敗が続いてもメールは 1 時間に 1 通。実行記録には毎回残る', () => {
  const { env, GUARD, summary } = setup();
  for (let i = 0; i < 5; i++) {
    env.WitGas.guard('請求書PDF', boom, { ...GUARD, rethrow: false });
    env.clock.advance(10 * MIN);
  }
  assert.equal(summary().length, 5);
  assert.equal(env.MailApp.sent.length, 1);
  env.clock.advance(HOUR);
  env.WitGas.guard('請求書PDF', boom, { ...GUARD, rethrow: false });
  assert.equal(env.MailApp.sent.length, 2);
});

test('スキップ：ほかの実行がロックを持っていれば fn を動かさず、「スキップ」を残す。メールは送らない', () => {
  const { env, GUARD, summary } = setup();
  env.LockService.holdByOther();
  let called = 0;
  const res = env.WitGas.guard('日次集計', () => { called++; }, GUARD);
  assert.equal(called, 0);
  assert.equal(res.status, 'skipped');
  assert.deepEqual(summary(), [['日次集計', 'スキップ', '', '', 'locked']]);
  assert.equal(env.MailApp.sent.length, 0);
});

test('waitMs はロックに渡す', () => {
  const { env, GUARD, summary } = setup();
  env.LockService.holdByOther({ releaseAfterMs: 2000 });
  const res = env.WitGas.guard('日次集計', () => 'ok', { ...GUARD, waitMs: 5000 });
  assert.equal(res.status, 'success');
  assert.equal(summary()[0][1], '成功');
});

test('resume と組み合わせる：途中の回は「続きあり」、最後の回は「成功」。件数は処理した数', () => {
  const { env, GUARD, summary } = setup();
  const seen = [];
  env.context.invoices = () => env.WitGas.guard('請求書PDF', () => env.WitGas.resume.run({
    key: 'invoices',
    total: 10,
    handler: 'invoices',
    step: (i) => { env.clock.advance(MIN); seen.push(i); }
  }), GUARD);

  const first = env.context.invoices();
  assert.equal(first.status, 'continued');
  assert.equal(first.count, 4);
  while (env.fireNext().fired) { /* 続きのトリガーを順に動かす */ }

  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(summary(), [
    ['請求書PDF', '続きあり', 4, '', 'cursor 4, runs 1'],
    ['請求書PDF', '続きあり', 4, '', 'cursor 8, runs 2'],
    ['請求書PDF', '成功', 2, '', 'cursor 10, runs 3']
  ]);
  assert.equal(env.ScriptApp.getProjectTriggers().length, 0);
  assert.equal(env.MailApp.sent.length, 0);
});

test('resume の途中で失敗したら「失敗」を残して通知し、次の回はその項目から', () => {
  const { env, GUARD, summary } = setup();
  let failOnce = true;
  env.context.invoices = () => env.WitGas.guard('請求書PDF', () => env.WitGas.resume.run({
    key: 'invoices',
    total: 6,
    handler: 'invoices',
    step: (i) => {
      if (i === 5 && failOnce) { failOnce = false; boom(); }
      env.clock.advance(MIN);
    }
  }), GUARD);
  env.context.invoices();                         // 0〜3：続きあり
  assert.throws(() => env.fireNext());            // 4 は成功、5 で失敗
  assert.equal(env.MailApp.sent.length, 1);
  const res = env.context.invoices();             // 5 からやり直して完了
  assert.equal(res.status, 'success');
  assert.deepEqual(summary().map((r) => r[1]), ['続きあり', '失敗', '成功']);
});

test('ctx の件数とメッセージは resume の値より優先する', () => {
  const { env, GUARD, summary } = setup();
  env.WitGas.guard('x', (ctx) => {
    ctx.setCount(100);
    ctx.setMessage('100 行');
    return env.WitGas.resume.run({ key: 'k', total: 3, handler: 'x', step: () => {} });
  }, GUARD);
  assert.deepEqual(summary(), [['x', '成功', 100, '', '100 行']]);
});

test('log: false / notify: false なら記録も通知もしない（ロックだけ）', () => {
  const { env, ss } = setup();
  const res = env.WitGas.guard('x', boom, { log: false, notify: false, rethrow: false });
  assert.equal(res.status, 'failure');
  assert.equal(ss.getSheetByName('実行記録'), null);
  assert.equal(env.MailApp.sent.length, 0);
  assert.equal(env.SpreadsheetApp.calls.length, 0);
});

test('実行記録が書けなくても処理の結果は変えず、ログに残して通知する', () => {
  const { env, ss, GUARD } = setup();
  const sheet = ss.insertSheet('実行記録');
  sheet._appendError = new Error('Service Spreadsheets failed');
  const res = env.WitGas.guard('日次集計', () => 'ok', GUARD);
  assert.equal(res.status, 'success');
  assert.equal(res.value, 'ok');
  assert.ok(env.logs.some((l) => l.level === 'error' && l.message === '[WitGas.guard] runlog failed: 日次集計 (Error)'));
  assert.equal(env.MailApp.sent.length, 1);
  assert.equal(env.MailApp.sent[0].subject, '[WitGas] 失敗: 日次集計 (runlog:Error)');
});

test('通知が送れなくても、元のエラーを投げる', () => {
  const { env, GUARD, summary } = setup();
  env.MailApp.failNextSend(new Error('Service invoked too many times for one day: email.'));
  assert.throws(() => env.WitGas.guard('請求書PDF', boom, GUARD), (e) => e.name === 'TypeError');
  assert.equal(summary()[0][1], '失敗');
  assert.ok(env.logs.some((l) => l.level === 'error' && l.message === '[WitGas.guard] notify failed: 請求書PDF (Error)'));
});

test('ロックの解放に失敗したら「失敗」として残して通知する', () => {
  const { env, GUARD, summary } = setup();
  env.LockService.failNextRelease(new Error('release failed'));
  const res = env.WitGas.guard('日次集計', () => 'ok', { ...GUARD, rethrow: false });
  assert.equal(res.status, 'failure');
  assert.equal(summary()[0][1], '失敗');
  assert.equal(env.MailApp.sent.length, 1);
});

test('async 関数は「失敗」になる（ロックが先に外れるため受け付けない）', () => {
  const { env, GUARD, summary } = setup();
  const res = env.WitGas.guard('x', async () => 1, { ...GUARD, rethrow: false });
  assert.equal(res.status, 'failure');
  assert.equal(res.errorType, 'TypeError');
  assert.equal(summary()[0][1], '失敗');
});

test('linkUrl を渡せばそちらを使う。spreadsheet を渡したときはその URL を使う', () => {
  const { env, ss } = setup();
  env.WitGas.guard('a', boom, {
    log: { spreadsheetId: 'LOG' },
    notify: { to: TO, linkUrl: 'https://example.com/runbook' },
    rethrow: false
  });
  env.WitGas.guard('b', boom, { log: { spreadsheet: ss }, notify: { to: TO }, rethrow: false });
  env.WitGas.guard('c', boom, { log: false, notify: { to: TO }, rethrow: false });
  assert.match(env.MailApp.sent[0].body, /実行記録：https:\/\/example\.com\/runbook/);
  assert.match(env.MailApp.sent[1].body, /実行記録：https:\/\/docs\.google\.com\/spreadsheets\/d\/LOG\/edit/);
  assert.doesNotMatch(env.MailApp.sent[2].body, /実行記録：/);
});

test('ctx は実行が終わったあとには使えない。値がおかしければ fn の失敗になる', () => {
  const { env, GUARD } = setup();
  let saved;
  env.WitGas.guard('x', (ctx) => { saved = ctx; }, GUARD);
  assert.throws(() => saved.setCount(1), /after the run ended/);
  for (const bad of [(c) => c.setCount(-1), (c) => c.addCount(1.5), (c) => c.setMessage(1)]) {
    const res = env.WitGas.guard('x', bad, { ...GUARD, rethrow: false });
    assert.equal(res.status, 'failure');
  }
});

test('設定の誤りは、処理を動かす前に投げる（記録・通知・ロックに触らない）', () => {
  const { env, GUARD } = setup();
  let called = 0;
  const fn = () => { called++; };
  const cases = [
    ['', fn, GUARD],
    ['x', null, GUARD],
    ['x', fn, undefined],
    ['x', fn, { notify: false }],                                   // log がない
    ['x', fn, { log: false }],                                      // notify がない
    ['x', fn, { log: null, notify: false }],
    ['x', fn, { log: false, notify: 'ops@example.com' }],
    ['x', fn, { ...GUARD, notify: { to: 'ops@example' } }],         // 送り先の書き間違い
    ['x', fn, { ...GUARD, notify: { to: TO, throttleMs: 1 } }],
    ['x', fn, { ...GUARD, log: { spreadsheetId: '' } }],
    ['x', fn, { ...GUARD, log: { spreadsheetId: 'LOG', maxRows: 0 } }],
    ['x', fn, { ...GUARD, waitMs: -1 }],
    ['x', fn, { ...GUARD, rethrow: 'no' }]
  ];
  for (const [n, f, o] of cases) {
    assert.throws(() => env.WitGas.guard(n, f, o), (e) => /Error$/.test(e.name) && /^WitGas\./.test(e.message),
      JSON.stringify(o));
  }
  assert.equal(called, 0);
  assert.equal(env.LockService.calls.length, 0);
  assert.equal(env.SpreadsheetApp.calls.length, 0);
  assert.equal(env.MailApp.sent.length, 0);
});

test('guard.js だけをコピーして記録・通知を使おうとしたら、足りないファイルを知らせる', () => {
  const env = createGasEnv({ files: ['guard.js', 'lock.js'] });
  assert.throws(() => env.WitGas.guard('x', () => {}, { log: { spreadsheetId: 'A' }, notify: false }),
    /copy lock\.js, runlog\.js and notify\.js/);
  const res = env.WitGas.guard('x', () => 1, { log: false, notify: false });
  assert.equal(res.status, 'success');
});
