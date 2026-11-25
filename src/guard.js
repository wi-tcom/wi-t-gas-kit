/**
 * WitGas.guard — まとめの入り口
 *
 * lock（二重実行の防止）→ 実行 → runlog（実行記録）→ 失敗したら notify（通知）を 1 行で包む。
 * WitGas.lock・WitGas.runlog・WitGas.notify を使う（WitGas.resume の結果も読める）。
 *
 * © 2026 wi-t.com Inc.
 */
var WitGas = WitGas || {};

WitGas.guard = (function () {
  'use strict';

  var LOG_PREFIX = '[WitGas.guard] ';
  var MAX_MESSAGE_LENGTH = 100;

  /**
   * @param {string} name 処理名（実行記録と通知に出る。個人情報や業務データを入れないこと）
   * @param {function(Object): *} fn 処理（同期関数）。引数 ctx で件数とメッセージを渡せる：
   *     ctx.setCount(n) / ctx.addCount(n) / ctx.setMessage(s)
   * @param {Object} opts
   * @param {Object|boolean} opts.log 実行記録の設定（WitGas.runlog.append の opts）。残さないなら false
   * @param {Object|boolean} opts.notify 通知の設定（WitGas.notify.failure の opts）。送らないなら false
   * @param {number} [opts.waitMs=0] ロックを待つ最大ミリ秒
   * @param {Object} [opts.lock] 使うロック（WitGas.lock.run の opts.lock）
   * @param {boolean} [opts.rethrow=true] 失敗したとき、記録と通知のあとにエラーを投げ直すか
   * @return {{status: string, value: *, count: ?number, startedAt: Date, endedAt: Date, errorType?: string}}
   *     status は 'success' | 'continued' | 'skipped' | 'failure'
   */
  function guard(name, fn, opts) {
    var cfg = validate_(name, fn, opts);
    var startedAt = new Date();
    var acc = { count: null, message: null, open: true };
    var ctx = makeContext_(acc);

    var outcome;
    var skipInfo = null;
    try {
      outcome = WitGas.lock.run(name, function () { return fn(ctx); }, {
        waitMs: cfg.waitMs,
        lock: cfg.lock,
        onSkip: function (e) { skipInfo = e; }
      });
    } catch (e) {
      acc.open = false;
      return fail_(cfg, name, startedAt, acc, e);
    }
    acc.open = false;

    if (outcome.skipped) {
      var skippedAt = skipInfo ? skipInfo.endedAt : new Date();
      log_(cfg, name, { result: 'skipped', startedAt: startedAt, endedAt: skippedAt, message: 'locked' });
      return result_('skipped', undefined, null, startedAt, skippedAt);
    }

    var value = outcome.value;
    var status = 'success';
    if (isResumeResult_(value)) {
      status = value.done ? 'success' : 'continued';
      if (acc.count === null) acc.count = value.processed;
      if (acc.message === null) acc.message = 'cursor ' + value.cursor + ', runs ' + value.runs;
    }
    var endedAt = new Date();
    log_(cfg, name, {
      result: status,
      startedAt: startedAt,
      endedAt: endedAt,
      count: acc.count,
      message: acc.message
    });
    return result_(status, value, acc.count, startedAt, endedAt);
  }

  function fail_(cfg, name, startedAt, acc, error) {
    var endedAt = new Date();
    var errorType = errorType_(error);
    console.error(LOG_PREFIX + 'failed: ' + name + ' (' + errorType + ')');
    log_(cfg, name, {
      result: 'failure',
      startedAt: startedAt,
      endedAt: endedAt,
      count: acc.count,
      errorType: errorType,
      message: acc.message
    });
    notify_(cfg, name, errorType, endedAt, acc.count);
    if (cfg.rethrow) throw error;
    var r = result_('failure', undefined, acc.count, startedAt, endedAt);
    r.errorType = errorType;
    return r;
  }

  /** 実行記録を書く。書けなくても処理の結果は変えず、ログに残して通知する。 */
  function log_(cfg, name, entry) {
    if (!cfg.log) return;
    entry.name = name;
    try {
      WitGas.runlog.append(entry, cfg.log);
    } catch (e) {
      var type = errorType_(e);
      console.error(LOG_PREFIX + 'runlog failed: ' + name + ' (' + type + ')');
      notify_(cfg, name, 'runlog:' + type, new Date(), null);
    }
  }

  /** 通知を送る。送れなくても処理の結果は変えず、ログに残す。 */
  function notify_(cfg, name, errorType, at, count) {
    if (!cfg.notify) return;
    try {
      var nopts = cfg.notify;
      if (nopts.linkUrl === undefined) {
        var url = logUrl_(cfg.log);
        if (url) nopts = assign_({}, nopts, { linkUrl: url });
      }
      WitGas.notify.failure({ name: name, errorType: errorType, at: at, count: count }, nopts);
    } catch (e) {
      console.error(LOG_PREFIX + 'notify failed: ' + name + ' (' + errorType_(e) + ')');
    }
  }

  /** 実行記録のシートの URL（分かるときだけ）。 */
  function logUrl_(log) {
    if (!log) return null;
    if (typeof log.spreadsheetId === 'string') {
      return 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(log.spreadsheetId) + '/edit';
    }
    if (log.spreadsheet && typeof log.spreadsheet.getUrl === 'function') {
      try {
        var u = log.spreadsheet.getUrl();
        return typeof u === 'string' && /^https:\/\//.test(u) ? u : null;
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  function makeContext_(acc) {
    function checkOpen(fnName) {
      if (!acc.open) throw new Error('WitGas.guard: ctx.' + fnName + ' was called after the run ended');
    }
    return {
      setCount: function (n) {
        checkOpen('setCount');
        if (!isNonNegInt_(n)) throw new RangeError('WitGas.guard: ctx.setCount(n) needs an integer >= 0');
        acc.count = n;
      },
      addCount: function (n) {
        checkOpen('addCount');
        if (n === undefined) n = 1;
        if (!isNonNegInt_(n)) throw new RangeError('WitGas.guard: ctx.addCount(n) needs an integer >= 0');
        acc.count = (acc.count || 0) + n;
      },
      setMessage: function (s) {
        checkOpen('setMessage');
        if (typeof s !== 'string') throw new TypeError('WitGas.guard: ctx.setMessage(s) needs a string');
        acc.message = s.length > MAX_MESSAGE_LENGTH ? s.slice(0, MAX_MESSAGE_LENGTH) : s;
      }
    };
  }

  function validate_(name, fn, opts) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TypeError('WitGas.guard: name must be a non-empty string');
    }
    if (typeof fn !== 'function') {
      throw new TypeError('WitGas.guard: fn must be a function');
    }
    if (!opts || typeof opts !== 'object') {
      throw new TypeError('WitGas.guard: opts is required ({log, notify})');
    }
    if (!WitGas.lock || (opts.log && !WitGas.runlog) || (opts.notify && !WitGas.notify)) {
      throw new Error('WitGas.guard: copy lock.js, runlog.js and notify.js together with guard.js');
    }
    // 設定の誤りは、失敗が起きてから気づくのでは遅い。毎回、実行の前に確かめる。
    if (opts.log === undefined) {
      throw new TypeError('WitGas.guard: opts.log is required (runlog options, or false)');
    }
    if (opts.notify === undefined) {
      throw new TypeError('WitGas.guard: opts.notify is required (notify options, or false)');
    }
    if (opts.log !== false) {
      if (opts.log === null || typeof opts.log !== 'object') {
        throw new TypeError('WitGas.guard: opts.log must be an object or false');
      }
      WitGas.runlog.validateOptions(opts.log);
    }
    if (opts.notify !== false) {
      if (opts.notify === null || typeof opts.notify !== 'object') {
        throw new TypeError('WitGas.guard: opts.notify must be an object or false');
      }
      WitGas.notify.validateOptions(opts.notify);
    }
    if (opts.waitMs !== undefined && !isNonNegInt_(opts.waitMs)) {
      throw new RangeError('WitGas.guard: opts.waitMs must be an integer >= 0');
    }
    if (opts.rethrow !== undefined && typeof opts.rethrow !== 'boolean') {
      throw new TypeError('WitGas.guard: opts.rethrow must be a boolean');
    }
    return {
      log: opts.log || null,
      notify: opts.notify || null,
      waitMs: opts.waitMs,
      lock: opts.lock,
      rethrow: opts.rethrow !== false
    };
  }

  function isResumeResult_(v) {
    return v !== null && typeof v === 'object' && typeof v.done === 'boolean' &&
      isNonNegInt_(v.cursor) && isNonNegInt_(v.processed) && isNonNegInt_(v.runs);
  }

  function result_(status, value, count, startedAt, endedAt) {
    return { status: status, value: value, count: count, startedAt: startedAt, endedAt: endedAt };
  }

  function assign_(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
      }
    }
    return target;
  }

  function errorType_(e) {
    return (e && e.name) ? String(e.name) : typeof e;
  }

  function isNonNegInt_(n) {
    return typeof n === 'number' && isFinite(n) && n >= 0 && Math.floor(n) === n;
  }

  return guard;
})();
