'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createGasEnv, listSrcFiles } = require('./helpers/gas-env');

function steps(log) {
  return [
    { version: 1, name: '設定シートを作る', run: () => log.push(1) },
    { version: 2, name: '作成記録に列を足す', run: () => log.push(2) },
    { version: 3, name: '列の名前を変える', run: () => log.push(3) }
  ];
}

test('まだ動いていない段を順に動かし、1 段ごとにスキーマの版を保存する', () => {
  const env = createGasEnv();
  const log = [];
  const res = env.WitGas.migrate.run({ key: 'pdfBatch', steps: steps(log) });
  assert.deepEqual(log, [1, 2, 3]);
  assert.deepEqual({ ...res, ran: Array.from(res.ran) }, { from: 0, to: 3, ran: [1, 2, 3] });
  assert.equal(env.PropertiesService.dump()['WitGas.schema:pdfBatch'], '3');
  assert.equal(env.WitGas.migrate.current('pdfBatch'), 3);
});

test('何度動かしても、済んだ段は動かさない', () => {
  const env = createGasEnv();
  const log = [];
  env.WitGas.migrate.run({ key: 'k', steps: steps(log).slice(0, 1) }); // 1.0.0 のころ
  assert.equal(env.WitGas.migrate.needed({ key: 'k', steps: steps([]) }), true);
  env.WitGas.migrate.run({ key: 'k', steps: steps(log) });             // 版上げ
  env.WitGas.migrate.run({ key: 'k', steps: steps(log) });             // もう一度
  assert.deepEqual(log, [1, 2, 3]);
  assert.equal(env.WitGas.migrate.needed({ key: 'k', steps: steps([]) }), false);
});

test('途中の段で失敗したら、そこまでの版を残して投げる。直してもう一度動かせば続きから', () => {
  const env = createGasEnv();
  const log = [];
  let fail = true;
  const s = steps(log);
  s[1].run = () => { if (fail) throw new Error('列が見つからない'); log.push(2); };
  assert.throws(() => env.WitGas.migrate.run({ key: 'k', steps: s }), /列が見つからない/);
  assert.equal(env.WitGas.migrate.current('k'), 1);
  fail = false;
  env.WitGas.migrate.run({ key: 'k', steps: s });
  assert.deepEqual(log, [1, 2, 3]);
});

test('データの形がコードより新しいとき（古いコードに戻したとき）は、触らずに止める', () => {
  const env = createGasEnv();
  env.PropertiesService.getScriptProperties().setProperty('WitGas.schema:k', '5');
  assert.throws(() => env.WitGas.migrate.run({ key: 'k', steps: steps([]) }), /schema 5 is newer than the code \(3\)/);
});

test('段の版は 1, 2, 3 … の順。引数がおかしいときは投げる', () => {
  const env = createGasEnv();
  const run = () => {};
  const cases = [
    { key: '', steps: [{ version: 1, name: 'a', run }] },
    { key: 'k', steps: [] },
    { key: 'k', steps: [{ version: 2, name: 'a', run }] },
    { key: 'k', steps: [{ version: 1, name: 'a', run }, { version: 3, name: 'b', run }] },
    { key: 'k', steps: [{ version: 1, name: '', run }] },
    { key: 'k', steps: [{ version: 1, name: 'a' }] }
  ];
  for (const c of cases) assert.throws(() => env.WitGas.migrate.run(c), /^TypeError: WitGas\.migrate\.run:/);
  env.PropertiesService.getScriptProperties().setProperty('WitGas.schema:x', 'abc');
  assert.throws(() => env.WitGas.migrate.current('x'), /unreadable/);
});

test('すべての部品の版（VERSION）と WitGas.version は package.json の版と同じ', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const env = createGasEnv();
  assert.equal(env.WitGas.version, pkg.version);
  const parts = Object.keys(env.WitGas).filter((k) => k !== 'version');
  assert.equal(parts.length, listSrcFiles().length - 1, 'version.js 以外の部品はどれも VERSION を持つ');
  for (const k of parts) assert.equal(env.WitGas[k].VERSION, pkg.version, k);
});
