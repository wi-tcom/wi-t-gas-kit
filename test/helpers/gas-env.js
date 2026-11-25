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
const { createSpreadsheetApp } = require('../mocks/spreadsheet-app');
const { createMailApp } = require('../mocks/mail-app');
const { createCacheService } = require('../mocks/cache-service');
const { createUtilities, createSession } = require('../mocks/utilities');

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
 * @param {string[]} [options.extra] src のあとに読み込むファイル（リポジトリからの相対パス。見本のソースなど）
 */
function createGasEnv(options) {
  const opts = options || {};
  const clock = createClock(opts.startMs);
  const { logs, console } = createConsole();
  const LockService = createLockService(clock);
  const PropertiesService = createPropertiesService();
  const ScriptApp = createScriptApp(clock);
  const SpreadsheetApp = createSpreadsheetApp();
  const MailApp = createMailApp();
  const CacheService = createCacheService(clock);
  const Utilities = createUtilities();
  const Session = createSession(opts.timeZone);

  const sandbox = {
    console,
    Date: createFakeDate(clock),
    LockService,
    PropertiesService,
    ScriptApp,
    SpreadsheetApp,
    MailApp,
    CacheService,
    Utilities,
    Session
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
  for (const rel of opts.extra || []) {
    const full = path.join(SRC_DIR, '..', rel);
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
    SpreadsheetApp,
    MailApp,
    CacheService,
    /** 次に動くトリガーを発火させる（時計もその時刻まで進む） */
    fireNext() {
      LockService.newExecution(); // トリガーで動くのは別の実行
      return ScriptApp.fireNext(context);
    },
    /** src が増やしたグローバル名（WitGas だけであるべき） */
    addedGlobals() {
      return Object.keys(context).filter((k) => !baseKeys.has(k));
    }
  };
}

module.exports = { createGasEnv, listSrcFiles };
