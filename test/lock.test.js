'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnv } = require('./helpers/gas-env');

function methods(env) {
  return env.LockService.calls.map((c) => c.method);
}

test('ロックが空いていれば fn を実行し、結果を返して解放する', () => {
  const env = createGasEnv();
  let called = 0;
  const res = env.WitGas.lock.run('集計', () => {
    called++;
    assert.equal(env.LockService.isHeld(), true, '実行中はロックを持っている');
    return 42;
  });
  assert.equal(called, 1);
  assert.deepEqual({ ...res }, { skipped: false, value: 42 });
  assert.equal(env.LockService.isHeld(), false, '終わったら解放されている');
  assert.deepEqual(methods(env), ['getScriptLock', 'tryLock', 'releaseLock']);
});

test('waitMs の既定は 0（tryLock(0) で待たない）', () => {
  const env = createGasEnv();
  env.WitGas.lock.run('集計', () => {});
  const tryCall = env.LockService.calls.find((c) => c.method === 'tryLock');
  assert.equal(tryCall.timeoutInMillis, 0);
  assert.equal(env.WitGas.lock.DEFAULT_WAIT_MS, 0);
});

test('fn が失敗しても必ず解放し、同じエラーを投げる', () => {
  const env = createGasEnv();
  const boom = new Error('boom');
  assert.throws(() => env.WitGas.lock.run('集計', () => { throw boom; }), (e) => e === boom);
  assert.equal(env.LockService.isHeld(), false);
  assert.deepEqual(methods(env), ['getScriptLock', 'tryLock', 'releaseLock']);
});

test('ほかの実行がロックを持っていれば fn を実行せずスキップを返す', () => {
  const env = createGasEnv();
  env.LockService.holdByOther();
  let called = 0;
  const res = env.WitGas.lock.run('集計', () => { called++; });
  assert.equal(called, 0);
  assert.deepEqual({ ...res }, { skipped: true, reason: 'locked', name: '集計' });
  assert.ok(!methods(env).includes('releaseLock'), '持っていないロックは解放しない');
  assert.equal(env.LockService.isHeld(), true, 'ほかの実行のロックはそのまま');
});

test('スキップしたら実行ログに「skipped」と残し、onSkip に記録用の情報を渡す', () => {
  const env = createGasEnv();
  env.LockService.holdByOther();
  const entries = [];
  env.WitGas.lock.run('請求書PDF', () => {}, { onSkip: (e) => entries.push(e) });

  assert.ok(env.logs.some((l) => l.level === 'log' && l.message.includes('skipped: 請求書PDF (locked)')));
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.name, '請求書PDF');
  assert.equal(e.result, 'skipped');
  assert.equal(e.reason, 'locked');
  assert.equal(e.startedAt.getTime(), env.clock.now());
  assert.equal(e.endedAt.getTime(), env.clock.now());
  assert.deepEqual(Object.keys(e).sort(), ['endedAt', 'name', 'reason', 'result', 'startedAt']);
});

test('実行中に同じ処理がもう一度呼ばれても二重には動かない', () => {
  const env = createGasEnv();
  const order = [];
  let inner;
  env.WitGas.lock.run('集計', () => {
    order.push('outer');
    inner = env.WitGas.lock.run('集計', () => { order.push('inner'); });
  });
  assert.deepEqual(order, ['outer']);
  assert.equal(inner.skipped, true);
  assert.equal(env.LockService.isHeld(), false);
});

test('前の実行が終われば次の実行はロックを取れる', () => {
  const env = createGasEnv();
  const a = env.WitGas.lock.run('集計', () => 'a');
  const b = env.WitGas.lock.run('集計', () => 'b');
  assert.equal(a.value, 'a');
  assert.equal(b.value, 'b');
});

test('waitMs 以内にロックが空けば待って実行する', () => {
  const env = createGasEnv();
  const t0 = env.clock.now();
  env.LockService.holdByOther({ releaseAfterMs: 3000 });
  const res = env.WitGas.lock.run('集計', () => 'ok', { waitMs: 5000 });
  assert.equal(res.value, 'ok');
  assert.equal(env.clock.now() - t0, 3000, '空いた時点で取れる');
});

test('waitMs 以内に空かなければスキップする（待つのは waitMs まで）', () => {
  const env = createGasEnv();
  const t0 = env.clock.now();
  env.LockService.holdByOther({ releaseAfterMs: 3000 });
  let called = 0;
  const res = env.WitGas.lock.run('集計', () => { called++; }, { waitMs: 1000 });
  assert.equal(called, 0);
  assert.equal(res.skipped, true);
  assert.equal(env.clock.now() - t0, 1000);
});

