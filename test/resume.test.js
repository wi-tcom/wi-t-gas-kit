'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnv } = require('./helpers/gas-env');
const { MAX_TRIGGERS } = require('./mocks/script-app');

const MIN = 60 * 1000;
const PROP = 'WitGas.resume:invoices';

/**
 * 「1 件 stepMs かかる処理を total 件」する job を env に置く。
 * GAS と同じく、トリガーは関数名（job）で呼ぶ。
 */
function setupJob(env, options) {
  const o = Object.assign({ total: 10, stepMs: MIN, key: 'invoices' }, options);
  const seen = [];
  env.context.job = function () {
    return env.WitGas.resume.run({
      key: o.key,
      total: o.total,
      handler: 'job',
      budgetMs: o.budgetMs,
      step(i) {
        if (o.failAt === i) {
          o.failAt = undefined; // 1 回だけ失敗する
          throw new Error('顧客 山田太郎 の請求書で失敗');
        }
        env.clock.advance(typeof o.stepMs === 'function' ? o.stepMs(i) : o.stepMs);
        seen.push(i);
      }
    });
  };
  return { seen, o };
}

/** トリガーがなくなるまで続きを動かす。各実行の結果と、そのときのトリガー数を返す。 */
function runToEnd(env, maxFires) {
  const results = [env.context.job()];
  const triggerCounts = [env.ScriptApp.getProjectTriggers().length];
  for (let n = 0; n < (maxFires || 50); n++) {
    const f = env.fireNext();
    if (!f.fired) break;
    results.push(f.value);
    triggerCounts.push(env.ScriptApp.getProjectTriggers().length);
  }
  return { results, triggerCounts };
}

test('既定の上限は 4.5 分、続きは 1 分後', () => {
  const env = createGasEnv();
  assert.equal(env.WitGas.resume.DEFAULT_BUDGET_MS, 270000);
  assert.equal(env.WitGas.resume.CONTINUE_AFTER_MS, 60000);
});

test('時間内に終わればトリガーも保存も残さずに完了する', () => {
  const env = createGasEnv();
  const { seen } = setupJob(env, { total: 3, stepMs: 1000 });
  const res = env.context.job();
  assert.deepEqual(seen, [0, 1, 2]);
  assert.equal(res.done, true);
  assert.equal(res.cursor, 3);
  assert.equal(res.processed, 3);
  assert.equal(res.runs, 1);
  assert.equal(res.scheduled, false);
  assert.equal(env.ScriptApp.getProjectTriggers().length, 0);
  assert.deepEqual(env.PropertiesService.dump(), {});
});

test('4.5 分を越える前に区切り、カーソルを保存して 1 分後のトリガーを 1 つ張る', () => {
  const env = createGasEnv();
  const { seen } = setupJob(env, { total: 10, stepMs: MIN });
  const t0 = env.clock.now();
  const res = env.context.job();

  // 1 件 1 分：4 件で 4 分。5 件目をやると 5 分になり 4.5 分を越えるので、4 件で区切る。
  assert.deepEqual(seen, [0, 1, 2, 3]);
  assert.equal(res.done, false);
  assert.equal(res.cursor, 4);
  assert.equal(res.scheduled, true);
  assert.ok(res.elapsedMs <= 270000, 'elapsed ' + res.elapsedMs);

  const triggers = env.ScriptApp.getProjectTriggers();
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].getHandlerFunction(), 'job');
  assert.equal(triggers[0]._dueAt, t0 + res.elapsedMs + MIN);

  const saved = JSON.parse(env.PropertiesService.dump()[PROP]);
  assert.equal(saved.cursor, 4);
  assert.equal(saved.triggerId, triggers[0].getUniqueId());
  assert.deepEqual(
    { ...env.WitGas.resume.get('invoices'), firstStartedAt: null },
    { cursor: 4, runs: 1, firstStartedAt: null, scheduled: true }
  );
});

test('トリガーで続きを動かすと、全件を 1 回ずつ順に処理し、最後はトリガーも保存も残らない', () => {
  const env = createGasEnv();
  const { seen } = setupJob(env, { total: 23, stepMs: MIN });
  const { results, triggerCounts } = runToEnd(env);

  assert.deepEqual(seen, Array.from({ length: 23 }, (_, i) => i));
  const last = results[results.length - 1];
  assert.equal(last.done, true);
  assert.equal(last.runs, results.length);
  assert.equal(results.length, 6); // 4 件ずつ：4+4+4+4+4+3
  for (const r of results) assert.ok(r.elapsedMs <= 270000);
  assert.ok(triggerCounts.every((n) => n <= 1), '同時にあるトリガーは多くても 1 つ: ' + triggerCounts);
  assert.equal(env.ScriptApp.getProjectTriggers().length, 0, '動き終わったトリガーも残らない');
  assert.deepEqual(env.PropertiesService.dump(), {});
});

