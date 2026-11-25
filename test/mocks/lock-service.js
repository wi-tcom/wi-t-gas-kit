'use strict';

/**
 * LockService の偽物。
 *
 * スクリプトロックは 1 つだけで、getScriptLock() のたびに別の Lock を返す
 * （GAS の実行ごとに別の Lock を持つのに近い）。
 * ある Lock が持っている間は、ほかの Lock の tryLock は待ち時間を使い切って false になる。
 *
 * テスト用の操作：
 *   holdByOther({releaseAfterMs})  別の実行がロックを持っている状態にする
 *   failNextTryLock(err) / failNextRelease(err)  次の呼び出しを失敗させる
 *   calls  呼び出しの記録
 */
function createLockService(clock) {
  const state = {
    holder: null,          // 持っている Lock（または OTHER）
    otherReleaseAt: null,  // OTHER が手放す時刻（null は手放さない）
    tryLockError: null,
    releaseError: null,
    calls: []
  };
  const OTHER = { id: 'other' };
  let nextId = 1;

  function syncOther() {
    if (state.holder === OTHER && state.otherReleaseAt !== null && clock.now() >= state.otherReleaseAt) {
      state.holder = null;
      state.otherReleaseAt = null;
    }
  }

  function createLock() {
    const lock = {
      id: nextId++,
      tryLock(timeoutInMillis) {
        state.calls.push({ method: 'tryLock', lockId: lock.id, timeoutInMillis });
        if (state.tryLockError) {
          const err = state.tryLockError;
          state.tryLockError = null;
          throw err;
        }
        if (typeof timeoutInMillis !== 'number') {
          throw new TypeError('tryLock: timeoutInMillis must be a number');
        }
        syncOther();
        if (state.holder === null || state.holder === lock) {
          state.holder = lock;
          return true;
        }
        if (state.holder === OTHER && state.otherReleaseAt !== null &&
            state.otherReleaseAt - clock.now() <= timeoutInMillis) {
          clock.advance(state.otherReleaseAt - clock.now());
          syncOther();
          state.holder = lock;
          return true;
        }
        clock.advance(timeoutInMillis);
        syncOther();
        if (state.holder === null) {
          state.holder = lock;
          return true;
        }
        return false;
      },
      releaseLock() {
        state.calls.push({ method: 'releaseLock', lockId: lock.id });
        if (state.releaseError) {
          const err = state.releaseError;
          state.releaseError = null;
          throw err;
        }
        if (state.holder === lock) state.holder = null;
      },
      hasLock() {
        return state.holder === lock;
      }
    };
    return lock;
  }

  return {
    getScriptLock() {
      state.calls.push({ method: 'getScriptLock' });
      return createLock();
    },
    // --- テスト用 ---
    holdByOther(options) {
      const releaseAfterMs = options && options.releaseAfterMs;
      state.holder = OTHER;
      state.otherReleaseAt = releaseAfterMs === undefined ? null : clock.now() + releaseAfterMs;
    },
    isHeld() {
      syncOther();
      return state.holder !== null;
    },
    failNextTryLock(err) {
      state.tryLockError = err;
    },
    failNextRelease(err) {
      state.releaseError = err;
    },
    get calls() {
      return state.calls;
    }
  };
}

module.exports = { createLockService };
