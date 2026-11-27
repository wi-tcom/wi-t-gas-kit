/**
 * WitGas.runlog — 実行記録
 *
 * 指定したスプレッドシートの「実行記録」シートに、1 実行 1 行で残す。
 * 列：開始・終了・処理名・結果・件数・エラー種別・メッセージ
 * 行が上限（既定 5,000 行）を越えたら、古い行から消す。
 *
 * © 2026 wi-t.com Inc.
 */
var WitGas = WitGas || {};

WitGas.runlog = (function () {
  'use strict';

  var DEFAULT_SHEET_NAME = '実行記録';
  var DEFAULT_MAX_ROWS = 5000;
  var HEADER = ['開始', '終了', '処理名', '結果', '件数', 'エラー種別', 'メッセージ'];
  var RESULT_LABELS = {
    success: '成功',
    failure: '失敗',
    skipped: 'スキップ',
    continued: '続きあり'
  };
  var MAX_NAME_LENGTH = 100;
  var MAX_ERROR_TYPE_LENGTH = 50;
  var MAX_MESSAGE_LENGTH = 100;
  var DATE_FORMAT = 'yyyy-mm-dd hh:mm:ss';
  // 見出しを作るときの列幅（ピクセル）。開始・終了は日時が切れずに見える幅（実機確認 W2）
  var COLUMN_WIDTHS = [150, 150, 160, 80, 60, 120, 300];
  var LOG_PREFIX = '[WitGas.runlog] ';

  /**
   * 1 行足す。
   *
   * @param {Object} entry
   * @param {string} entry.name 処理名
   * @param {string} entry.result 'success' | 'failure' | 'skipped' | 'continued'
   * @param {Date} [entry.startedAt] 開始（省略時は終了と同じ）
   * @param {Date} [entry.endedAt] 終了（省略時は今）
   * @param {number} [entry.count] 件数（0 以上の整数）
   * @param {string} [entry.errorType] エラー種別（'TypeError' など）
   * @param {*} [entry.error] エラー。種別（name）だけを使い、メッセージは書かない
   * @param {string} [entry.message] 短いメッセージ（100 文字まで。個人情報や業務データを入れないこと）
   * @param {Object} [opts]
   * @param {string} [opts.spreadsheetId] 書くスプレッドシートの ID
   * @param {Object} [opts.spreadsheet] 書くスプレッドシート（spreadsheetId の代わり）
   * @param {string} [opts.sheetName='実行記録']
   * @param {number} [opts.maxRows=5000] 残す行数の上限（見出しを除く）
   * @param {boolean} [opts.matchTimeZone=false] 実行記録のシートを新しく作るとき（空のとき）、
   *     記録先のタイムゾーンがスクリプトと違えば、記録先をスクリプトのタイムゾーンに合わせる
   *     （先方のファイルの設定を変えるので、既定はオフ）
   * @return {{row: number, trimmed: number, timeZoneMismatch: boolean, timeZoneChanged: boolean}}
   *     書いた行の番号、消した古い行の数、記録先とスクリプトのタイムゾーンが違ったまま書いたか、
   *     記録先のタイムゾーンを合わせたか
   */
  function append(entry, opts) {
    var row = toRow_(entry);
    opts = opts || {};
    var cfg = checkOptions_(opts, 'append');
    var maxRows = cfg.maxRows;

    var ss = openSpreadsheet_(opts);
    var existing = ss.getSheetByName(cfg.sheetName);
    var fresh = !existing || existing.getLastRow() === 0;
    // 時刻を書く前に確かめる（書いたあとにタイムゾーンを変えても、書いた時刻は直らない）
    var tz = checkTimeZone_(ss, entry.name, cfg.matchTimeZone && fresh);
    var sheet = getSheet_(ss, cfg.sheetName);
    sheet.appendRow(row);
    var lastRow = sheet.getLastRow();
    sheet.getRange(lastRow, 1, 1, 2).setNumberFormat(DATE_FORMAT);

    var trimmed = 0;
    var dataRows = lastRow - 1; // 1 行目は見出し
    if (dataRows > maxRows) {
      trimmed = dataRows - maxRows;
      sheet.deleteRows(2, trimmed);
      lastRow -= trimmed;
    }
    return { row: lastRow, trimmed: trimmed, timeZoneMismatch: tz.mismatch, timeZoneChanged: tz.changed };
  }

  /**
   * opts だけを確かめる（スプレッドシートには触らない）。おかしければ投げる。
   * guard が実行の前に設定の誤りに気づくために使う。
   */
  function validateOptions(opts) {
    if (opts !== undefined && (opts === null || typeof opts !== 'object')) {
      throw new TypeError('WitGas.runlog.validateOptions: opts must be an object');
    }
    checkOptions_(opts || {}, 'validateOptions');
    return true;
  }

  function checkOptions_(opts, fnName) {
    var where = 'WitGas.runlog.' + fnName + ': ';
    var maxRows = opts.maxRows === undefined ? DEFAULT_MAX_ROWS : opts.maxRows;
    if (!isNonNegInt_(maxRows) || maxRows < 1) {
      throw new RangeError(where + 'opts.maxRows must be an integer >= 1');
    }
    var sheetName = opts.sheetName === undefined ? DEFAULT_SHEET_NAME : opts.sheetName;
    if (typeof sheetName !== 'string' || sheetName.trim() === '') {
      throw new TypeError(where + 'opts.sheetName must be a non-empty string');
    }
    if (opts.spreadsheetId !== undefined &&
        (typeof opts.spreadsheetId !== 'string' || opts.spreadsheetId.trim() === '')) {
      throw new TypeError(where + 'opts.spreadsheetId must be a non-empty string');
    }
    if (opts.spreadsheet !== undefined && (opts.spreadsheet === null || typeof opts.spreadsheet !== 'object')) {
      throw new TypeError(where + 'opts.spreadsheet must be a Spreadsheet');
    }
    if (opts.matchTimeZone !== undefined && typeof opts.matchTimeZone !== 'boolean') {
      throw new TypeError(where + 'opts.matchTimeZone must be a boolean');
    }
    return { maxRows: maxRows, sheetName: sheetName, matchTimeZone: opts.matchTimeZone === true };
  }

  function toRow_(entry) {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError('WitGas.runlog.append: entry must be an object');
    }
    if (typeof entry.name !== 'string' || entry.name.trim() === '') {
      throw new TypeError('WitGas.runlog.append: entry.name must be a non-empty string');
    }
    if (!Object.prototype.hasOwnProperty.call(RESULT_LABELS, entry.result)) {
      throw new TypeError('WitGas.runlog.append: entry.result must be one of ' + Object.keys(RESULT_LABELS).join(', '));
    }
    if (entry.count !== undefined && entry.count !== null && !isNonNegInt_(entry.count)) {
      throw new RangeError('WitGas.runlog.append: entry.count must be an integer >= 0');
    }
    checkDate_(entry.startedAt, 'startedAt');
    checkDate_(entry.endedAt, 'endedAt');
    if (entry.message !== undefined && entry.message !== null && typeof entry.message !== 'string') {
      throw new TypeError('WitGas.runlog.append: entry.message must be a string');
    }

    var endedAt = entry.endedAt || new Date();
    var startedAt = entry.startedAt || endedAt;
    var errorType = entry.errorType;
    if ((errorType === undefined || errorType === null) && entry.error !== undefined && entry.error !== null) {
      errorType = errorType_(entry.error);
    }
    return [
      startedAt,
      endedAt,
      cell_(entry.name, MAX_NAME_LENGTH),
      RESULT_LABELS[entry.result],
      isNonNegInt_(entry.count) ? entry.count : '',
      cell_(errorType, MAX_ERROR_TYPE_LENGTH),
      cell_(entry.message, MAX_MESSAGE_LENGTH)
    ];
  }

  function openSpreadsheet_(opts) {
    if (opts.spreadsheet) return opts.spreadsheet;
    if (opts.spreadsheetId !== undefined) {
      return SpreadsheetApp.openById(opts.spreadsheetId);
    }
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (!active) {
      throw new Error('WitGas.runlog.append: no spreadsheet (pass opts.spreadsheetId)');
    }
    return active;
  }

  function getSheet_(ss, sheetName) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
    }
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]).setFontWeight('bold');
      sheet.setFrozenRows(1);
      for (var c = 0; c < COLUMN_WIDTHS.length; c++) {
        sheet.setColumnWidth(c + 1, COLUMN_WIDTHS[c]);
      }
    }
    return sheet;
  }

  /**
   * 記録先のスプレッドシートとスクリプトのタイムゾーンを比べる。
   * 違うと、記録の時刻がずれて表示される。新しく作ったスプレッドシートは、一度シートを編集するまで
   * タイムゾーンが America/Los_Angeles で保存されていて、設定画面には「東京」と出るので気づけない
   * （2026-11-25・26 の実機確認 W1・W8）。
   * fix が true なら、記録先をスクリプトのタイムゾーンに合わせる。そうでなければ警告だけ出す。
   */
  function checkTimeZone_(ss, name, fix) {
    var none = { mismatch: false, changed: false };
    if (typeof ss.getSpreadsheetTimeZone !== 'function') return none;
    var sheetTz;
    var scriptTz;
    try {
      sheetTz = ss.getSpreadsheetTimeZone();
      scriptTz = Session.getScriptTimeZone();
    } catch (e) {
      return none;
    }
    if (sheetTz === scriptTz) return none;
    var label = ' (' + String(name).slice(0, MAX_NAME_LENGTH) + ')';
    if (fix && typeof ss.setSpreadsheetTimeZone === 'function') {
      try {
        ss.setSpreadsheetTimeZone(scriptTz);
        console.log(LOG_PREFIX + 'set spreadsheet time zone to ' + scriptTz + ' (was ' + sheetTz + ')' + label);
        return { mismatch: false, changed: true };
      } catch (e) {
        console.warn(LOG_PREFIX + 'could not set spreadsheet time zone (' + errorType_(e) + ')' + label);
      }
    }
    console.warn(LOG_PREFIX + 'time zone differs: spreadsheet ' + sheetTz + ', script ' + scriptTz + label);
    return { mismatch: true, changed: false };
  }

  /** セルに書く文字列：改行をなくし、長さを切り、式として読まれないようにする。 */
  function cell_(value, maxLength) {
    if (value === undefined || value === null) return '';
    var s = String(value).replace(/[\r\n\t]+/g, ' ').trim();
    if (s.length > maxLength) s = s.slice(0, maxLength - 1) + '…';
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return s;
  }

  function checkDate_(d, field) {
    if (d === undefined || d === null) return;
    if (typeof d.getTime !== 'function' || isNaN(d.getTime())) {
      throw new TypeError('WitGas.runlog.append: entry.' + field + ' must be a Date');
    }
  }

  function errorType_(e) {
    return (e && e.name) ? String(e.name) : typeof e;
  }

  function isNonNegInt_(n) {
    return typeof n === 'number' && isFinite(n) && n >= 0 && Math.floor(n) === n;
  }

  return {
    append: append,
    VERSION: '0.4.0',
    validateOptions: validateOptions,
    HEADER: HEADER.slice(),
    RESULT_LABELS: Object.freeze(Object.assign({}, RESULT_LABELS)),
    DEFAULT_SHEET_NAME: DEFAULT_SHEET_NAME,
    DEFAULT_MAX_ROWS: DEFAULT_MAX_ROWS
  };
})();