test('長さがばらばらでも、今までで一番長い 1 件を見込んで上限の前に区切る', () => {
  const env = createGasEnv();
  const durations = [10000, 80000, 20000, 30000, 60000, 90000, 5000, 70000, 40000, 50000, 85000, 15000];
  setupJob(env, { total: durations.length, stepMs: (i) => durations[i] });
  const { results } = runToEnd(env);
  for (const r of results) assert.ok(r.elapsedMs <= 270000, 'elapsed ' + r.elapsedMs);
  assert.equal(results[results.length - 1].done, true);
});

test('上限が短くても 1 回の実行で最低 1 件は進む（進まないままトリガーが続かない）', () => {
  const env = createGasEnv();
  const { seen } = setupJob(env, { total: 3, stepMs: 5000, budgetMs: 1 });
  const { results } = runToEnd(env);
  assert.deepEqual(seen, [0, 1, 2]);
  assert.deepEqual(results.map((r) => r.processed), [1, 1, 1]);
});

test('途中で失敗したら失敗した項目のカーソルを残し、トリガーは張らずにエラーを投げる', () => {
  const env = createGasEnv();
  const { seen } = setupJob(env, { total: 10, stepMs: 1000, failAt: 6 });
  assert.throws(() => env.context.job(), /山田太郎/);
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5]);
  assert.equal(env.WitGas.resume.get('invoices').cursor, 6);
  assert.equal(env.WitGas.resume.get('invoices').scheduled, false);
  assert.equal(env.ScriptApp.getProjectTriggers().length, 0);

  // もう一度呼ぶと、失敗した項目からやり直す（済んだ項目は処理しない）
  const res = env.context.job();
  assert.equal(res.done, true);
  assert.equal(res.runs, 2);
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('続きの実行で失敗しても、動き終わったトリガーは消えている', () => {
  const env = createGasEnv();
  setupJob(env, { total: 10, stepMs: MIN, failAt: 5 });
  env.context.job();                 // 0〜3 で区切る
  assert.equal(env.ScriptApp.getProjectTriggers().length, 1);
  assert.throws(() => env.fireNext()); // 4 は成功、5 で失敗
  assert.equal(env.ScriptApp.getProjectTriggers().length, 0);
  assert.equal(env.WitGas.resume.get('invoices').cursor, 5);
});

test('ログには処理名・カーソル・件数・エラー種別だけを残し、エラーのメッセージは残さない', () => {
  const env = createGasEnv();
  setupJob(env, { total: 10, stepMs: MIN, failAt: 5 });
  env.context.job();
  assert.throws(() => env.fireNext());
  assert.ok(env.logs.some((l) => l.message === '[WitGas.resume] paused: invoices at cursor 4 (processed 4, runs 1)'));
  assert.ok(env.logs.some((l) => l.level === 'error' && l.message === '[WitGas.resume] failed: invoices at cursor 5 (Error)'));
  for (const l of env.logs) assert.ok(!l.message.includes('山田'), l.message);
});

test('hasNext で終わりを決められる（件数が先に分からない場合）', () => {
  const env = createGasEnv();
  const data = ['a', 'b', 'c', 'd', 'e'];
  const out = [];
  env.context.job = () => env.WitGas.resume.run({
    key: 'k',
    handler: 'job',
    hasNext: (c) => c < data.length,
    step: (c) => { env.clock.advance(2 * MIN); out.push(data[c]); }
  });
  runToEnd(env);
  assert.deepEqual(out, data);
  assert.equal(env.ScriptApp.getProjectTriggers().length, 0);
});

test('step が次のカーソルを返せば、まとめて処理できる', () => {
  const env = createGasEnv();
  const batches = [];
  env.context.job = () => env.WitGas.resume.run({
    key: 'k',
    handler: 'job',
    total: 250,
    step: (c) => {
      const end = Math.min(c + 100, 250);
      batches.push([c, end]);
      env.clock.advance(MIN);
      return end;
    }
  });
  const res = env.context.job();
  assert.equal(res.done, true);
  assert.deepEqual(batches, [[0, 100], [100, 200], [200, 250]]);
});

test('step が進まないカーソルを返したら投げ、そのときのカーソルを残す', () => {
  for (const bad of [0, 3, 2.5, -1, '4', null]) {
    const env = createGasEnv();
    let calls = 0;
    env.context.job = () => env.WitGas.resume.run({
      key: 'k',
      handler: 'job',
      total: 10,
      step: (c) => { calls++; return c < 3 ? undefined : bad; }
    });
    assert.throws(() => env.context.job(), (e) => e.name === 'RangeError', String(bad));
    assert.equal(calls, 4);
    assert.equal(env.WitGas.resume.get('k').cursor, 3);
  }
});

