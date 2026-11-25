'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnv } = require('./helpers/gas-env');

const HOUR = 60 * 60 * 1000;
const TO = 'ops@example.com';

function setup(options) {
  const env = createGasEnv(Object.assign({ startMs: Date.UTC(2026, 0, 5, 0, 30, 0) }, options));
  const fail = (info, opts) => env.WitGas.notify.failure(
    Object.assign({ name: '請求書PDF', error: new TypeError('顧客 山田太郎 の行で失敗') }, info),
    Object.assign({ to: TO }, opts)
  );
  return { env, fail };
}

test('失敗を MailApp で知らせる：件名と本文に処理名・エラー種別・時刻', () => {
  const { env, fail } = setup();
  const res = fail({ count: 3 }, { linkUrl: 'https://docs.google.com/spreadsheets/d/SS1/edit' });
  assert.deepEqual({ ...res }, { sent: true });
  assert.equal(env.MailApp.sent.length, 1);
  const m = env.MailApp.sent[0];
  assert.equal(m.to, TO);
  assert.equal(m.subject, '[WitGas] 失敗: 請求書PDF (TypeError)');
  assert.match(m.body, /処理名：請求書PDF/);
  assert.match(m.body, /エラー種別：TypeError/);
  assert.match(m.body, /時刻：2026-01-05 09:30:00（Asia\/Tokyo）/);
  assert.match(m.body, /件数：3/);
  assert.match(m.body, /実行記録：https:\/\/docs\.google\.com\/spreadsheets\/d\/SS1\/edit/);
  assert.match(m.body, /1 時間に 1 通まで/);
});

test('エラーのメッセージ（業務データを含みうる）はメールにもログにも書かない', () => {
  const { env, fail } = setup();
  fail();
  fail();
  const m = env.MailApp.sent[0];
  assert.ok(!m.subject.includes('山田') && !m.body.includes('山田'));
  for (const l of env.logs) assert.ok(!l.message.includes('山田'), l.message);
});

test('同じ処理・同じエラーは 1 時間に 1 通まで', () => {
  const { env, fail } = setup();
  assert.equal(fail().sent, true);
  env.clock.advance(HOUR - 1000);
  const second = fail();
  assert.deepEqual({ ...second }, { sent: false, reason: 'throttled' });
  assert.equal(env.MailApp.sent.length, 1);
  assert.ok(env.logs.some((l) => l.message === '[WitGas.notify] throttled: 請求書PDF (TypeError)'));

  env.clock.advance(1000); // 最初の通知からちょうど 1 時間
  assert.equal(fail().sent, true);
  assert.equal(env.MailApp.sent.length, 2);
});

test('1 時間のあいだに何度失敗しても届くのは 1 通', () => {
  const { env, fail } = setup();
  for (let i = 0; i < 60; i++) {
    fail();
    env.clock.advance(60 * 1000);
  }
  assert.equal(env.MailApp.sent.length, 1);
  fail();
  assert.equal(env.MailApp.sent.length, 2);
});

test('処理名かエラー種別が違えば別に知らせる', () => {
  const { env, fail } = setup();
  fail();
  fail({ name: '日次集計' });
  fail({ error: new RangeError('x') });
  fail({ error: undefined, errorType: 'Timeout' });
  assert.deepEqual(env.MailApp.sent.map((m) => m.subject), [
    '[WitGas] 失敗: 請求書PDF (TypeError)',
    '[WitGas] 失敗: 日次集計 (TypeError)',
    '[WitGas] 失敗: 請求書PDF (RangeError)',
    '[WitGas] 失敗: 請求書PDF (Timeout)'
  ]);
});

test('抑える時間は CacheService に入れる（既定 3600 秒、キーは 250 文字以内）', () => {
  const { env, fail } = setup();
  fail({ name: 'あ'.repeat(300) });
  const put = env.CacheService.puts[0];
  assert.equal(put.ttl, 3600);
  assert.ok(put.key.startsWith('WitGas.notify:'));
  assert.ok(put.key.length <= 250);
  assert.equal(env.WitGas.notify.DEFAULT_THROTTLE_MS, HOUR);
});

