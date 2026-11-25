'use strict';

/**
 * SpreadsheetApp の偽物（実行記録に使う分だけ）。
 * シートの中身は 2 次元配列で持つ。値は書いたものをそのまま持つ（式の評価はしない）。
 *
 * テスト用の操作：
 *   addSpreadsheet(id, {active})  スプレッドシートを作る
 *   failNextAppend(err)           次の appendRow を失敗させる
 */
function createSheet(name) {
  const rows = [];
  const meta = { frozenRows: 0, formats: [], fontWeights: [], deleteCalls: [] };

  const sheet = {
    _rows: rows,
    _meta: meta,
    _appendError: null,
    getName: () => name,
    getLastRow() {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].some((v) => v !== '' && v !== null && v !== undefined)) return i + 1;
      }
      return 0;
    },
    getMaxRows: () => Math.max(1000, rows.length),
    appendRow(values) {
      if (sheet._appendError) {
        const err = sheet._appendError;
        sheet._appendError = null;
        throw err;
      }
      const at = sheet.getLastRow();
      rows.length = at;
      rows.push(values.slice());
      return sheet;
    },
    getRange(row, col, numRows, numCols) {
      if (!(row >= 1 && col >= 1)) throw new Error('Range out of bounds');
      numRows = numRows || 1;
      numCols = numCols || 1;
      const range = {
        setValues(values) {
          if (values.length !== numRows || values.some((r) => r.length !== numCols)) {
            throw new Error('The number of rows or columns in the data does not match the range');
          }
          for (let r = 0; r < numRows; r++) {
            while (rows.length < row + r) rows.push([]);
            const target = rows[row - 1 + r];
            for (let c = 0; c < numCols; c++) target[col - 1 + c] = values[r][c];
          }
          return range;
        },
        getValues() {
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const src = rows[row - 1 + r] || [];
            const line = [];
            for (let c = 0; c < numCols; c++) {
              const v = src[col - 1 + c];
              line.push(v === undefined ? '' : v);
            }
            out.push(line);
          }
          return out;
        },
        setNumberFormat(fmt) {
          meta.formats.push({ row, col, numRows, numCols, fmt });
          return range;
        },
        setFontWeight(w) {
          meta.fontWeights.push({ row, col, numRows, numCols, w });
          return range;
        }
      };
      return range;
    },
    clearContents() {
      meta.clearCalls = (meta.clearCalls || 0) + 1;
      rows.length = 0;
      return sheet;
    },
    deleteRows(start, howMany) {
      meta.deleteCalls.push([start, howMany]);
      rows.splice(start - 1, howMany);
    },
    setFrozenRows(n) {
      meta.frozenRows = n;
    },
    getFrozenRows: () => meta.frozenRows,
    // --- テスト用 ---
    values() {
      return rows.map((r) => r.slice());
    }
  };
  return sheet;
}

function createSpreadsheet(id) {
  const sheets = new Map();
  const ss = {
    getId: () => id,
    getUrl: () => 'https://docs.google.com/spreadsheets/d/' + id + '/edit',
    getSheetByName: (name) => sheets.get(name) || null,
    insertSheet(name) {
      if (sheets.has(name)) throw new Error('A sheet with the name "' + name + '" already exists.');
      const s = createSheet(name);
      sheets.set(name, s);
      return s;
    },
    getSheets: () => Array.from(sheets.values())
  };
  return ss;
}

function createSpreadsheetApp() {
  const books = new Map();
  let active = null;
  const calls = [];
  return {
    openById(id) {
      calls.push({ method: 'openById', id });
      const ss = books.get(id);
      if (!ss) throw new Error('Unexpected error while getting the method or property openById on object SpreadsheetApp.');
      return ss;
    },
    getActiveSpreadsheet() {
      calls.push({ method: 'getActiveSpreadsheet' });
      return active;
    },
    // --- テスト用 ---
    addSpreadsheet(id, options) {
      const ss = createSpreadsheet(id);
      books.set(id, ss);
      if (options && options.active) active = ss;
      return ss;
    },
    get calls() {
      return calls;
    }
  };
}

module.exports = { createSpreadsheetApp };
