/**
 * WitGas.reconcile — 照合
 *
 * 2 つの表（見出しのある 2 次元配列）をキーで突き合わせ、
 * 一致・不一致・左だけ・右だけ・キー重複・キーなし に分ける。
 * どの行も、必ずどれか 1 つの区分に入る（数えれば元の行数と合う）。
 *
 * © 2026 wi-t.com Inc.
 */
var WitGas = WitGas || {};

WitGas.reconcile = (function () {
  'use strict';

  var DEFAULT_SHEET_NAME = '照合結果';
  var REPORT_MARKER = '照合日時';
  var REPORT_WIDTH = 7;
  var DATE_FORMAT = 'yyyy-mm-dd hh:mm:ss';
  var CATEGORY_KEYS = ['matched', 'mismatched', 'leftOnly', 'rightOnly', 'duplicates', 'blankKey'];

  /**
   * 2 つの表を突き合わせる。
   *
   * @param {Array<Array<*>>} left 左の表（1 行目が見出し）。シートの getValues() や Utilities.parseCsv() の結果
   * @param {Array<Array<*>>} right 右の表（1 行目が見出し）
   * @param {Object} opts
   * @param {string|string[]} opts.key キーの列名（左の見出し）。複数列なら配列
   * @param {string[]} [opts.columns] 比べる列名（左の見出し）。省略時は両方にある列すべて（キーを除く）
   * @param {Object<string,string>} [opts.columnMap] 左の列名 → 右の列名（名前が違う列だけ）
   * @param {string[]} [opts.numberColumns] 数として比べる列（"1,000"・"¥1,000"・"△500" も数にする）
   * @param {string[]} [opts.dateColumns] 日付として比べる列（"2026/1/5"・"2026年1月5日" も日付にする）
   * @param {boolean} [opts.trim=true] 前後の空白を無視する
   * @param {boolean} [opts.width=false] 全角と半角の違いを無視する（NFKC でそろえる）
   * @param {string} [opts.timeZone] 日付の値を文字にするときのタイムゾーン（省略時はスクリプトのタイムゾーン）
   * @return {Object} 結果（README を参照）
   */
  function compare(left, right, opts) {
    var cfg = validate_(left, right, opts);
    var L = index_(left, cfg, 'left');
    var R = index_(right, cfg, 'right');

    var result = {
      columns: cfg.columns.slice(),
      key: cfg.keys.slice(),
      matched: [],
      mismatched: [],
      leftOnly: [],
      rightOnly: [],
      duplicates: [],
      blankKey: L.blank.concat(R.blank),
      summary: null
    };

    var k;
    for (var i = 0; i < L.order.length; i++) {
      k = L.order[i];
      var lrows = L.map[k];
      var rrows = R.map.hasOwnProperty(k) ? R.map[k] : [];
      if (lrows.length > 1 || rrows.length > 1) {
        result.duplicates.push({
          key: lrows[0].keyValues,
          leftRows: lrows.map(rowNo_),
          rightRows: rrows.map(rowNo_)
        });
      } else if (rrows.length === 0) {
        result.leftOnly.push({ key: lrows[0].keyValues, leftRow: lrows[0].row });
      } else {
        var diffs = diff_(lrows[0], rrows[0], cfg);
        var entry = { key: lrows[0].keyValues, leftRow: lrows[0].row, rightRow: rrows[0].row };
        if (diffs.length === 0) {
          result.matched.push(entry);
        } else {
          entry.diffs = diffs;
          result.mismatched.push(entry);
        }
      }
    }
    for (var j = 0; j < R.order.length; j++) {
      k = R.order[j];
      if (L.map.hasOwnProperty(k)) continue;
      var rr = R.map[k];
      if (rr.length > 1) {
        result.duplicates.push({ key: rr[0].keyValues, leftRows: [], rightRows: rr.map(rowNo_) });
      } else {
        result.rightOnly.push({ key: rr[0].keyValues, rightRow: rr[0].row });
      }
    }

    result.summary = summarize_(result, L, R);
    return result;
  }

  /**
   * 件数だけの短い文（実行記録のメッセージ向け。業務データは入らない）。
   * @return {string} 例：'一致 120 / 不一致 3 / 左だけ 1 / 右だけ 0 / キー重複 0 / キーなし 0'
   */
  function summaryText(result, labels) {
    var s = result && result.summary;
    if (!s) throw new TypeError('WitGas.reconcile.summaryText: result must come from compare()');
    var names = categoryNames_(labels);
    return CATEGORY_KEYS.map(function (c) { return names[c] + ' ' + s[c]; }).join(' / ');
  }

  /**
   * 結果をシートに書く。シートがなければ作る。
   * 書く先のシートは、空か、前に writeReport で書いたものに限る（ほかのデータを消さないため）。
   *
   * @param {Object} result compare() の結果
   * @param {Object} [opts]
   * @param {string} [opts.spreadsheetId] / {Object} [opts.spreadsheet] 書くスプレッドシート（省略時は開いているもの）
   * @param {string} [opts.sheetName='照合結果']
   * @param {{left: string, right: string}} [opts.labels] 表の呼び名（既定は 左・右）
   * @param {boolean} [opts.includeMatched=false] 一致した行も明細に書く
   * @return {{sheetName: string, detailRows: number}}
   */
  function writeReport(result, opts) {
    if (!result || !result.summary) {
      throw new TypeError('WitGas.reconcile.writeReport: result must come from compare()');
    }
    opts = opts || {};
    var sheetName = opts.sheetName === undefined ? DEFAULT_SHEET_NAME : opts.sheetName;
    if (typeof sheetName !== 'string' || sheetName.trim() === '') {
      throw new TypeError('WitGas.reconcile.writeReport: opts.sheetName must be a non-empty string');
    }
    var labels = checkLabels_(opts.labels, 'writeReport');
    var names = categoryNames_(labels);
    var report = reportRows_(result, labels, names, !!opts.includeMatched);
    var rows = report.rows;

    var ss = openSpreadsheet_(opts);
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
    } else if (sheet.getLastRow() > 0) {
      var a1 = sheet.getRange(1, 1, 1, 1).getValues()[0][0];
      if (a1 !== REPORT_MARKER) {
        throw new Error('WitGas.reconcile.writeReport: sheet "' + sheetName + '" is not a reconcile report (refusing to overwrite)');
      }
      sheet.clearContents();
    }
    sheet.getRange(1, 1, rows.length, REPORT_WIDTH).setValues(rows);
    sheet.getRange(1, 2, 1, 1).setNumberFormat(DATE_FORMAT);
    return { sheetName: sheetName, detailRows: rows.length - report.headerRows };
  }

  // ---- 内部：照合 ----

  function index_(table, cfg, side) {
    var header = table[0];
    var colIndex = side === 'left' ? cfg.leftIndex : cfg.rightIndex;
    var keyIdx = cfg.keys.map(function (k) { return colIndex[k]; });
    var map = {};
    var order = [];
    var blank = [];
    var rows = 0;
    var empty = 0;
    for (var r = 1; r < table.length; r++) {
      var line = table[r] || [];
      if (isEmptyRow_(line, header.length)) {
        empty++;
        continue;
      }
      rows++;
      var keyNorm = [];
      var keyValues = [];
      var allBlank = true;
      for (var i = 0; i < keyIdx.length; i++) {
        var raw = line[keyIdx[i]];
        var n = normalize_(raw, cfg.keys[i], cfg);
        if (n !== '') allBlank = false;
        keyNorm.push(n);
        keyValues.push(raw === undefined || raw === null ? '' : raw);
      }
      if (allBlank) {
        blank.push({ side: side, row: r + 1 });
        continue;
      }
      var k = JSON.stringify(keyNorm);
      if (!map.hasOwnProperty(k)) {
        map[k] = [];
        order.push(k);
      }
      map[k].push({ row: r + 1, line: line, keyValues: keyValues });
    }
    return { map: map, order: order, blank: blank, rows: rows, empty: empty };
  }

  function diff_(l, r, cfg) {
    var diffs = [];
    for (var i = 0; i < cfg.columns.length; i++) {
      var col = cfg.columns[i];
      var lv = l.line[cfg.leftIndex[col]];
      var rv = r.line[cfg.rightIndex[col]];
      if (normalize_(lv, col, cfg) !== normalize_(rv, col, cfg)) {
        diffs.push({
          column: col,
          rightColumn: cfg.rightName[col],
          left: lv === undefined || lv === null ? '' : lv,
          right: rv === undefined || rv === null ? '' : rv
        });
      }
    }
    return diffs;
  }

  /** 比べるための値にそろえる。数の列は数（読めなければ文字）、それ以外は文字。 */
  function normalize_(v, col, cfg) {
    var isNum = cfg.numberSet.hasOwnProperty(col);
    var isDate = cfg.dateSet.hasOwnProperty(col);
    if (v === undefined || v === null) return '';
    if (isDateValue_(v)) {
      var s = Utilities.formatDate(v, cfg.timeZone(), 'yyyy-MM-dd HH:mm:ss');
      return isDate ? s.slice(0, 10) : s;
    }
    if (typeof v === 'number') return isNum ? v : String(v);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    var str = String(v);
    if (cfg.width) str = str.normalize('NFKC');
    if (cfg.trim) str = str.trim();
    if (isNum) {
      var num = parseNumber_(str);
      if (num !== null) return num;
    }
    if (isDate) {
      var d = parseDate_(str);
      if (d !== null) return d;
    }
    return str;
  }

  function parseNumber_(s) {
    var t = s.normalize('NFKC').replace(/\s+/g, '').replace(/,/g, '').replace(/^[¥\\]/, '').replace(/円$/, '');
    if (/^[△▲]/.test(t)) t = '-' + t.slice(1);
    if (!/^[+-]?\d+(\.\d+)?$/.test(t)) return null;
    var n = Number(t);
    return isFinite(n) ? n : null;
  }

  function parseDate_(s) {
    var t = s.normalize('NFKC').trim();
    var m = /^(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})日?$/.exec(t);
    if (!m) return null;
    var mo = Number(m[2]);
    var d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return m[1] + '-' + pad2_(mo) + '-' + pad2_(d);
  }

  function summarize_(result, L, R) {
    var dupLeft = 0;
    var dupRight = 0;
    result.duplicates.forEach(function (d) {
      dupLeft += d.leftRows.length;
      dupRight += d.rightRows.length;
    });
    var blankLeft = result.blankKey.filter(function (b) { return b.side === 'left'; }).length;
    var s = {
      matched: result.matched.length,
      mismatched: result.mismatched.length,
      leftOnly: result.leftOnly.length,
      rightOnly: result.rightOnly.length,
      duplicates: result.duplicates.length,
      blankKey: result.blankKey.length,
      leftRows: L.rows,
      rightRows: R.rows,
      leftEmptyRows: L.empty,
      rightEmptyRows: R.empty
    };
    // 確かめ算：どの行もどれか 1 つの区分に入っている
    var leftSum = s.matched + s.mismatched + s.leftOnly + dupLeft + blankLeft;
    var rightSum = s.matched + s.mismatched + s.rightOnly + dupRight + (s.blankKey - blankLeft);
    if (leftSum !== L.rows || rightSum !== R.rows) {
      throw new Error('WitGas.reconcile: internal check failed (row counts do not add up)');
    }
    return s;
  }

  // ---- 内部：レポート ----

  function reportRows_(result, labels, names, includeMatched) {
    var s = result.summary;
    var rows = [];
    rows.push(pad_([REPORT_MARKER, new Date()]));
    rows.push(pad_(['表', labels.left + '：' + s.leftRows + ' 行', labels.right + '：' + s.rightRows + ' 行']));
    rows.push(pad_(['区分', '件数']));
    CATEGORY_KEYS.forEach(function (c) { rows.push(pad_([names[c], s[c]])); });
    rows.push(pad_([]));
    rows.push(['区分', 'キー', labels.left + 'の行', labels.right + 'の行', '列', labels.left + 'の値', labels.right + 'の値']);
    var headerRows = rows.length;

    result.mismatched.forEach(function (m) {
      m.diffs.forEach(function (d) {
        var colName = d.rightColumn && d.rightColumn !== d.column ? d.column + ' / ' + d.rightColumn : d.column;
        rows.push([names.mismatched, keyText_(m.key), m.leftRow, m.rightRow, cell_(colName), cell_(d.left), cell_(d.right)]);
      });
    });
    result.leftOnly.forEach(function (x) { rows.push(pad_([names.leftOnly, keyText_(x.key), x.leftRow])); });
    result.rightOnly.forEach(function (x) { rows.push(pad_([names.rightOnly, keyText_(x.key), '', x.rightRow])); });
    result.duplicates.forEach(function (x) {
      rows.push(pad_([names.duplicates, keyText_(x.key), x.leftRows.join(', '), x.rightRows.join(', ')]));
    });
    result.blankKey.forEach(function (x) {
      rows.push(pad_([names.blankKey, '', x.side === 'left' ? x.row : '', x.side === 'right' ? x.row : '']));
    });
    if (includeMatched) {
      result.matched.forEach(function (x) { rows.push(pad_([names.matched, keyText_(x.key), x.leftRow, x.rightRow])); });
    }
    return { rows: rows, headerRows: headerRows };
  }

  function categoryNames_(labels) {
    labels = labels || { left: '左', right: '右' };
    return {
      matched: '一致',
      mismatched: '不一致',
      leftOnly: labels.left + 'だけ',
      rightOnly: labels.right + 'だけ',
      duplicates: 'キー重複',
      blankKey: 'キーなし'
    };
  }

  function keyText_(keyValues) {
    return cell_(keyValues.map(function (v) {
      return isDateValue_(v) ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss') : String(v);
    }).join(' / '));
  }

  /** 文字は式として読まれないようにする。数と日付はそのまま。 */
  function cell_(v) {
    if (typeof v !== 'string') return v;
    return /^[=+\-@]/.test(v) ? "'" + v : v;
  }

  function pad_(arr) {
    var out = arr.slice();
    while (out.length < REPORT_WIDTH) out.push('');
    return out;
  }

  function openSpreadsheet_(opts) {
    if (opts.spreadsheet) return opts.spreadsheet;
    if (opts.spreadsheetId !== undefined) {
      if (typeof opts.spreadsheetId !== 'string' || opts.spreadsheetId.trim() === '') {
        throw new TypeError('WitGas.reconcile.writeReport: opts.spreadsheetId must be a non-empty string');
      }
      return SpreadsheetApp.openById(opts.spreadsheetId);
    }
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (!active) throw new Error('WitGas.reconcile.writeReport: no spreadsheet (pass opts.spreadsheetId)');
    return active;
  }

  // ---- 内部：引数の確かめ ----

  function validate_(left, right, opts) {
    var where = 'WitGas.reconcile.compare: ';
    checkTable_(left, where + 'left');
    checkTable_(right, where + 'right');
    if (!opts || typeof opts !== 'object') throw new TypeError(where + 'opts.key is required');

    var keys = typeof opts.key === 'string' ? [opts.key] : opts.key;
    if (!Array.isArray(keys) || keys.length === 0 || !keys.every(isName_)) {
      throw new TypeError(where + 'opts.key must be a column name or an array of column names');
    }
    if (hasDup_(keys)) throw new TypeError(where + 'opts.key has the same column twice');

    var columnMap = opts.columnMap || {};
    if (typeof columnMap !== 'object' || Array.isArray(columnMap)) {
      throw new TypeError(where + 'opts.columnMap must be an object');
    }
    Object.keys(columnMap).forEach(function (k) {
      if (!isName_(columnMap[k])) throw new TypeError(where + 'opts.columnMap values must be column names');
    });
    var rightNameOf = function (c) { return columnMap.hasOwnProperty(c) ? columnMap[c] : c; };

    var leftHeader = headerIndex_(left[0]);
    var rightHeader = headerIndex_(right[0]);

    var columns = opts.columns;
    if (columns === undefined) {
      columns = left[0].map(headerName_).filter(function (c, i, all) {
        return c !== '' && all.indexOf(c) === i && keys.indexOf(c) < 0 && rightHeader.index.hasOwnProperty(rightNameOf(c));
      });
    } else if (!Array.isArray(columns) || !columns.every(isName_) || hasDup_(columns)) {
      throw new TypeError(where + 'opts.columns must be an array of distinct column names');
    }

    var used = keys.concat(columns);
    var leftIndex = {};
    var rightIndex = {};
    var rightName = {};
    used.forEach(function (c) {
      leftIndex[c] = findColumn_(leftHeader, c, where + 'left');
      rightName[c] = rightNameOf(c);
      rightIndex[c] = findColumn_(rightHeader, rightName[c], where + 'right');
    });

    var numberSet = toSet_(opts.numberColumns, used, where + 'opts.numberColumns');
    var dateSet = toSet_(opts.dateColumns, used, where + 'opts.dateColumns');
    ['trim', 'width'].forEach(function (f) {
      if (opts[f] !== undefined && typeof opts[f] !== 'boolean') throw new TypeError(where + 'opts.' + f + ' must be a boolean');
    });
    if (opts.timeZone !== undefined && !isName_(opts.timeZone)) {
      throw new TypeError(where + 'opts.timeZone must be a non-empty string');
    }
    var tz = null;
    return {
      keys: keys.slice(),
      columns: columns.slice(),
      leftIndex: leftIndex,
      rightIndex: rightIndex,
      rightName: rightName,
      numberSet: numberSet,
      dateSet: dateSet,
      trim: opts.trim !== false,
      width: opts.width === true,
      timeZone: function () {
        if (tz === null) tz = opts.timeZone || Session.getScriptTimeZone();
        return tz;
      }
    };
  }

  function checkTable_(t, name) {
    if (!Array.isArray(t) || t.length === 0 || !Array.isArray(t[0])) {
      throw new TypeError(name + ' must be a 2D array with a header row');
    }
    for (var i = 1; i < t.length; i++) {
      if (!Array.isArray(t[i])) throw new TypeError(name + ' row ' + (i + 1) + ' is not an array');
    }
  }

  function headerIndex_(header) {
    var index = {};
    var dup = {};
    header.forEach(function (h, i) {
      var name = headerName_(h);
      if (name === '') return;
      if (index.hasOwnProperty(name)) dup[name] = true;
      else index[name] = i;
    });
    return { index: index, dup: dup };
  }

  function headerName_(h) {
    return h === undefined || h === null ? '' : String(h).trim();
  }

  function findColumn_(h, name, where) {
    if (h.dup.hasOwnProperty(name)) throw new Error(where + ': column "' + name + '" appears more than once in the header');
    if (!h.index.hasOwnProperty(name)) throw new Error(where + ': column "' + name + '" not found in the header');
    return h.index[name];
  }

  function toSet_(list, used, where) {
    var set = {};
    if (list === undefined) return set;
    if (!Array.isArray(list) || !list.every(isName_)) throw new TypeError(where + ' must be an array of column names');
    list.forEach(function (c) {
      if (used.indexOf(c) < 0) throw new Error(where + ': "' + c + '" is not a key or a compared column');
      set[c] = true;
    });
    return set;
  }

  function checkLabels_(labels, fnName) {
    if (labels === undefined) return { left: '左', right: '右' };
    if (!labels || !isName_(labels.left) || !isName_(labels.right)) {
      throw new TypeError('WitGas.reconcile.' + fnName + ': opts.labels must be {left, right}');
    }
    return { left: labels.left.trim(), right: labels.right.trim() };
  }

  function isEmptyRow_(line, width) {
    var n = Math.max(line.length, width);
    for (var i = 0; i < n; i++) {
      var v = line[i];
      if (v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')) return false;
    }
    return true;
  }

  function isDateValue_(v) {
    return v !== null && typeof v === 'object' && typeof v.getTime === 'function' && !isNaN(v.getTime());
  }

  function isName_(s) {
    return typeof s === 'string' && s.trim() !== '';
  }

  function hasDup_(arr) {
    return arr.some(function (v, i) { return arr.indexOf(v) !== i; });
  }

  function pad2_(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function rowNo_(x) {
    return x.row;
  }

  return {
    compare: compare,
    summaryText: summaryText,
    writeReport: writeReport,
    DEFAULT_SHEET_NAME: DEFAULT_SHEET_NAME
  };
})();