test('throttleMs で抑える時間を変えられる', () => {
  const { env, fail } = setup();
  fail({}, { throttleMs: 10 * 60 * 1000 });
  assert.match(env.MailApp.sent[0].body, /10 分に 1 通まで/);
  env.clock.advance(10 * 60 * 1000);
  fail({}, { throttleMs: 10 * 60 * 1000 });
  assert.equal(env.MailApp.sent.length, 2);
  assert.equal(env.CacheService.puts[0].ttl, 600);
});

test('送れなかったら抑えない（次の失敗でもう一度送る）', () => {
  const { env, fail } = setup();
  const err = new Error('Service invoked too many times for one day: email.');
  env.MailApp.failNextSend(err);
  assert.throws(() => fail(), (e) => e === err);
  assert.equal(env.CacheService.puts.length, 0);
  assert.equal(fail().sent, true);
});

test('キャッシュが先に消えると、1 時間以内でももう 1 通届く（CacheService は消えることがある）', () => {
  const { env, fail } = setup();
  fail();
  env.CacheService.evictAll();
  assert.equal(fail().sent, true);
  assert.equal(env.MailApp.sent.length, 2);
});

test('送り先はカンマ区切りでも配列でもよい', () => {
  const { env, fail } = setup();
  fail({ name: 'a' }, { to: ' a@example.com , b@example.com ' });
  fail({ name: 'b' }, { to: ['a@example.com', 'c@example.jp'] });
  assert.deepEqual(env.MailApp.sent.map((m) => m.to), ['a@example.com,b@example.com', 'a@example.com,c@example.jp']);
});

test('error も errorType もなければ種別は Error。件名の接頭辞とタイムゾーンを変えられる', () => {
  const { env } = setup({ timeZone: 'UTC' });
  env.WitGas.notify.failure({ name: 'x' }, { to: TO, subjectPrefix: '[株式会社サンプル]' });
  env.WitGas.notify.failure({ name: 'y' }, { to: TO, timeZone: 'Asia/Tokyo' });
  assert.equal(env.MailApp.sent[0].subject, '[株式会社サンプル] 失敗: x (Error)');
  assert.match(env.MailApp.sent[0].body, /時刻：2026-01-05 00:30:00（UTC）/);
  assert.match(env.MailApp.sent[1].body, /時刻：2026-01-05 09:30:00（Asia\/Tokyo）/);
});

test('処理名・種別の改行はなくす（件名を壊さない）', () => {
  const { env, fail } = setup();
  fail({ name: 'a\r\nBcc: x@example.com', error: undefined, errorType: 'T\nX' });
  assert.equal(env.MailApp.sent[0].subject, '[WitGas] 失敗: a Bcc: x@example.com (T X)');
});

test('引数がおかしいときはメールもキャッシュも触らずに投げる', () => {
  const { env } = setup();
  const f = env.WitGas.notify.failure;
  const info = { name: 'x' };
  const cases = [
    [undefined, { to: TO }],
    [{ name: '' }, { to: TO }],
    [{ name: 'x', at: 'now' }, { to: TO }],
    [{ name: 'x', count: -1 }, { to: TO }],
    [info, undefined],
    [info, {}],
    [info, { to: '' }],
    [info, { to: ' , ' }],
    [info, { to: [] }],
    [info, { to: 'not-an-address' }],
    [info, { to: 'a@example.com;b@example.com' }],
    [info, { to: ['a@example.com', 1] }],
    [info, { to: TO, throttleMs: 1000 }],
    [info, { to: TO, throttleMs: 7 * HOUR }],
    [info, { to: TO, throttleMs: 1.5 * 60000 + 0.5 }],
    [info, { to: TO, subjectPrefix: 1 }],
    [info, { to: TO, linkUrl: 'javascript:alert(1)' }]
  ];
  for (const [i, o] of cases) {
    assert.throws(() => f(i, o), (e) => /Error$/.test(e.name) && /^WitGas\.notify\.failure:/.test(e.message),
      JSON.stringify([i, o]));
  }
  assert.equal(env.MailApp.sent.length, 0);
  assert.equal(env.CacheService.puts.length, 0);
});

test('エラーにアドレスを書かない（何番目かだけ）', () => {
  const { env } = setup();
  assert.throws(() => env.WitGas.notify.failure({ name: 'x' }, { to: 'a@example.com,yamada taro@example' }),
    (e) => e.message.endsWith('(#2)') && !e.message.includes('yamada'));
});
