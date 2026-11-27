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
    getLastColumn() {
      let n = 0;
      for (const r of rows) {
        for (let c = r.length - 1; c >= 0; c--) {
          if (r[c] !== '' && r[c] !== null && r[c] !== undefined) { n = Math.max(n, c + 1); break; }
        }
      }
      return n;
    },
    getDataRange() {
      return sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()), Math.max(1, sheet.getLastColumn()));
    },
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
    setColumnWidth(column, width) {
      meta.columnWidths = meta.columnWidths || {};
      meta.columnWidths[column] = width;
      return sheet;
    },
    getFrozenRows: () => meta.frozenRows,
    // --- テスト用 ---
    values() {
      return rows.map((r) => r.slice());
    }
  };
  return sheet;
}

function createSpreadsheet(id, timeZone, name) {
  const sheets = new Map();
  const toasts = [];
  let tz = timeZone || 'Asia/Tokyo';
  const ss = {
    getId: () => id,
    getName: () => name || id,
    getSpreadsheetTimeZone: () => tz,
    setSpreadsheetTimeZone(z) { tz = z; },
    getUrl: () => 'https://docs.google.com/spreadsheets/d/' + id + '/edit',
    getSheetByName: (name) => sheets.get(name) || null,
    insertSheet(name) {
      if (sheets.has(name)) throw new Error('A sheet with the name "' + name + '" already exists.');
      const s = createSheet(name);
      sheets.set(name, s);
      return s;
    },
    getSheets: () => Array.from(sheets.values()),
    toast(message, title, timeoutSeconds) {
      toasts.push({ message, title, timeoutSeconds });
    },
    // --- テスト用 ---
    toasts
  };
  return ss;
}

/**
 * getUi() の偽物。メニューとアラートを記録する。
 * withoutUi() にすると、エディタやトリガーから動かしたときと同じく getUi() が失敗する。
 */
function createUi(state) {
  return {
    createMenu(title) {
      const menu = { title, items: [] };
      const builder = {
        addItem(caption, functionName) { menu.items.push({ caption, functionName }); return builder; },
        addSeparator() { menu.items.push({ separator: true }); return builder; },
        addToUi() { state.menus.push(menu); }
      };
      return builder;
    },
    alert(message) {
      state.alerts.push(message);
      return 'OK';
    }
  };
}

function createSpreadsheetApp() {
  const books = new Map();
  let active = null;
  const calls = [];
  const uiState = { menus: [], alerts: [], available: true };
  return {
    getUi() {
      if (!uiState.available) throw new Error('Cannot call SpreadsheetApp.getUi() from this context.');
      return createUi(uiState);
    },
    getActive() {
      calls.push({ method: 'getActive' });
      return active;
    },
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
      const ss = createSpreadsheet(id, options && options.timeZone, options && options.name);
      books.set(id, ss);
      if (options && options.active) active = ss;
      return ss;
    },
    get calls() {
      return calls;
    },
    ui: uiState,
    withoutUi() {
      uiState.available = false;
    }
  };
}

module.exports = { createSpreadsheetApp };