test('async の step / hasNext は受け付けない', () => {
  const env = createGasEnv();
  assert.throws(
    () => env.WitGas.resume.run({ key: 'a', handler: 'job', total: 3, step: async () => {} }),
    (e) => e.name === 'TypeError' && /synchronous/.test(e.message)
  );
  assert.throws(
    () => env.WitGas.resume.run({ key: 'b', handler: 'job', hasNext: async () => true, step: () => {} }),
    (e) => e.name === 'TypeError' && /synchronous/.test(e.message)
  );
});

test('トリガーが作れないとき（上限 20 個など）は、カーソルを残してエラーを投げる', () => {
  const env = createGasEnv();
  for (let i = 0; i < MAX_TRIGGERS; i++) env.ScriptApp.addOtherTrigger('other' + i);
  setupJob(env, { total: 10, stepMs: MIN });
  assert.throws(() => env.context.job(), /too many triggers/);
  assert.deepEqual({ ...env.WitGas.resume.get('invoices'), firstStartedAt: null },
    { cursor: 4, runs: 1, firstStartedAt: null, scheduled: false });
});

test('トリガーを作ったあとに保存が失敗したら、そのトリガーを消してから投げる', () => {
  const env = createGasEnv();
  const { seen } = setupJob(env, { total: 10, stepMs: MIN });
  const err = new Error('quota');
  // 区切る直前の保存（トリガー ID の保存）だけを失敗させる
  const props = env.PropertiesService.getScriptProperties();
  const realSet = props.setProperty;
  props.setProperty = function (k, v) {
    if (JSON.parse(v).triggerId) throw err;
    return realSet.call(this, k, v);
  };
  assert.throws(() => env.context.job(), (e) => e === err);
  assert.equal(seen.length, 4);
  assert.equal(env.ScriptApp.getProjectTriggers().length, 0);
});

test('cleanup は続きのトリガーと保存を消す。何もなければ何もしない', () => {
  const env = createGasEnv();
  setupJob(env, { total: 10, stepMs: MIN });
  env.context.job();
  assert.equal(env.ScriptApp.getProjectTriggers().length, 1);

  const r = env.WitGas.resume.cleanup('invoices');
  assert.deepEqual({ ...r }, { deletedTrigger: true, deletedState: true });
  assert.equal(env.ScriptApp.getProjectTriggers().length, 0);
  assert.equal(env.WitGas.resume.get('invoices'), null);

  assert.deepEqual({ ...env.WitGas.resume.cleanup('invoices') }, { deletedTrigger: false, deletedState: false });
});

test('cleanup のあとに run すると最初からやり直す', () => {
  const env = createGasEnv();
  const { seen } = setupJob(env, { total: 6, stepMs: MIN });
  env.context.job();
  env.WitGas.resume.cleanup('invoices');
  seen.length = 0;
  env.context.job();
  assert.equal(seen[0], 0);
});

test('利用者が自分で作ったトリガーは、同じ関数名でも消さない', () => {
  const env = createGasEnv();
  const daily = env.ScriptApp.addOtherTrigger('job'); // 毎日 job を動かすトリガー
  setupJob(env, { total: 10, stepMs: MIN });
  runToEnd(env);
  env.context.job();
  env.WitGas.resume.cleanup('invoices');
  const ids = env.ScriptApp.getProjectTriggers().map((t) => t.getUniqueId());
  assert.deepEqual(ids, [daily.getUniqueId()]);
});

test('key ごとに進み具合は別々', () => {
  const env = createGasEnv();
  const a = [];
  const b = [];
  const mk = (key, out) => () => env.WitGas.resume.run({
    key, handler: 'job', total: 8, step: (i) => { env.clock.advance(MIN); out.push(i); }
  });
  mk('a', a)();
  mk('b', b)();
  assert.equal(env.WitGas.resume.get('a').cursor, 4);
  assert.equal(env.WitGas.resume.get('b').cursor, 4);
  env.WitGas.resume.cleanup('a');
  assert.equal(env.WitGas.resume.get('b').cursor, 4);
  assert.equal(env.ScriptApp.getProjectTriggers().length, 1);
});

test('項目が減ってカーソルが件数を越えていたら、そのまま完了にする', () => {
  const env = createGasEnv();
  const job = setupJob(env, { total: 10, stepMs: MIN });
  env.context.job(); // cursor 4
  job.o.total = 3;
  const res = env.fireNext().value;
  assert.equal(res.done, true);
  assert.equal(res.processed, 0);
  assert.equal(env.ScriptApp.getProjectTriggers().length, 0);
});