test('引数がおかしいときはロックに触らずに投げる', () => {
  const env = createGasEnv();
  const run = env.WitGas.lock.run;
  const fn = () => {};
  const cases = [
    () => run('', fn),
    () => run('   ', fn),
    () => run(undefined, fn),
    () => run(123, fn),
    () => run('集計', null),
    () => run('集計', 'fn'),
    () => run('集計', fn, { waitMs: -1 }),
    () => run('集計', fn, { waitMs: 1.5 }),
    () => run('集計', fn, { waitMs: NaN }),
    () => run('集計', fn, { waitMs: Infinity }),
    () => run('集計', fn, { waitMs: '100' }),
    () => run('集計', fn, { onSkip: 'x' })
  ];
  for (const c of cases) {
    assert.throws(c, (e) => /Error$/.test(e.name) && /^WitGas\.lock\.run:/.test(e.message));
  }
  assert.equal(env.LockService.calls.length, 0);
});

test('fn 成功後に解放が失敗したら、そのエラーを投げる（ロックの残りに気づける）', () => {
  const env = createGasEnv();
  const relErr = new Error('release failed');
  env.LockService.failNextRelease(relErr);
  assert.throws(() => env.WitGas.lock.run('集計', () => 1), (e) => e === relErr);
});

test('fn が失敗し解放も失敗したら、fn のエラーを優先して投げ、解放の失敗はログに残す', () => {
  const env = createGasEnv();
  const boom = new TypeError('boom');
  env.LockService.failNextRelease(new Error('release failed'));
  assert.throws(() => env.WitGas.lock.run('集計', () => { throw boom; }), (e) => e === boom);
  assert.ok(env.logs.some((l) => l.level === 'error' && l.message.includes('release failed after error: 集計 (Error)')));
});

test('ログには処理名とエラー種別だけを残し、エラーのメッセージ（業務データを含みうる）は残さない', () => {
  const env = createGasEnv();
  env.LockService.failNextRelease(new Error('顧客 山田太郎 の行で失敗'));
  assert.throws(() => env.WitGas.lock.run('集計', () => { throw new Error('x'); }));
  env.LockService.holdByOther();
  env.WitGas.lock.run('集計', () => {}, { onSkip: () => { throw new Error('山田太郎'); } });
  for (const l of env.logs) {
    assert.ok(!l.message.includes('山田'), l.message);
  }
});

test('onSkip が失敗してもスキップの結果は変わらず、ログに残る', () => {
  const env = createGasEnv();
  env.LockService.holdByOther();
  const res = env.WitGas.lock.run('集計', () => {}, { onSkip: () => { throw new RangeError('x'); } });
  assert.equal(res.skipped, true);
  assert.ok(env.logs.some((l) => l.level === 'error' && l.message.includes('onSkip failed: 集計 (RangeError)')));
});

test('tryLock 自体が失敗したら fn を実行せずにそのエラーを投げる', () => {
  const env = createGasEnv();
  const err = new Error('Lock service unavailable');
  env.LockService.failNextTryLock(err);
  let called = 0;
  assert.throws(() => env.WitGas.lock.run('集計', () => { called++; }), (e) => e === err);
  assert.equal(called, 0);
});

test('opts.lock を渡せばそのロックを使う（LockService は呼ばない）', () => {
  const env = createGasEnv();
  const calls = [];
  const myLock = {
    tryLock(ms) { calls.push(['tryLock', ms]); return true; },
    releaseLock() { calls.push(['releaseLock']); }
  };
  const res = env.WitGas.lock.run('集計', () => 'v', { lock: myLock, waitMs: 10 });
  assert.equal(res.value, 'v');
  assert.deepEqual(calls, [['tryLock', 10], ['releaseLock']]);
  assert.equal(env.LockService.calls.length, 0);
});

test('async 関数は受け付けない（ロックが先に外れてしまうため）。ロックは解放される', () => {
  const env = createGasEnv();
  assert.throws(
    () => env.WitGas.lock.run('集計', async () => 1),
    (e) => e.name === 'TypeError' && /synchronous/.test(e.message)
  );
  assert.equal(env.LockService.isHeld(), false);
});

test('グローバルに増やす名前は WitGas だけ', () => {
  const env = createGasEnv();
  assert.deepEqual(env.addedGlobals(), ['WitGas']);
});

test('ほかのファイルが先に WitGas を作っていても上書きしない（読み込み順に依存しない）', () => {
  const env = createGasEnv({ prelude: ['var WitGas = { other: 1 };'] });
  assert.equal(env.WitGas.other, 1);
  assert.equal(typeof env.WitGas.lock.run, 'function');
});
