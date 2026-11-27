/**
 * WitGas.migrate — データの形の移行
 *
 * 版上げでシートや列の形が変わるときに、決まった順の「段」を動かす。
 * 今の形の版（スキーマの版）はスクリプトのプロパティ「WitGas.schema:<key>」に持ち、まだ動いていない段だけを動かす。
 * 段は何度動かしても結果が変わらない書き方にする（途中で止まっても、もう一度 run すればよいように）。
 *
 * © 2026 wi-t.com Inc.
 */
var WitGas = WitGas || {};

WitGas.migrate = (function () {
  'use strict';

  var VERSION = '0.3.0';
  var PROPERTY_PREFIX = 'WitGas.schema:';
  var LOG_PREFIX = '[WitGas.migrate] ';

  /**
   * まだ動いていない段を、版の小さい順に動かす。1 段終わるたびにスキーマの版を保存する。
   *
   * @param {Object} opts
   * @param {string} opts.key 見本や納品物の名前（プロパティのキーになる）
   * @param {Array<{version: number, name: string, run: function(): void}>} opts.steps 段（版は 1 から増える整数）
   * @param {Object} [opts.properties] 差し替えるときだけ
   * @return {{from: number, to: number, ran: number[]}}
   */
  function run(opts) {
    var cfg = validate_(opts, 'run');
    var from = current_(cfg);
    var latest = latest_(cfg.steps);
    if (from > latest) {
      // データの形がコードより新しい。古いコードに戻したときなど。触らずに止める。
      throw new Error('WitGas.migrate.run: schema ' + from + ' is newer than the code (' + latest + ')');
    }
    var ran = [];
    cfg.steps.forEach(function (step) {
      if (step.version <= from) return;
      console.log(LOG_PREFIX + cfg.key + ': step ' + step.version + ' (' + step.name + ')');
      step.run();
      cfg.properties.setProperty(PROPERTY_PREFIX + cfg.key, String(step.version));
      ran.push(step.version);
    });
    if (ran.length === 0) console.log(LOG_PREFIX + cfg.key + ': up to date (' + from + ')');
    return { from: from, to: ran.length ? ran[ran.length - 1] : from, ran: ran };
  }

  /** 今のスキーマの版（まだ一度も run していなければ 0） */
  function current(key, opts) {
    return current_(validate_({ key: key, steps: [], properties: opts && opts.properties }, 'current', true));
  }

  /** まだ動いていない段があるか */
  function needed(opts) {
    var cfg = validate_(opts, 'needed');
    return current_(cfg) < latest_(cfg.steps);
  }

  // ---- 内部 ----

  function current_(cfg) {
    var raw = cfg.properties.getProperty(PROPERTY_PREFIX + cfg.key);
    if (raw === null || raw === undefined || raw === '') return 0;
    var n = Number(raw);
    if (!isFinite(n) || n < 0 || Math.floor(n) !== n) {
      throw new Error('WitGas.migrate: saved schema version is unreadable (' + PROPERTY_PREFIX + cfg.key + ')');
    }
    return n;
  }

  function latest_(steps) {
    return steps.length ? steps[steps.length - 1].version : 0;
  }

  function validate_(opts, fnName, allowEmpty) {
    var where = 'WitGas.migrate.' + fnName + ': ';
    if (!opts || typeof opts !== 'object') throw new TypeError(where + 'opts is required');
    if (typeof opts.key !== 'string' || opts.key.trim() === '') throw new TypeError(where + 'opts.key must be a non-empty string');
    var steps = opts.steps;
    if (!Array.isArray(steps) || (!allowEmpty && steps.length === 0)) {
      throw new TypeError(where + 'opts.steps must be a non-empty array');
    }
    var prev = 0;
    steps.forEach(function (s) {
      if (!s || typeof s.run !== 'function' || typeof s.name !== 'string' || s.name.trim() === '') {
        throw new TypeError(where + 'each step needs {version, name, run}');
      }
      if (typeof s.version !== 'number' || Math.floor(s.version) !== s.version || s.version !== prev + 1) {
        throw new TypeError(where + 'step versions must be 1, 2, 3, ... in order');
      }
      prev = s.version;
    });
    return {
      key: opts.key,
      steps: steps,
      properties: opts.properties || PropertiesService.getScriptProperties()
    };
  }

  return {
    run: run,
    current: current,
    needed: needed,
    VERSION: VERSION,
    PROPERTY_PREFIX: PROPERTY_PREFIX
  };
})();
