/**
 * WitGas.lock — 二重実行の防止
 *
 * LockService のスクリプトロックが取れたときだけ処理を動かし、終わったら必ず解放する。
 * 取れなかったときは処理を動かさず「スキップ」として返す。
 *
 * © 2026 wi-t.com Inc.
 */
var WitGas = WitGas || {};

WitGas.lock = (function () {
  'use strict';

  var DEFAULT_WAIT_MS = 0;
  var LOG_PREFIX = '[WitGas.lock] ';

  /**
   * ロックが取れたときだけ fn を実行する。
   *
   * @param {string} name 処理名（実行記録に残る。個人情報や業務データを入れないこと）
   * @param {function(): *} fn 実行する処理（同期関数）
   * @param {Object} [opts]
   * @param {number} [opts.waitMs=0] ロックが空くのを待つ最大ミリ秒（0 以上の整数）
   * @param {function(Object): void} [opts.onSkip] スキップしたときに呼ぶ。
   *     引数は {name, result:'skipped', reason:'locked', startedAt, endedAt}
   * @param {Object} [opts.lock] 使うロック（tryLock / releaseLock を持つもの）。
   *     省略時は LockService.getScriptLock()
   * @return {{skipped: false, value: *}|{skipped: true, reason: string, name: string}}
   */
  function run(name, fn, opts) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TypeError('WitGas.lock.run: name must be a non-empty string');
    }
    if (typeof fn !== 'function') {
      throw new TypeError('WitGas.lock.run: fn must be a function');
    }
    opts = opts || {};
    var waitMs = opts.waitMs === undefined ? DEFAULT_WAIT_MS : opts.waitMs;
    if (typeof waitMs !== 'number' || !isFinite(waitMs) || waitMs < 0 || Math.floor(waitMs) !== waitMs) {
      throw new RangeError('WitGas.lock.run: opts.waitMs must be an integer >= 0');
    }
    if (opts.onSkip !== undefined && typeof opts.onSkip !== 'function') {
      throw new TypeError('WitGas.lock.run: opts.onSkip must be a function');
    }

    var lock = opts.lock || LockService.getScriptLock();
    var startedAt = new Date();

    if (!lock.tryLock(waitMs)) {
      reportSkip_(name, startedAt, opts.onSkip);
      return { skipped: true, reason: 'locked', name: name };
    }

    var value;
    var fnError = null;
    var fnFailed = false;
    try {
      value = fn();
    } catch (e) {
      fnFailed = true;
      fnError = e;
    }

    var releaseError = release_(lock);

    if (fnFailed) {
      // 処理の失敗を優先して投げる。解放の失敗は記録だけ残す。
      if (releaseError) {
        console.error(LOG_PREFIX + 'release failed after error: ' + name + ' (' + errorType_(releaseError) + ')');
      }
      throw fnError;
    }
    if (releaseError) {
      // ロックが残ると次の実行がすべてスキップされるので、成功扱いにせず知らせる。
      throw releaseError;
    }
    if (isThenable_(value)) {
      throw new TypeError('WitGas.lock.run: fn must be synchronous (the lock was released before the returned Promise settled)');
    }
    return { skipped: false, value: value };
  }

  function reportSkip_(name, startedAt, onSkip) {
    console.log(LOG_PREFIX + 'skipped: ' + name + ' (locked)');
    if (!onSkip) return;
    try {
      onSkip({
        name: name,
        result: 'skipped',
        reason: 'locked',
        startedAt: startedAt,
        endedAt: new Date()
      });
    } catch (e) {
      // 記録の失敗でスキップの結果を変えない。
      console.error(LOG_PREFIX + 'onSkip failed: ' + name + ' (' + errorType_(e) + ')');
    }
  }

  function release_(lock) {
    try {
      lock.releaseLock();
      return null;
    } catch (e) {
      return e;
    }
  }

  function errorType_(e) {
    return (e && e.name) ? String(e.name) : typeof e;
  }

  function isThenable_(v) {
    return v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
  }

  return {
    run: run,
    DEFAULT_WAIT_MS: DEFAULT_WAIT_MS
  };
})();
