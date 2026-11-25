'use strict';

/**
 * LockService の偽物。
 *
 * スクリプトロックは 1 つだけ。持ち主は「実行」単位で、getScriptLock() のたびに
 * その実行の Lock を返す。本物と同じく（2026-11-25 の実機確認 L2）：
 *   - 同じ実行の中では、別の Lock でも tryLock が成功する（再入できる）
 *   - 同じ実行のどの Lock で releaseLock しても、ロックは外れる
 *     （本物で確かめたのは「再入できる」まで。「外れる」は実機の結果から見込んだ動き）
 * ほかの実行が持っている間は、tryLock は待ち時間を使い切って false になる。
 *
 * テスト用の操作：
 *   newExecution()                 別の実行に切り替える（トリガーで動いた、など）
 *   holdByOther({releaseAfterMs})  別の実行がロックを持っている状態にする
 *   failNextTryLock(err) / failNextRelease(err)  次の呼び出しを失敗させる
 *   calls                          呼び出しの記録
 */
function createLockService(clock) {
  const OTHER = 'other';
  const state = {
    execution: 1,          // 今の実行
    holder: null,          // ロックを持っている実行（null は誰も持っていない）
    otherReleaseAt: null,  // OTHER が手放す時刻（null は手放さない）
    tryLockError: null,
    releaseError: null,
    calls: []
  };
  let nextId = 1;

  function syncOther() {
    if (state.holder === OTHER && state.otherReleaseAt !== null && clock.now() >= state.otherReleaseAt) {
      state.holder = null;
      state.otherReleaseAt = null;
    }
  }

  function createLock() {
    const execution = state.execution;
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
        if (state.holder === null || state.holder === execution) {
          state.holder = execution;
          return true;
        }
        if (state.holder === OTHER && state.otherReleaseAt !== null &&
            state.otherReleaseAt - clock.now() <= timeoutInMillis) {
          clock.advance(state.otherReleaseAt - clock.now());
          syncOther();
          state.holder = execution;
          return true;
        }
        clock.advance(timeoutInMillis);
        syncOther();
        if (state.holder === null) {
          state.holder = execution;
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
        if (state.holder === execution) state.holder = null;
      },
      hasLock() {
        return state.holder === execution;
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
    newExecution() {
      state.execution++;
    },
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
