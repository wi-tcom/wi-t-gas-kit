/**
 * WitGas.notify — エラー通知
 *
 * 失敗したら MailApp で指定アドレスに知らせる。
 * 同じ処理・同じエラー種別は 1 時間に 1 通まで（CacheService で抑える）。
 * 本文に書くのは処理名・エラー種別・時刻・件数まで。エラーのメッセージは書かない。
 *
 * © 2026 wi-t.com Inc.
 */
var WitGas = WitGas || {};

WitGas.notify = (function () {
  'use strict';

  var DEFAULT_THROTTLE_MS = 60 * 60 * 1000;
  var MAX_THROTTLE_MS = 6 * 60 * 60 * 1000; // CacheService に置ける最長（21600 秒）
  var DEFAULT_SUBJECT_PREFIX = '[WitGas]';
  var CACHE_PREFIX = 'WitGas.notify:';
  var MAX_NAME_LENGTH = 100;
  var MAX_ERROR_TYPE_LENGTH = 50;
  var LOG_PREFIX = '[WitGas.notify] ';
  var EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

  /**
   * 失敗を知らせる。同じ処理・同じエラー種別を throttleMs 以内に知らせていたら送らない。
   *
   * @param {Object} info
   * @param {string} info.name 処理名
   * @param {string} [info.errorType] エラー種別（省略時は info.error の name）
   * @param {*} [info.error] エラー。種別（name）だけを使い、メッセージは書かない
   * @param {Date} [info.at] 起きた時刻（省略時は今）
   * @param {number} [info.count] 件数
   * @param {Object} opts
   * @param {string|string[]} opts.to 送り先（カンマ区切りか配列）
   * @param {number} [opts.throttleMs=3600000] 同じ通知を抑える時間（1 分〜6 時間）
   * @param {string} [opts.subjectPrefix='[WitGas]']
   * @param {string} [opts.linkUrl] 本文に載せる URL（実行記録のシートなど）
   * @param {string} [opts.timeZone] 時刻の表示に使うタイムゾーン（省略時はスクリプトのタイムゾーン）
   * @return {{sent: boolean, reason?: string}}
   */
  function failure(info, opts) {
    var cfg = validate_(info, opts);
    var cache = cfg.cache || CacheService.getScriptCache();
    var cacheKey = CACHE_PREFIX + digest_(cfg.name + '\n' + cfg.errorType);

    if (cache.get(cacheKey) !== null) {
      console.log(LOG_PREFIX + 'throttled: ' + cfg.name + ' (' + cfg.errorType + ')');
      return { sent: false, reason: 'throttled' };
    }

    var at = cfg.at || new Date();
    var tz = cfg.timeZone || Session.getScriptTimeZone();
    var when = Utilities.formatDate(at, tz, 'yyyy-MM-dd HH:mm:ss');
    var hours = cfg.throttleMs / 3600000;
    var lines = [
      '処理が失敗しました。',
      '',
      '処理名：' + cfg.name,
      'エラー種別：' + cfg.errorType,
      '時刻：' + when + '（' + tz + '）'
    ];
    if (cfg.count !== undefined && cfg.count !== null) lines.push('件数：' + cfg.count);
    if (cfg.linkUrl) lines.push('実行記録：' + cfg.linkUrl);
    lines.push(
      '',
      '同じ処理・同じエラー種別のお知らせは ' + formatHours_(hours) + 'に 1 通までです。',
      '回数や詳しい時刻は実行記録と、Apps Script の「実行数」画面で確認してください。'
    );

    // 送れたときだけ抑える（送れなかったら、次の失敗でもう一度送る）
    MailApp.sendEmail({
      to: cfg.to,
      subject: cfg.subjectPrefix + ' 失敗: ' + cfg.name + ' (' + cfg.errorType + ')',
      body: lines.join('\n')
    });
    cache.put(cacheKey, String(at.getTime()), Math.ceil(cfg.throttleMs / 1000));
    console.log(LOG_PREFIX + 'sent: ' + cfg.name + ' (' + cfg.errorType + ')');
    return { sent: true };
  }

  function validate_(info, opts) {
    if (!info || typeof info !== 'object') {
      throw new TypeError('WitGas.notify.failure: info must be an object');
    }
    if (typeof info.name !== 'string' || info.name.trim() === '') {
      throw new TypeError('WitGas.notify.failure: info.name must be a non-empty string');
    }
    if (info.at !== undefined && info.at !== null &&
        (typeof info.at.getTime !== 'function' || isNaN(info.at.getTime()))) {
      throw new TypeError('WitGas.notify.failure: info.at must be a Date');
    }
    if (info.count !== undefined && info.count !== null && !isNonNegInt_(info.count)) {
      throw new RangeError('WitGas.notify.failure: info.count must be an integer >= 0');
    }
    var o = checkOptions_(opts, 'failure');

    var errorType = info.errorType;
    if (errorType === undefined || errorType === null) {
      errorType = (info.error !== undefined && info.error !== null) ? errorType_(info.error) : 'Error';
    }
    return {
      name: oneLine_(info.name, MAX_NAME_LENGTH),
      errorType: oneLine_(errorType, MAX_ERROR_TYPE_LENGTH),
      at: info.at,
      count: info.count,
      to: o.to,
      throttleMs: o.throttleMs,
      subjectPrefix: oneLine_(o.subjectPrefix, 50),
      linkUrl: opts.linkUrl,
      timeZone: opts.timeZone,
      cache: opts.cache
    };
  }

  /**
   * opts だけを確かめる（メールは送らない）。おかしければ投げる。
   * guard が実行の前に設定の誤り（送り先の書き間違いなど）に気づくために使う。
   */
  function validateOptions(opts) {
    checkOptions_(opts, 'validateOptions');
    return true;
  }

  function checkOptions_(opts, fnName) {
    var where = 'WitGas.notify.' + fnName + ': ';
    if (!opts || typeof opts !== 'object') {
      throw new TypeError(where + 'opts.to is required');
    }
    var to = normalizeTo_(opts.to, where);
    var throttleMs = opts.throttleMs === undefined ? DEFAULT_THROTTLE_MS : opts.throttleMs;
    if (!isNonNegInt_(throttleMs) || throttleMs < 60000 || throttleMs > MAX_THROTTLE_MS) {
      throw new RangeError(where + 'opts.throttleMs must be an integer in 60000..' + MAX_THROTTLE_MS);
    }
    var subjectPrefix = opts.subjectPrefix === undefined ? DEFAULT_SUBJECT_PREFIX : opts.subjectPrefix;
    if (typeof subjectPrefix !== 'string') {
      throw new TypeError(where + 'opts.subjectPrefix must be a string');
    }
    if (opts.linkUrl !== undefined && (typeof opts.linkUrl !== 'string' || !/^https:\/\//.test(opts.linkUrl))) {
      throw new TypeError(where + 'opts.linkUrl must be an https URL');
    }
    if (opts.timeZone !== undefined && (typeof opts.timeZone !== 'string' || opts.timeZone === '')) {
      throw new TypeError(where + 'opts.timeZone must be a non-empty string');
    }
    return { to: to, throttleMs: throttleMs, subjectPrefix: subjectPrefix };
  }

  function normalizeTo_(to, where) {
    var list;
    if (typeof to === 'string') {
      list = to.split(',');
    } else if (Array.isArray(to)) {
      list = to.slice();
    } else {
      throw new TypeError(where + 'opts.to is required');
    }
    list = list.map(function (a) { return typeof a === 'string' ? a.trim() : a; })
      .filter(function (a) { return a !== ''; });
    if (list.length === 0) {
      throw new TypeError(where + 'opts.to is required');
    }
    for (var i = 0; i < list.length; i++) {
      if (typeof list[i] !== 'string' || !EMAIL_RE.test(list[i])) {
        throw new TypeError(where + 'opts.to has an invalid address (#' + (i + 1) + ')');
      }
    }
    return list.join(',');
  }

  function digest_(s) {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
    return Utilities.base64EncodeWebSafe(bytes);
  }

  function formatHours_(hours) {
    return hours >= 1 && Math.floor(hours) === hours ? hours + ' 時間' : Math.round(hours * 60) + ' 分';
  }

  function oneLine_(value, maxLength) {
    var s = String(value).replace(/[\r\n\t]+/g, ' ').trim();
    return s.length > maxLength ? s.slice(0, maxLength - 1) + '…' : s;
  }

  function errorType_(e) {
    return (e && e.name) ? String(e.name) : typeof e;
  }

  function isNonNegInt_(n) {
    return typeof n === 'number' && isFinite(n) && n >= 0 && Math.floor(n) === n;
  }

  return {
    failure: failure,
    VERSION: '0.2.0',
    validateOptions: validateOptions,
    DEFAULT_THROTTLE_MS: DEFAULT_THROTTLE_MS,
    MAX_THROTTLE_MS: MAX_THROTTLE_MS
  };
})();
