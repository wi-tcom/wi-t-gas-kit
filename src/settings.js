/**
 * WitGas.settings — 設定シート
 *
 * 先方ごとに変える値（シート名・通知先・列名・上限など）を「設定」シートに置き、コードから読む。
 * コードを入れ替えても、設定シートの値は消えない。
 * シートの形：1 行目が見出し（項目・値・説明）、2 行目から 1 項目 1 行。
 *
 * © 2026 wi-t.com Inc.
 */
var WitGas = WitGas || {};

WitGas.settings = (function () {
  'use strict';

  var VERSION = '0.4.0';
  var DEFAULT_SHEET_NAME = '設定';
  var HEADER = ['項目', '値', '説明'];
  var TYPES = ['string', 'number', 'boolean', 'email'];
  var EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

  /**
   * 設定シートを用意する。なければ作り、足りない項目を既定の値で足す。今ある値は書き換えない。
   *
   * @param {Object} opts
   * @param {Object} [opts.spreadsheet] 置くスプレッドシート（省略時は開いているもの）
   * @param {string} [opts.sheetName='設定']
   * @param {Array<{key: string, value: *, type?: string, note?: string}>} opts.items 項目の定義
   * @return {{sheetName: string, added: string[]}} 足した項目
   */
  function ensure(opts) {
    var cfg = validate_(opts, 'ensure');
    var sheet = cfg.spreadsheet.getSheetByName(cfg.sheetName);
    if (!sheet) sheet = cfg.spreadsheet.insertSheet(cfg.sheetName);
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]).setFontWeight('bold');
      sheet.setFrozenRows(1);
      sheet.setColumnWidth(1, 200);
      sheet.setColumnWidth(2, 260);
      sheet.setColumnWidth(3, 360);
    }
    var present = rowsByKey_(sheet);
    var added = [];
    cfg.items.forEach(function (item) {
      if (present.hasOwnProperty(item.key)) return;
      var row = [item.key, item.value === undefined || item.value === null ? '' : item.value, item.note || ''];
      sheet.appendRow(row.map(cell_));
      added.push(item.key);
    });
    return { sheetName: cfg.sheetName, added: added };
  }

  /**
   * 設定シートの値を読む。シートにない項目は既定の値を使う。
   * 値が型に合わないとき、必須の項目が空のときは SettingsError を投げる（項目名だけを書き、値は書かない）。
   *
   * @param {Object} opts ensure と同じ。items の required: true は空を許さない
   * @return {Object<string, *>} 項目 → 値
   */
  function read(opts) {
    var cfg = validate_(opts, 'read');
    var sheet = cfg.spreadsheet.getSheetByName(cfg.sheetName);
    var present = sheet ? rowsByKey_(sheet) : {};
    var out = {};
    cfg.items.forEach(function (item) {
      var raw = present.hasOwnProperty(item.key) ? present[item.key] : item.value;
      out[item.key] = coerce_(raw, item, cfg.sheetName);
    });
    return out;
  }

  // ---- 内部 ----

  function rowsByKey_(sheet) {
    var map = {};
    var last = sheet.getLastRow();
    if (last < 2) return map;
    sheet.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
      var key = r[0] === null || r[0] === undefined ? '' : String(r[0]).trim();
      if (key !== '' && !map.hasOwnProperty(key)) map[key] = r[1];
    });
    return map;
  }

  function coerce_(raw, item, sheetName) {
    var type = item.type || 'string';
    var empty = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');
    if (empty) {
      if (item.required) throw error_(sheetName, item.key, 'が空です');
      return type === 'string' || type === 'email' ? '' : null;
    }
    if (type === 'number') {
      var n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,，\s]/g, ''));
      if (!isFinite(n)) throw error_(sheetName, item.key, 'の値が数ではありません');
      return n;
    }
    if (type === 'boolean') {
      if (raw === true || raw === false) return raw;
      var t = String(raw).trim().toUpperCase();
      if (t === 'TRUE' || t === 'はい') return true;
      if (t === 'FALSE' || t === 'いいえ') return false;
      throw error_(sheetName, item.key, 'の値は「はい」か「いいえ」にしてください');
    }
    var s = String(raw).trim().replace(/^'/, '');
    if (type === 'email' && !s.split(',').every(function (a) { return EMAIL_RE.test(a.trim()); })) {
      throw error_(sheetName, item.key, 'の値がメールアドレスになっていません');
    }
    return s;
  }

  function error_(sheetName, key, what) {
    var e = new Error('「' + sheetName + '」シートの「' + key + '」' + what + '。');
    e.name = 'SettingsError';
    return e;
  }

  function validate_(opts, fnName) {
    var where = 'WitGas.settings.' + fnName + ': ';
    if (!opts || typeof opts !== 'object') throw new TypeError(where + 'opts is required');
    var sheetName = opts.sheetName === undefined ? DEFAULT_SHEET_NAME : opts.sheetName;
    if (typeof sheetName !== 'string' || sheetName.trim() === '') {
      throw new TypeError(where + 'opts.sheetName must be a non-empty string');
    }
    var items = opts.items;
    if (!Array.isArray(items) || items.length === 0) throw new TypeError(where + 'opts.items must be a non-empty array');
    var seen = {};
    items.forEach(function (it) {
      if (!it || typeof it.key !== 'string' || it.key.trim() === '') throw new TypeError(where + 'each item needs a key');
      if (seen.hasOwnProperty(it.key)) throw new TypeError(where + 'duplicate key "' + it.key + '"');
      seen[it.key] = true;
      if (it.type !== undefined && TYPES.indexOf(it.type) < 0) {
        throw new TypeError(where + 'item "' + it.key + '" has an unknown type');
      }
    });
    var ss = opts.spreadsheet || SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) throw new Error(where + 'no spreadsheet (pass opts.spreadsheet)');
    return { spreadsheet: ss, sheetName: sheetName, items: items };
  }

  function cell_(v) {
    if (typeof v !== 'string') return v;
    return /^[=+\-@]/.test(v) ? "'" + v : v;
  }

  return {
    ensure: ensure,
    read: read,
    VERSION: VERSION,
    DEFAULT_SHEET_NAME: DEFAULT_SHEET_NAME
  };
})();
