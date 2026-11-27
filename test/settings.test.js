'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnv } = require('./helpers/gas-env');

const ITEMS = [
  { key: '明細のシート', value: '明細', note: '帳票のもとの表' },
  { key: '1 回の上限（ミリ秒）', value: 270000, type: 'number' },
  { key: '自動で動かす', value: false, type: 'boolean' },
  { key: '失敗の通知先', value: 'ops@example.com', type: 'email', required: true }
];

function setup() {
  const env = createGasEnv();
  const ss = env.SpreadsheetApp.addSpreadsheet('BOOK', { active: true });
  const sheet = () => ss.getSheetByName('設定');
  return { env, ss, sheet };
}

test('ensure：「設定」シートを作り、見出しと既定の値を書く', () => {
  const { env, sheet } = setup();
  const res = env.WitGas.settings.ensure({ items: ITEMS });
  assert.deepEqual(Array.from(res.added), ITEMS.map((i) => i.key));
  assert.deepEqual(sheet().values().map((r) => Array.from(r)), [
    ['項目', '値', '説明'],
    ['明細のシート', '明細', '帳票のもとの表'],
    ['1 回の上限（ミリ秒）', 270000, ''],
    ['自動で動かす', false, ''],
    ['失敗の通知先', 'ops@example.com', '']
  ]);
  assert.equal(sheet().getFrozenRows(), 1);
});

test('ensure：今ある値は書き換えず、足りない項目だけを足す（何度動かしても同じ）', () => {
  const { env, sheet } = setup();
  env.WitGas.settings.ensure({ items: ITEMS.slice(0, 2) });
  sheet().getRange(2, 2, 1, 1).setValues([['売上明細']]); // 先方が変えた
  const res = env.WitGas.settings.ensure({ items: ITEMS });
  assert.deepEqual(Array.from(res.added), ['自動で動かす', '失敗の通知先']);
  const again = env.WitGas.settings.ensure({ items: ITEMS });
  assert.deepEqual(Array.from(again.added), []);
  assert.equal(sheet().values()[1][1], '売上明細');
  assert.equal(sheet().values().length, 5);
});

test('read：シートの値を型に合わせて読む。シートにない項目は既定の値', () => {
  const { env, sheet } = setup();
  env.WitGas.settings.ensure({ items: ITEMS });
  sheet().getRange(3, 2, 2, 1).setValues([['1,000'], ['はい']]);
  const v = env.WitGas.settings.read({ items: ITEMS.concat([{ key: '新しい項目', value: '既定' }]) });
  assert.deepEqual({ ...v }, {
    '明細のシート': '明細', '1 回の上限（ミリ秒）': 1000, '自動で動かす': true,
    '失敗の通知先': 'ops@example.com', '新しい項目': '既定'
  });
});

test('read：型に合わない値・必須の空は SettingsError（項目名だけを書き、値は書かない）', () => {
  const { env, sheet } = setup();
  env.WitGas.settings.ensure({ items: ITEMS });
  const bad = [
    [3, '多め', '「設定」シートの「1 回の上限（ミリ秒）」の値が数ではありません。'],
    [4, 'たぶん', '「設定」シートの「自動で動かす」の値は「はい」か「いいえ」にしてください。'],
    [5, '山田太郎', '「設定」シートの「失敗の通知先」の値がメールアドレスになっていません。'],
    [5, '', '「設定」シートの「失敗の通知先」が空です。']
  ];
  for (const [row, value, message] of bad) {
    env.WitGas.settings.ensure({ items: ITEMS });
    const s = sheet();
    const keep = s.values()[row - 1][1];
    s.getRange(row, 2, 1, 1).setValues([[value]]);
    assert.throws(() => env.WitGas.settings.read({ items: ITEMS }),
      (e) => e.name === 'SettingsError' && e.message === message && (value === '' || !e.message.includes(value)));
    s.getRange(row, 2, 1, 1).setValues([[keep]]);
  }
});

test('引数がおかしいときは投げる', () => {
  const { env } = setup();
  const cases = [undefined, {}, { items: [] }, { items: [{ value: 1 }] }, { items: [{ key: 'a' }, { key: 'a' }] },
    { items: [{ key: 'a', type: 'date' }] }, { items: ITEMS, sheetName: '' }];
  for (const c of cases) {
    assert.throws(() => env.WitGas.settings.read(c), /^TypeError: WitGas\.settings\.read:/, JSON.stringify(c));
  }
});
