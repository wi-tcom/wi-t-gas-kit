/**
 * WitGas.resume — 続き実行
 *
 * 1 回の実行で決めた時間（既定 4.5 分）を越える前に区切り、進み具合（カーソル）を
 * スクリプトのプロパティに保存して、1 分後に 1 回だけ動くトリガーで続きを動かす。
 * 終わったらカーソルとトリガーを消す。
 *
 * © 2026 wi-t.com Inc.
 */
var WitGas = WitGas || {};

WitGas.resume = (function () {
  'use strict';

  var DEFAULT_BUDGET_MS = 4.5 * 60 * 1000;
  var MAX_BUDGET_MS = 6 * 60 * 1000;
  var CONTINUE_AFTER_MS = 60 * 1000;
  var PROPERTY_PREFIX = 'WitGas.resume:';
  var STATE_VERSION = 1;
  // 最初の項目の前に上限に届きそうで、何も処理せずに区切った回がこの数だけ続いたら、エラーにして止める
  var MAX_STALLS = 3;
  var LOG_PREFIX = '[WitGas.resume] ';

  /**
   * 区切りながら最後まで処理する。続きがあればトリガーを張って戻る。
   *
   * @param {Object} opts
   * @param {string} opts.key 処理を見分ける名前（プロパティのキーになる）
   * @param {number} [opts.total] 項目の数。cursor が 0〜total-1 を進む（hasNext とどちらか一方）
   * @param {function(number): boolean} [opts.hasNext] cursor の項目があるか（total とどちらか一方）
   * @param {function(number): (number|undefined)} opts.step cursor の項目を処理する。
   *     何も返さなければ次は cursor+1。cursor より大きい整数を返せばそこから続ける（まとめて処理する場合）
   * @param {string} opts.handler 続きを動かすトリガーが呼ぶ関数名（この run を呼んでいる関数）
   * @param {number} [opts.budgetMs=270000] 1 回の実行で使う時間の上限（ミリ秒）
   * @param {Object} [opts.properties] 使うプロパティ。省略時は PropertiesService.getScriptProperties()
   * @param {Object} [opts.scriptApp] トリガーを作る相手。省略時は ScriptApp
   * @return {{done: boolean, cursor: number, processed: number, runs: number,
   *     scheduled: boolean, elapsedMs: number, setupMs: number, stalled: boolean}}
   *     setupMs は最初の項目に入るまでの時間、stalled は最初の項目の前に区切ったか
   */
  function run(opts) {
    var startedMs = Date.now();
    var cfg = validate_(opts);
    var props = cfg.properties || PropertiesService.getScriptProperties();
    var scriptApp = cfg.scriptApp || ScriptApp;
    var propKey = PROPERTY_PREFIX + cfg.key;

    var saved = readState_(props, propKey);
    var cursor = saved ? saved.cursor : 0;
    var runs = (saved ? saved.runs : 0) + 1;
    var firstStartedAt = saved ? saved.firstStartedAt : startedMs;
    var savedStepMs = saved && saved.lastStepMs ? saved.lastStepMs : 0;
    var stalls = saved && saved.stalls ? saved.stalls : 0;

    // この実行を呼んだ（もう動き終わった）トリガーを消す。残すとトリガーが溜まる。
    if (saved && saved.triggerId) {
      deleteTriggerById_(scriptApp, saved.triggerId);
    }

    // 最初の項目に入るまでにかかった時間（2026-11-26 の実機確認で、続きの回が 6 分を越えた件の切り分けのため）
    var setupMs = Date.now() - startedMs;
    console.log(LOG_PREFIX + 'start: ' + cfg.key + ' at cursor ' + cursor + ' (runs ' + runs + ', setup ' + setupMs + 'ms)');

    var processed = 0;
    var longestStepMs = 0;
    var paused = false;
    var stalled = false;
    try {
      while (cfg.hasNext(cursor)) {
        var stepStart = Date.now();
        var elapsed = stepStart - startedMs;
        // 次の 1 件が、今までで一番長くかかった 1 件と同じだけかかっても上限に収まるときだけ進む。
        // 最初の 1 件は、前の回の一番長い 1 件の時間で見込む。前の回がないときや、1 件だけで上限を越える処理では、
        // 必ず 1 件は進める（進まないままトリガーが続くのを防ぐ）。
        if (processed > 0 && elapsed + longestStepMs >= cfg.budgetMs) {
          paused = true;
          break;
        }
        if (processed === 0 && savedStepMs > 0 && savedStepMs < cfg.budgetMs && elapsed + savedStepMs >= cfg.budgetMs) {
          paused = true;
          stalled = true;
          break;
        }
        var ret = cfg.step(cursor);
        cursor = nextCursor_(cursor, ret);
        processed++;
        var took = Date.now() - stepStart;
        if (took > longestStepMs) longestStepMs = took;
      }
    } catch (e) {
      // 失敗した項目のカーソルを残す。次に run を呼べばそこからやり直す。
      // 失敗したときは続きのトリガーを張らない（同じ失敗を 1 分おきに繰り返さないため）。
      trySave_(props, propKey, state_(cursor, runs, firstStartedAt, null, longestStepMs || savedStepMs, 0));
      console.error(LOG_PREFIX + 'failed: ' + cfg.key + ' at cursor ' + cursor + ' (' + errorType_(e) + ')');
      throw e;
    }

    var timing = ', setup ' + setupMs + 'ms, longest step ' + longestStepMs + 'ms';
    if (!paused) {
      props.deleteProperty(propKey);
      console.log(LOG_PREFIX + 'done: ' + cfg.key + ' (cursor ' + cursor + ', processed ' + processed + ', runs ' + runs + timing + ')');
      return result_(true, cursor, processed, runs, false, startedMs, setupMs, false);
    }

    stalls = stalled ? stalls + 1 : 0;
    var next = state_(cursor, runs, firstStartedAt, null, longestStepMs || savedStepMs, stalls);
    if (stalls >= MAX_STALLS) {
      // 最初の項目の前に毎回上限に届いている。続きを張り続けても進まないので、止めて知らせる。
      trySave_(props, propKey, next);
      console.error(LOG_PREFIX + 'stalled: ' + cfg.key + ' at cursor ' + cursor + ' (' + stalls + ' runs without progress' + timing + ')');
      var err = new Error('WitGas.resume.run: no progress in ' + stalls + ' runs (setup took too long before the first item)');
      err.name = 'ResumeStallError';
      throw err;
    }
    schedule_(scriptApp, props, propKey, cfg.handler, next);
    if (stalled) {
      console.warn(LOG_PREFIX + 'paused before the first item: ' + cfg.key + ' at cursor ' + cursor +
        ' (runs ' + runs + ', setup ' + setupMs + 'ms, last step ' + savedStepMs + 'ms, stalls ' + stalls + ')');
    } else {
      console.log(LOG_PREFIX + 'paused: ' + cfg.key + ' at cursor ' + cursor + ' (processed ' + processed + ', runs ' + runs + timing + ')');
    }
    return result_(false, cursor, processed, runs, true, startedMs, setupMs, stalled);
  }

  /**
   * 保存されている進み具合を返す。なければ null。
   * @return {?{cursor: number, runs: number, firstStartedAt: Date, scheduled: boolean}}
   */
  function get(key, opts) {
    validateKey_(key, 'get');
    opts = opts || {};
    var props = opts.properties || PropertiesService.getScriptProperties();
    var s = readState_(props, PROPERTY_PREFIX + key);
    if (!s) return null;
    return {
      cursor: s.cursor,
      runs: s.runs,
      firstStartedAt: new Date(s.firstStartedAt),
      scheduled: !!s.triggerId
    };
  }

  /**
   * 続きのトリガーと保存した進み具合を消す（途中でやめるとき、最初からやり直すとき）。
   * 利用者が自分で作ったトリガーは、同じ関数名でも消さない。
   * @return {{deletedTrigger: boolean, deletedState: boolean}}
   */
  function cleanup(key, opts) {
    validateKey_(key, 'cleanup');
    opts = opts || {};
    var props = opts.properties || PropertiesService.getScriptProperties();
    var scriptApp = opts.scriptApp || ScriptApp;
    var propKey = PROPERTY_PREFIX + key;

    var raw = props.getProperty(propKey);
    if (raw === null) return { deletedTrigger: false, deletedState: false };

    var deletedTrigger = false;
    var s = null;
    try {
      s = parseState_(raw);
    } catch (e) {
      // 壊れていてトリガー ID が読めない。プロパティだけ消す。
      console.error(LOG_PREFIX + 'cleanup: state unreadable: ' + key);
    }
    if (s && s.triggerId) {
      deletedTrigger = deleteTriggerById_(scriptApp, s.triggerId);
    }
    props.deleteProperty(propKey);
    console.log(LOG_PREFIX + 'cleanup: ' + key + (deletedTrigger ? ' (trigger deleted)' : ''));
    return { deletedTrigger: deletedTrigger, deletedState: true };
  }

  // ---- 内部 ----

  function schedule_(scriptApp, props, propKey, handler, state) {
    var trigger;
    try {
      trigger = scriptApp.newTrigger(handler).timeBased().after(CONTINUE_AFTER_MS).create();
    } catch (e) {
      // トリガーが作れなくても、進み具合は残す。
      trySave_(props, propKey, state);
      throw e;
    }
    state.triggerId = String(trigger.getUniqueId());
    try {
      props.setProperty(propKey, JSON.stringify(state));
    } catch (e) {
      // 保存できないと、このトリガーを後で消せなくなる。いま消しておく。
      try {
        scriptApp.deleteTrigger(trigger);
      } catch (e2) {
        console.error(LOG_PREFIX + 'could not delete trigger after save failure (' + errorType_(e2) + ')');
      }
      throw e;
    }
  }

  function deleteTriggerById_(scriptApp, triggerId) {
    var triggers = scriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (String(triggers[i].getUniqueId()) === String(triggerId)) {
        scriptApp.deleteTrigger(triggers[i]);
        return true;
      }
    }
    return false;
  }

  function readState_(props, propKey) {
    var raw = props.getProperty(propKey);
    if (raw === null || raw === undefined) return null;
    return parseState_(raw);
  }

  function parseState_(raw) {
    var s;
    try {
      s = JSON.parse(raw);
    } catch (e) {
      s = null;
    }
    if (!s || s.v !== STATE_VERSION || !isNonNegInt_(s.cursor) || !isNonNegInt_(s.runs) ||
        typeof s.firstStartedAt !== 'number' ||
        (s.lastStepMs !== undefined && !isNonNegInt_(s.lastStepMs)) ||
        (s.stalls !== undefined && !isNonNegInt_(s.stalls))) {
      // 最初からやり直すと処理済みの項目をもう一度処理してしまうので、止めて知らせる。
      throw new Error('WitGas.resume: saved state is unreadable (use WitGas.resume.cleanup(key) to start over)');
    }
    return s;
  }

  function state_(cursor, runs, firstStartedAt, triggerId, lastStepMs, stalls) {
    return {
      v: STATE_VERSION, cursor: cursor, runs: runs, firstStartedAt: firstStartedAt, triggerId: triggerId,
      lastStepMs: lastStepMs || 0, stalls: stalls || 0
    };
  }

  function trySave_(props, propKey, state) {
    try {
      props.setProperty(propKey, JSON.stringify(state));
    } catch (e) {
      console.error(LOG_PREFIX + 'could not save cursor (' + errorType_(e) + ')');
    }
  }

  function nextCursor_(cursor, ret) {
    if (ret === undefined) return cursor + 1;
    if (isThenable_(ret)) {
      throw new TypeError('WitGas.resume.run: step must be synchronous');
    }
    if (!isNonNegInt_(ret) || ret <= cursor) {
      throw new RangeError('WitGas.resume.run: step must return undefined or an integer greater than the cursor');
    }
    return ret;
  }

  function result_(done, cursor, processed, runs, scheduled, startedMs, setupMs, stalled) {
    return {
      done: done,
      cursor: cursor,
      processed: processed,
      runs: runs,
      scheduled: scheduled,
      elapsedMs: Date.now() - startedMs,
      setupMs: setupMs,
      stalled: stalled
    };
  }

  function validate_(opts) {
    if (!opts || typeof opts !== 'object') {
      throw new TypeError('WitGas.resume.run: opts must be an object');
    }
    validateKey_(opts.key, 'run');
    var hasTotal = opts.total !== undefined;
    var hasHasNext = opts.hasNext !== undefined;
    if (hasTotal === hasHasNext) {
      throw new TypeError('WitGas.resume.run: specify exactly one of opts.total or opts.hasNext');
    }
    if (hasTotal && !isNonNegInt_(opts.total)) {
      throw new RangeError('WitGas.resume.run: opts.total must be an integer >= 0');
    }
    if (hasHasNext && typeof opts.hasNext !== 'function') {
      throw new TypeError('WitGas.resume.run: opts.hasNext must be a function');
    }
    if (typeof opts.step !== 'function') {
      throw new TypeError('WitGas.resume.run: opts.step must be a function');
    }
    if (typeof opts.handler !== 'string' || opts.handler.trim() === '') {
      throw new TypeError('WitGas.resume.run: opts.handler must be a function name');
    }
    var budgetMs = opts.budgetMs === undefined ? DEFAULT_BUDGET_MS : opts.budgetMs;
    if (!isNonNegInt_(budgetMs) || budgetMs <= 0 || budgetMs > MAX_BUDGET_MS) {
      throw new RangeError('WitGas.resume.run: opts.budgetMs must be an integer in 1..' + MAX_BUDGET_MS);
    }
    var total = opts.total;
    return {
      key: opts.key,
      hasNext: hasTotal ? function (c) { return c < total; } : function (c) {
        var r = opts.hasNext(c);
        if (isThenable_(r)) throw new TypeError('WitGas.resume.run: hasNext must be synchronous');
        return !!r;
      },
      step: opts.step,
      handler: opts.handler,
      budgetMs: budgetMs,
      properties: opts.properties,
      scriptApp: opts.scriptApp
    };
  }

  function validateKey_(key, fnName) {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new TypeError('WitGas.resume.' + fnName + ': key must be a non-empty string');
    }
  }

  function isNonNegInt_(n) {
    return typeof n === 'number' && isFinite(n) && n >= 0 && Math.floor(n) === n;
  }

  function errorType_(e) {
    return (e && e.name) ? String(e.name) : typeof e;
  }

  function isThenable_(v) {
    return v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
  }

  return {
    run: run,
    VERSION: '0.4.0',
    get: get,
    cleanup: cleanup,
    DEFAULT_BUDGET_MS: DEFAULT_BUDGET_MS,
    MAX_BUDGET_MS: MAX_BUDGET_MS,
    MAX_STALLS: MAX_STALLS,
    CONTINUE_AFTER_MS: CONTINUE_AFTER_MS,
    PROPERTY_PREFIX: PROPERTY_PREFIX
  };
})();