test('保存が壊れていたら最初からやり直さずに止める（cleanup で消せる）', () => {
  const env = createGasEnv();
  const props = env.PropertiesService.getScriptProperties();
  let called = 0;
  const run = () => env.WitGas.resume.run({ key: 'invoices', handler: 'job', total: 3, step: () => { called++; } });
  for (const broken of ['{not json', '{"v":1,"cursor":-1,"runs":1,"firstStartedAt":0}', '{"v":99,"cursor":1,"runs":1,"firstStartedAt":0}']) {
    props.setProperty(PROP, broken);
    assert.throws(run, /saved state is unreadable/);
    assert.equal(called, 0);
    assert.equal(props.getProperty(PROP), broken, '壊れた保存も消さずに残す');
  }
  assert.deepEqual({ ...env.WitGas.resume.cleanup('invoices') }, { deletedTrigger: false, deletedState: true });
  run();
  assert.equal(called, 3);
});

test('引数がおかしいときは GAS のサービスに触らずに投げる', () => {
  const env = createGasEnv();
  const run = env.WitGas.resume.run;
  const step = () => {};
  const base = { key: 'k', handler: 'job', total: 3, step };
  const cases = [
    undefined,
    'k',
    { ...base, key: '' },
    { ...base, key: 1 },
    { key: 'k', handler: 'job', step },                          // total も hasNext もない
    { ...base, hasNext: () => true },                            // 両方ある
    { ...base, total: -1 },
    { ...base, total: 1.5 },
    { key: 'k', handler: 'job', hasNext: true, step },
    { ...base, step: undefined },
    { ...base, handler: '' },
    { ...base, handler: undefined },
    { ...base, budgetMs: 0 },
    { ...base, budgetMs: 6 * MIN + 1 },
    { ...base, budgetMs: 1000.5 }
  ];
  for (const c of cases) {
    assert.throws(() => run(c), (e) => /Error$/.test(e.name) && /^WitGas\.resume\.run:/.test(e.message), JSON.stringify(c));
  }
  assert.throws(() => env.WitGas.resume.get(''), /^TypeError: WitGas\.resume\.get:/);
  assert.throws(() => env.WitGas.resume.cleanup(null), /^TypeError: WitGas\.resume\.cleanup:/);
  assert.equal(env.PropertiesService.writes, 0);
  assert.equal(env.ScriptApp.stats.created, 0);
});

test('opts.properties / opts.scriptApp を渡せばそちらを使う', () => {
  const env = createGasEnv();
  const store = {};
  const myProps = {
    getProperty: (k) => (k in store ? store[k] : null),
    setProperty: (k, v) => { store[k] = v; },
    deleteProperty: (k) => { delete store[k]; }
  };
  const created = [];
  const myScriptApp = {
    newTrigger: (h) => ({ timeBased: () => ({ after: (ms) => ({ create: () => {
      const t = { getUniqueId: () => 't1', h, ms };
      created.push(t);
      return t;
    } }) }) }),
    getProjectTriggers: () => created.slice(),
    deleteTrigger: (t) => { created.splice(created.indexOf(t), 1); }
  };
  const opts = { properties: myProps, scriptApp: myScriptApp };
  const res = env.WitGas.resume.run({
    key: 'k', handler: 'job', total: 10, step: () => { env.clock.advance(MIN); }, ...opts
  });
  assert.equal(res.scheduled, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].h, 'job');
  assert.equal(created[0].ms, MIN);
  assert.equal(JSON.parse(store['WitGas.resume:k']).cursor, 4);
  assert.equal(env.WitGas.resume.get('k', opts).cursor, 4);
  env.WitGas.resume.cleanup('k', opts);
  assert.equal(created.length, 0);
  assert.deepEqual(store, {});
  assert.deepEqual(env.PropertiesService.dump(), {});
  assert.equal(env.ScriptApp.stats.created, 0);
});

test('lock と組み合わせる：続きの回がほかの実行とぶつかってスキップしても、次に呼べば続きから進み、古いトリガーも消える', () => {
  const env = createGasEnv();
  const seen = [];
  env.context.job = () => env.WitGas.lock.run('請求書', () => env.WitGas.resume.run({
    key: 'invoices', handler: 'job', total: 10, step: (i) => { env.clock.advance(MIN); seen.push(i); }
  }));

  env.context.job();                                    // 0〜3
  env.LockService.holdByOther({ releaseAfterMs: 2 * MIN });
  const skipped = env.fireNext().value;                 // 続きの回はロックが取れない
  assert.equal(skipped.skipped, true);
  assert.equal(env.WitGas.resume.get('invoices').cursor, 4);
  assert.equal(env.ScriptApp.pending().length, 0, '続きのトリガーはもう張られていない');
  assert.equal(env.ScriptApp.getProjectTriggers().length, 1, '動き終わったトリガーは次の run まで残る');

  env.clock.advance(2 * MIN);
  const r = runToEnd(env);                              // 手動や毎日のトリガーで呼ばれたとする
  assert.equal(r.results[r.results.length - 1].value.done, true);
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(env.ScriptApp.getProjectTriggers().length, 0);
});
