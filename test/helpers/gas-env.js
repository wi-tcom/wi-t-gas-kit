'use strict';

/**
 * src/ のファイルを GAS に近い形（1 つの共有グローバル）で読み込み、
 * GAS のサービスを偽物に差し替えた環境を作る。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createClock, createFakeDate } = require('../mocks/clock');
const { createLockService } = require('../mocks/lock-service');
const { createPropertiesService } = require('../mocks/properties-service');
const { createScriptApp } = require('../mocks/script-app');

const SRC_DIR = path.join(__dirname, '..', '..', 'src');

function listSrcFiles() {
  return fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js')).sort();
}

function createConsole() {
  const logs = [];
  const make = (level) => (...args) => {
    logs.push({ level, message: args.map(String).join(' ') });
  };
  return { logs, console: { log: make('log'), info: make('info'), warn: make('warn'), error: make('error') } };
}

/**
 * @param {Object} [options]
 * @param {string[]} [options.files] 読み込む src のファイル名（既定は src/*.js をすべて、名前順）
 * @param {string[]} [options.prelude] src より先に実行するコード（読み込み順の確認用）
 */
function createGasEnv(options) {
  const opts = options || {};
  const clock = createClock(opts.startMs);
  const { logs, console } = createConsole();
  const LockService = createLockService(clock);
  const PropertiesService = createPropertiesService();
  const ScriptApp = createScriptApp(clock);

  const sandbox = {
    console,
    Date: createFakeDate(clock),
    LockService,
    PropertiesService,
    ScriptApp
  };
  const context = vm.createContext(sandbox);
  const baseKeys = new Set(Object.keys(sandbox));

  for (const code of opts.prelude || []) {
    vm.runInContext(code, context, { filename: 'prelude.js' });
  }
  for (const file of opts.files || listSrcFiles()) {
    const full = path.join(SRC_DIR, file);
    vm.runInContext(fs.readFileSync(full, 'utf8'), context, { filename: full });
  }

  return {
    context,
    WitGas: context.WitGas,
    clock,
    logs,
    LockService,
    PropertiesService,
    ScriptApp,
    /** 次に動くトリガーを発火させる（時計もその時刻まで進む） */
    fireNext() {
      return ScriptApp.fireNext(context);
    },
    /** src が増やしたグローバル名（WitGas だけであるべき） */
    addedGlobals() {
      return Object.keys(context).filter((k) => !baseKeys.has(k));
    }
  };
}

module.exports = { createGasEnv, listSrcFiles };
