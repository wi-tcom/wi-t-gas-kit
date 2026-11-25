'use strict';

/**
 * ScriptApp の偽物（時間主導型トリガーの作成・一覧・削除だけ）。
 *
 * - newTrigger(name).timeBased().after(ms).create() で 1 回だけ動くトリガーを作る。
 * - 動いた（発火した）トリガーも、deleteTrigger されるまで一覧に残る。
 *   （実機でも残るかは docs/manual-check.md の R5 で確かめる）
 * - 1 プロジェクトのトリガーは 20 個まで。越えると create() が失敗する。
 *
 * テスト用の操作：
 *   addOtherTrigger(handler)  利用者が自分で作ったトリガーを置く
 *   fireNext(context)         次に動くトリガーの時刻まで時計を進め、handler を呼ぶ
 *   failNextCreate(err)       次の create() を失敗させる
 */
const MAX_TRIGGERS = 20;

function createScriptApp(clock) {
  const triggers = [];
  const state = { createError: null, created: 0, deleted: 0 };
  let nextId = 1;

  function makeTrigger(handler, dueAt) {
    const id = String(1000 + nextId++);
    const t = {
      _dueAt: dueAt,
      _fired: false,
      getUniqueId: () => id,
      getHandlerFunction: () => handler,
      getEventType: () => 'CLOCK',
      getTriggerSource: () => 'CLOCK'
    };
    return t;
  }

  function addTrigger(t) {
    if (triggers.length >= MAX_TRIGGERS) {
      throw new Error('This script has too many triggers. Triggers must be deleted from the script before more can be added.');
    }
    triggers.push(t);
    state.created++;
    return t;
  }

  const ScriptApp = {
    newTrigger(handler) {
      if (typeof handler !== 'string' || handler === '') {
        throw new TypeError('newTrigger: function name required');
      }
      return {
        timeBased() {
          let afterMs = null;
          const builder = {
            after(ms) {
              if (typeof ms !== 'number' || ms < 0) throw new TypeError('after: ms must be >= 0');
              afterMs = ms;
              return builder;
            },
            create() {
              if (state.createError) {
                const err = state.createError;
                state.createError = null;
                throw err;
              }
              if (afterMs === null) throw new Error('time-based trigger needs a schedule');
              return addTrigger(makeTrigger(handler, clock.now() + afterMs));
            }
          };
          return builder;
        }
      };
    },
    getProjectTriggers() {
      return triggers.slice();
    },
    deleteTrigger(trigger) {
      const id = trigger.getUniqueId();
      const i = triggers.findIndex((t) => t.getUniqueId() === id);
      if (i >= 0) {
        triggers.splice(i, 1);
        state.deleted++;
      }
    },

    // --- テスト用 ---
    addOtherTrigger(handler) {
      return addTrigger(makeTrigger(handler, Infinity));
    },
    pending() {
      return triggers.filter((t) => !t._fired && t._dueAt !== Infinity);
    },
    fireNext(context) {
      const due = ScriptApp.pending().sort((a, b) => a._dueAt - b._dueAt)[0];
      if (!due) return { fired: false };
      if (due._dueAt > clock.now()) clock.advance(due._dueAt - clock.now());
      due._fired = true;
      const fn = context[due.getHandlerFunction()];
      if (typeof fn !== 'function') {
        throw new Error('Script function not found: ' + due.getHandlerFunction());
      }
      return { fired: true, value: fn({ triggerUid: due.getUniqueId() }) };
    },
    failNextCreate(err) {
      state.createError = err;
    },
    get stats() {
      return { ...state };
    }
  };
  return ScriptApp;
}

module.exports = { createScriptApp, MAX_TRIGGERS };
