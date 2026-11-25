'use strict';

/**
 * PropertiesService の偽物（スクリプトのプロパティだけ）。
 * 値は文字列で持つ（GAS と同じく、文字列以外は文字列に変える）。
 *
 * テスト用の操作：
 *   failNextSet(err)  次の setProperty を失敗させる
 *   dump()            中身をそのまま返す
 */
function createPropertiesService() {
  const store = new Map();
  const state = { setError: null, writes: 0 };

  const props = {
    getProperty(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setProperty(key, value) {
      if (state.setError) {
        const err = state.setError;
        state.setError = null;
        throw err;
      }
      state.writes++;
      store.set(String(key), String(value));
      return props;
    },
    deleteProperty(key) {
      store.delete(key);
      return props;
    },
    getKeys() {
      return Array.from(store.keys());
    },
    getProperties() {
      return Object.fromEntries(store);
    }
  };

  return {
    getScriptProperties() {
      return props;
    },
    // --- テスト用 ---
    failNextSet(err) {
      state.setError = err;
    },
    dump() {
      return Object.fromEntries(store);
    },
    get writes() {
      return state.writes;
    }
  };
}

module.exports = { createPropertiesService };
