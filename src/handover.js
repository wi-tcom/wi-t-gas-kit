/**
 * WitGas.handover — 引き継ぎ書
 *
 * トリガー・権限・スクリプトのプロパティ（値は伏せる）・シートの構成・設定値・止め方を集めて、
 * スプレッドシートの「引き継ぎ書」シートに書く。
 *
 * © 2026 wi-t.com Inc.
 */
var WitGas = WitGas || {};

WitGas.handover = (function () {
  'use strict';

  var DEFAULT_SHEET_NAME = '引き継ぎ書';
  var MARKER = '引き継ぎ書';
  var WIDTH = 5;
  var MAX_HEADER_COLUMNS = 20;
  var MAX_CELL_LENGTH = 300;
  var RESUME_PREFIX = 'WitGas.resume:';
  var DATE_FORMAT = 'yyyy-mm-dd hh:mm:ss';
  var COLUMN_WIDTHS = [220, 260, 200, 200, 200];
  var EVENT_LABELS = {
    CLOCK: '時間主導型',
    ON_OPEN: '開いたとき',
    ON_EDIT: '編集したとき',
    ON_CHANGE: '変更したとき',
    ON_FORM_SUBMIT: 'フォームの送信時',
    ON_EVENT_UPDATED: 'カレンダーの予定の更新時'
  };

  /**
   * 引き継ぎ書に書く中身を集める（シートには書かない）。
   *
   * @param {Object} [opts] write と同じ（書き先の指定は使わない）
   * @return {Object} { generatedAt, scriptId, timeZone, triggers, scopes, properties, sheets, settings, stopSteps, notes }
   */
  function collect(opts) {
    return collect_(validate_(opts, 'collect'));
  }

  function collect_(cfg) {
    var notes = [];
    var scriptApp = cfg.scriptApp || ScriptApp;
    var props = cfg.properties || PropertiesService.getScriptProperties();

    var propertyKeys = safe_(function () { return props.getKeys(); }, notes, 'スクリプトのプロパティ') || [];
    var resumeTriggers = resumeTriggerMap_(props, propertyKeys);

    return {
      generatedAt: new Date(),
      scriptId: safe_(function () { return scriptApp.getScriptId(); }, notes, 'スクリプト ID'),
      timeZone: safe_(function () { return Session.getScriptTimeZone(); }, notes, 'タイムゾーン'),
      triggers: collectTriggers_(scriptApp, resumeTriggers, notes),
      scopes: collectScopes_(scriptApp, cfg.scopes, notes),
      properties: collectProperties_(props, propertyKeys),
      sheets: cfg.inspect.map(function (ss) {
        // 書き先の「引き継ぎ書」シートそのものは構成に入れない（1 回目と 2 回目で中身が変わらないように）
        var skip = cfg.output && sameSpreadsheet_(ss, cfg.output) ? cfg.sheetName : null;
        return collectSheets_(ss, cfg.headers, notes, skip);
      }),
      settings: cfg.settings.map(function (s) {
        return { name: s.name, value: s.secret ? '（伏せる）' : s.value, note: s.note || '' };
      }),
      stopSteps: cfg.stopSteps.slice(),
      notes: notes
    };
  }

  /**
   * 引き継ぎ書を集めて、シートに書く。
   *
   * @param {Object} [opts]
   * @param {string} [opts.spreadsheetId] / {Object} [opts.spreadsheet] 書き先（省略時は開いているもの）
   * @param {string} [opts.sheetName='引き継ぎ書']
   * @param {Array<Object|string>} [opts.inspect] 構成を書くスプレッドシート（オブジェクトか ID）。省略時は書き先
   * @param {boolean} [opts.headers=false] 各シートの 1 行目（見出し）も書く。1 行目が見出しでないシートがあるときは false のまま
   * @param {Array<{scope: string, reason: string}>} [opts.scopes] appsscript.json の oauthScopes と、使う理由
   * @param {Array<{name: string, value: *, note?: string, secret?: boolean}>} [opts.settings] 設定値。secret なら値を伏せる
   * @param {string[]} [opts.stopSteps] 止め方（順番に書く）
   * @param {Object} [opts.properties] / {Object} [opts.scriptApp] 差し替えるときだけ
   * @return {{sheetName: string, rows: number, notes: string[]}}
   */
  function write(opts) {
    var cfg = validate_(opts, 'write');
    var ss = cfg.output;
    var sheet = ss.getSheetByName(cfg.sheetName);
    var fresh = !sheet || sheet.getLastRow() === 0;
    if (!fresh) {
      var a1 = sheet.getRange(1, 1, 1, 1).getValues()[0][0];
      if (a1 !== MARKER) {
        throw new Error('WitGas.handover.write: sheet "' + cfg.sheetName + '" is not a handover sheet (refusing to overwrite)');
      }
    }

    var info = collect_(cfg);
    var rows = toRows_(info);

    if (!sheet) sheet = ss.insertSheet(cfg.sheetName);
    if (!fresh) sheet.clearContents();
    sheet.getRange(1, 1, rows.length, WIDTH).setValues(rows);
    sheet.getRange(1, 2, 1, 1).setNumberFormat(DATE_FORMAT);
    if (fresh) {
      for (var c = 0; c < COLUMN_WIDTHS.length; c++) sheet.setColumnWidth(c + 1, COLUMN_WIDTHS[c]);
    }
    return { sheetName: cfg.sheetName, rows: rows.length, notes: info.notes.slice() };
  }

  // ---- 集める ----

  function collectTriggers_(scriptApp, resumeTriggers, notes) {
    var list = safe_(function () { return scriptApp.getProjectTriggers(); }, notes, 'トリガー');
    if (!list) return null;
    return list.map(function (t) {
      var id = String(t.getUniqueId());
      var event = String(t.getEventType());
      var source = safe_(function () { return String(t.getTriggerSource()); }, null) || '';
      var sourceId = safe_(function () {
        return typeof t.getTriggerSourceId === 'function' ? t.getTriggerSourceId() : null;
      }, null);
      return {
        handler: t.getHandlerFunction(),
        event: event,
        eventLabel: EVENT_LABELS[event] || event,
        source: source,
        sourceId: sourceId && source !== 'CLOCK' ? String(sourceId) : '',
        id: id,
        note: resumeTriggers.hasOwnProperty(id) ? 'WitGas.resume の続き（' + resumeTriggers[id] + '）' : ''
      };
    });
  }

  function collectScopes_(scriptApp, declared, notes) {
    var authorized = safe_(function () {
      if (typeof scriptApp.getAuthorizationInfo !== 'function') return null;
      var mode = scriptApp.AuthMode && scriptApp.AuthMode.FULL;
      var info = scriptApp.getAuthorizationInfo(mode);
      return info && typeof info.getAuthorizedScopes === 'function' ? info.getAuthorizedScopes() : null;
    }, notes, '承認済みの権限');
    var rows = declared.map(function (d) {
      return {
        scope: d.scope,
        reason: d.reason,
        authorized: authorized ? (authorized.indexOf(d.scope) >= 0 ? 'はい' : 'いいえ') : '分からない'
      };
    });
    if (authorized) {
      authorized.forEach(function (s) {
        var known = declared.some(function (d) { return d.scope === s; });
        if (!known) rows.push({ scope: s, reason: '（理由が書かれていない）', authorized: 'はい' });
      });
    }
    return rows;
  }

  function collectProperties_(props, keys) {
    return keys.slice().sort().map(function (key) {
      var detail = '（値は伏せる）';
      if (key.indexOf(RESUME_PREFIX) === 0) {
        // WitGas.resume の保存は進み具合だけで、業務データは入らない
        var s = parseJson_(props.getProperty(key));
        detail = s && typeof s.cursor === 'number'
          ? 'WitGas.resume の途中（cursor ' + s.cursor + '、runs ' + s.runs + (s.triggerId ? '、続きのトリガーあり' : '') + '）'
          : 'WitGas.resume の途中（読めない）';
      }
      return { key: key, detail: detail };
    });
  }

  function collectSheets_(ss, headers, notes, skipName) {
    var name = safe_(function () { return ss.getName(); }, null) || '';
    var id = safe_(function () { return ss.getId(); }, null) || '';
    var sheets = safe_(function () { return ss.getSheets(); }, notes, 'シートの構成（' + name + '）') || [];
    return {
      name: name,
      id: id,
      sheets: sheets.filter(function (s) { return s.getName() !== skipName; }).map(function (s) {
        var lastRow = s.getLastRow();
        var lastCol = s.getLastColumn();
        var header = '';
        if (headers && lastRow > 0 && lastCol > 0) {
          header = s.getRange(1, 1, 1, Math.min(lastCol, MAX_HEADER_COLUMNS)).getValues()[0]
            .map(function (v) { return v === null || v === undefined ? '' : String(v); })
            .join(' / ');
          if (lastCol > MAX_HEADER_COLUMNS) header += ' / …';
        }
        return { name: s.getName(), rows: lastRow, columns: lastCol, header: header };
      })
    };
  }

  function sameSpreadsheet_(a, b) {
    if (a === b) return true;
    var ida = safe_(function () { return a.getId(); }, null);
    var idb = safe_(function () { return b.getId(); }, null);
    return ida !== null && ida === idb;
  }

  function resumeTriggerMap_(props, keys) {
    var map = {};
    keys.forEach(function (key) {
      if (key.indexOf(RESUME_PREFIX) !== 0) return;
      var s = parseJson_(props.getProperty(key));
      if (s && s.triggerId) map[String(s.triggerId)] = key.slice(RESUME_PREFIX.length);
    });
    return map;
  }

  // ---- 書く ----

  function toRows_(info) {
    var rows = [];
    var add = function (cells) { rows.push(pad_(cells.map(cell_))); };
    var blank = function () { rows.push(pad_([])); };

    rows.push(pad_([MARKER, info.generatedAt]));
    add(['スクリプト ID', info.scriptId || '（読めなかった）']);
    add(['タイムゾーン', info.timeZone || '（読めなかった）']);

    blank();
    add(['■ トリガー', 'この引き継ぎ書を作った人が作ったトリガーだけが出ます。時間主導型の時刻はトリガーの画面で確かめてください。']);
    add(['関数', '種類', '起動元', 'ID', '備考']);
    if (info.triggers === null) {
      add(['（読めなかった）']);
    } else if (info.triggers.length === 0) {
      add(['（なし）']);
    } else {
      info.triggers.forEach(function (t) {
        add([t.handler, t.eventLabel, t.sourceId ? t.source + '（' + t.sourceId + '）' : t.source, t.id, t.note]);
      });
    }

    blank();
    add(['■ 権限', '「承認済み」は、GAS がこのスクリプトに承認済みと返した権限と突き合わせた結果です。']);
    add(['権限', '理由', '承認済み']);
    if (info.scopes.length === 0) {
      add(['（渡されていない：appsscript.json の oauthScopes を見てください）']);
    } else {
      info.scopes.forEach(function (s) { add([s.scope, s.reason, s.authorized]); });
    }

    blank();
    add(['■ スクリプトのプロパティ', '値は書きません。']);
    add(['キー', '中身']);
    if (info.properties.length === 0) {
      add(['（なし）']);
    } else {
      info.properties.forEach(function (p) { add([p.key, p.detail]); });
    }

    info.sheets.forEach(function (book) {
      blank();
      add(['■ シートの構成', book.name + (book.id ? '（' + book.id + '）' : '')]);
      add(['シート', '行数', '列数', '見出し（1 行目）']);
      book.sheets.forEach(function (s) { add([s.name, s.rows, s.columns, s.header]); });
    });

    blank();
    add(['■ 設定値']);
    add(['名前', '値', '説明']);
    if (info.settings.length === 0) {
      add(['（なし）']);
    } else {
      info.settings.forEach(function (s) { add([s.name, s.value, s.note]); });
    }

    blank();
    add(['■ 止め方']);
    if (info.stopSteps.length === 0) {
      add(['（書かれていない）']);
    } else {
      info.stopSteps.forEach(function (step, i) { add([String(i + 1), step]); });
    }

    if (info.notes.length > 0) {
      blank();
      add(['■ 読めなかったもの']);
      info.notes.forEach(function (n) { add([n]); });
    }
    return rows;
  }

  // ---- 引数 ----

  function validate_(opts, fnName) {
    var where = 'WitGas.handover.' + fnName + ': ';
    opts = opts || {};
    if (typeof opts !== 'object') throw new TypeError(where + 'opts must be an object');

    var sheetName = opts.sheetName === undefined ? DEFAULT_SHEET_NAME : opts.sheetName;
    if (typeof sheetName !== 'string' || sheetName.trim() === '') {
      throw new TypeError(where + 'opts.sheetName must be a non-empty string');
    }
    if (opts.headers !== undefined && typeof opts.headers !== 'boolean') {
      throw new TypeError(where + 'opts.headers must be a boolean');
    }
    var scopes = opts.scopes || [];
    if (!Array.isArray(scopes) || !scopes.every(function (s) {
      return s && isText_(s.scope) && isText_(s.reason);
    })) {
      throw new TypeError(where + 'opts.scopes must be an array of {scope, reason}');
    }
    var settings = opts.settings || [];
    if (!Array.isArray(settings) || !settings.every(function (s) {
      return s && isText_(s.name) && (s.note === undefined || typeof s.note === 'string') &&
        (s.secret === undefined || typeof s.secret === 'boolean');
    })) {
      throw new TypeError(where + 'opts.settings must be an array of {name, value, note?, secret?}');
    }
    var stopSteps = opts.stopSteps || [];
    if (!Array.isArray(stopSteps) || !stopSteps.every(isText_)) {
      throw new TypeError(where + 'opts.stopSteps must be an array of strings');
    }
    if (opts.inspect !== undefined && !Array.isArray(opts.inspect)) {
      throw new TypeError(where + 'opts.inspect must be an array');
    }

    var output = fnName === 'write' || opts.inspect === undefined || opts.spreadsheet || opts.spreadsheetId !== undefined
      ? openSpreadsheet_(opts, where) : null;
    var inspect = (opts.inspect || [output]).map(function (x) {
      if (typeof x === 'string') {
        if (x.trim() === '') throw new TypeError(where + 'opts.inspect has an empty ID');
        return SpreadsheetApp.openById(x);
      }
      if (!x || typeof x !== 'object') throw new TypeError(where + 'opts.inspect must hold spreadsheets or IDs');
      return x;
    });
    return {
      output: output,
      sheetName: sheetName,
      headers: opts.headers === true,
      scopes: scopes,
      settings: settings.map(function (s) {
        return { name: s.name, value: settingValue_(s.value), note: s.note, secret: s.secret === true };
      }),
      stopSteps: stopSteps,
      inspect: inspect,
      properties: opts.properties,
      scriptApp: opts.scriptApp
    };
  }

  function openSpreadsheet_(opts, where) {
    if (opts.spreadsheet) return opts.spreadsheet;
    if (opts.spreadsheetId !== undefined) {
      if (!isText_(opts.spreadsheetId)) throw new TypeError(where + 'opts.spreadsheetId must be a non-empty string');
      return SpreadsheetApp.openById(opts.spreadsheetId);
    }
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (!active) throw new Error(where + 'no spreadsheet (pass opts.spreadsheetId)');
    return active;
  }

  // ---- 小さな道具 ----

  /** 読めなければ null を返し、notes に「何が読めなかったか」とエラー種別だけを足す。 */
  function safe_(fn, notes, label) {
    try {
      return fn();
    } catch (e) {
      if (notes) notes.push(label + '：読めなかった（' + ((e && e.name) ? e.name : typeof e) + '）');
      return null;
    }
  }

  /** 設定値をセルに書ける形にする（文字・数・真偽・日付はそのまま、ほかは JSON の文字） */
  function settingValue_(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v.getTime === 'function') return v;
    try {
      return JSON.stringify(v);
    } catch (e) {
      return String(v);
    }
  }

  function parseJson_(raw) {
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function cell_(v) {
    if (v === null || v === undefined) return '';
    if (typeof v !== 'string') return v;
    var s = v.replace(/[\r\n\t]+/g, ' ');
    if (s.length > MAX_CELL_LENGTH) s = s.slice(0, MAX_CELL_LENGTH - 1) + '…';
    return /^[=+\-@]/.test(s) ? "'" + s : s;
  }

  function pad_(arr) {
    var out = arr.slice(0, WIDTH);
    while (out.length < WIDTH) out.push('');
    return out;
  }

  function isText_(s) {
    return typeof s === 'string' && s.trim() !== '';
  }

  return {
    collect: collect,
    write: write,
    DEFAULT_SHEET_NAME: DEFAULT_SHEET_NAME
  };
})();
