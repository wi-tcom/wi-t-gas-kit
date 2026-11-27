'use strict';

/**
 * Utilities と Session の偽物（使う分だけ）。
 * formatDate は 'yyyy-MM-dd HH:mm:ss' だけに対応する。
 */
const crypto = require('node:crypto');

function makeBlob(data, contentType, name) {
  const blob = {
    _source: data,
    getDataAsString: () => data,
    getContentType: () => contentType,
    getName: () => name,
    setName(n) { name = n; return blob; },
    getAs(type) {
      if (type !== 'application/pdf') throw new Error('unsupported conversion in mock: ' + type);
      return makeBlob(data, type, name);
    }
  };
  return blob;
}

function createUtilities() {
  return {
    DigestAlgorithm: { SHA_256: 'SHA_256', MD5: 'MD5' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest(algorithm, value, charset) {
      if (algorithm !== 'SHA_256') throw new Error('unsupported algorithm in mock: ' + algorithm);
      if (charset !== undefined && charset !== 'UTF_8') throw new Error('unsupported charset in mock');
      // GAS は符号付きのバイト（-128〜127）の配列を返す
      return Array.from(crypto.createHash('sha256').update(String(value), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b));
    },
    base64EncodeWebSafe(bytes) {
      return Buffer.from(bytes.map((b) => (b < 0 ? b + 256 : b))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    },
    /** Blob の偽物。中身の文字と種類を持ち、getAs で種類だけを変える（中身は元の文字のまま） */
    newBlob(data, contentType, name) {
      return makeBlob(String(data), contentType || 'text/plain', name || null);
    },
    formatDate(date, timeZone, format) {
      if (format !== 'yyyy-MM-dd HH:mm:ss' && format !== 'yyyy-MM-dd') throw new Error('unsupported format in mock: ' + format);
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
      }).formatToParts(new Date(date.getTime()));
      const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
      const day = `${p.year}-${p.month}-${p.day}`;
      return format === 'yyyy-MM-dd' ? day : `${day} ${p.hour}:${p.minute}:${p.second}`;
    }
  };
}

function createSession(timeZone) {
  return {
    getScriptTimeZone: () => timeZone || 'Asia/Tokyo'
  };
}

module.exports = { createUtilities, createSession };
