'use strict';

/**
 * CacheService の偽物（スクリプトのキャッシュだけ）。偽の時計で期限が切れる。
 * GAS と同じく、期限は最長 21600 秒、キーは 250 文字まで。
 * テスト用の操作：evictAll()（キャッシュが先に消えた場合を再現する）
 */
const MAX_TTL_SECONDS = 21600;
const MAX_KEY_LENGTH = 250;

function createCacheService(clock) {
  const store = new Map();
  const puts = [];

  function check(key) {
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) {
      throw new Error('Argument too large or invalid: key');
    }
  }

  const cache = {
    get(key) {
      check(key);
      const e = store.get(key);
      if (!e) return null;
      if (clock.now() >= e.expiresAt) {
        store.delete(key);
        return null;
      }
      return e.value;
    },
    put(key, value, expirationInSeconds) {
      check(key);
      const ttl = expirationInSeconds === undefined ? 600 : expirationInSeconds;
      if (typeof ttl !== 'number' || ttl < 1 || ttl > MAX_TTL_SECONDS) {
        throw new Error('Argument too large or invalid: expirationInSeconds');
      }
      puts.push({ key, value: String(value), ttl });
      store.set(key, { value: String(value), expiresAt: clock.now() + ttl * 1000 });
    },
    remove(key) {
      store.delete(key);
    }
  };

  return {
    getScriptCache: () => cache,
    // --- テスト用 ---
    evictAll() {
      store.clear();
    },
    puts
  };
}

module.exports = { createCacheService, MAX_TTL_SECONDS };
