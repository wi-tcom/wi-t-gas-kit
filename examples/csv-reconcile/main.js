/**
 * 見本：CSV照合
 *
 * 「会計」シートの表と、「CSV貼り付け」シートに取り込んだ CSV（銀行の入金明細など）を
 * 請求番号で突き合わせ、「照合結果」シートに一致・不一致・片方だけ を出す。
 * 実行は WitGas.guard で包み、「実行記録」シートに件数を残し、失敗したらメールで知らせる。
 * 先方ごとに変える値は「設定」シートに置く（WitGas.settings）。データの形の移行は WitGas.migrate。
 *
 * 使う部品：src/ の version.js・lock.js・runlog.js・notify.js・guard.js・reconcile.js・handover.js・settings.js・migrate.js
 *
 * © 2026 wi-t.com Inc.
 */

/** この見本の版。変えたら CHANGELOG.md に書く。 */
var CSV_RECONCILE_VERSION = '1.0.0';

/** コードで決めている値（先方ごとには変えない）。先方ごとに変える値は CSV_RECONCILE_SETTINGS（設定シート）へ。 */
var CSV_RECONCILE = {
  name: 'CSV照合',                       // 実行記録・通知に出る処理名
  appName: 'CSV照合（csv-reconcile）',
  settingsSheet: '設定',
  schemaKey: 'csvReconcile',             // スキーマの版：スクリプトのプロパティ WitGas.schema:csvReconcile
  placeholderNotify: 'ops@example.com'   // 見本の通知先。このままなら「点検する」で知らせる
};

/** 「設定」シートの項目と既定の値。先方ごとに変えるのはシートの値で、ここは変えない。 */
var CSV_RECONCILE_SETTINGS = [
  { key: '会計のシート', value: '会計', required: true, note: '手元の表（1 行目が見出し）' },
  { key: 'CSV のシート', value: 'CSV貼り付け', required: true, note: 'CSV を取り込むシート（1 行目が見出し）' },
  { key: '照合結果のシート', value: '照合結果', required: true, note: '毎回書き直す' },
  { key: '実行記録のシート', value: '実行記録', required: true },
  { key: '呼び名（会計）', value: '会計', required: true, note: '照合結果に「会計だけ」のように出る' },
  { key: '呼び名（CSV）', value: '銀行', required: true },
  { key: 'キーの列', value: '請求番号', required: true, note: '会計の見出しの名前。複数ならカンマで区切る' },
  { key: '比べる列', value: '金額, 入金日', required: true, note: '会計の見出しの名前をカンマで区切る' },
  { key: '列の対応', value: '金額=入金額', note: '名前が違う列だけ「会計の列名=CSV の列名」をカンマで区切る' },
  { key: '数の列', value: '金額', note: '"1,000" と 1000 を同じにする列' },
  { key: '日付の列', value: '入金日', note: 'シートの日付と "2026/1/5" を同じ日にする列' },
  { key: '全角と半角を区別しない', value: true, type: 'boolean', note: 'はい／いいえ' },
  { key: '失敗の通知先', value: 'ops@example.com', type: 'email', required: true, note: '先方の担当のアドレスに変える' }
];

/** データの形の移行（WitGas.migrate）。段は何度動かしても結果が変わらない書き方にする。 */
var CSV_RECONCILE_STEPS = [
  {
    version: 1,
    name: '設定シートを用意する',
    run: function () {
      WitGas.settings.ensure({
        spreadsheet: SpreadsheetApp.getActiveSpreadsheet(),
        sheetName: CSV_RECONCILE.settingsSheet,
        items: CSV_RECONCILE_SETTINGS
      });
    }
  }
];

/** appsscript.json の oauthScopes と、使う理由（引き継ぎ書に出す。テストで appsscript.json と同じか確かめる） */
var CSV_RECONCILE_SCOPES = [
  { scope: 'https://www.googleapis.com/auth/spreadsheets.currentonly', reason: 'このスプレッドシートの設定・会計・CSV・照合結果・実行記録を読み書きする（ほかのスプレッドシートには触らない）' },
  { scope: 'https://www.googleapis.com/auth/script.container.ui', reason: 'メニューと知らせを出す' },
  { scope: 'https://www.googleapis.com/auth/script.send_mail', reason: '失敗をメールで知らせる' }
];

/** スプレッドシートを開いたときにメニューを足す（シンプルトリガー）。 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('照合')
    .addItem('照合する', 'runCsvReconcile')
    .addSeparator()
    .addItem('設定と表を用意する（版上げのときも）', 'migrateCsvReconcile')
    .addItem('点検する', 'checkCsvReconcile')
    .addItem('見本のデータを入れる', 'setupCsvReconcileSample')
    .addItem('引き継ぎ書を作る', 'writeCsvReconcileHandover')
    .addToUi();
}

/** 照合する（メニューから呼ぶ）。 */
function runCsvReconcile() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (WitGas.migrate.needed({ key: CSV_RECONCILE.schemaKey, steps: CSV_RECONCILE_STEPS })) {
    csvReconcileAlert_('設定がまだ用意されていません（版上げの途中かもしれません）。メニュー「照合 → 設定と表を用意する」を実行してから、もう一度実行してください。');
    return null;
  }
  var s = csvReconcileSettingsOrAlert_(ss);
  if (!s) return null;

  var left = csvReconcileReadTable_(ss, s.leftSheet);
  var right = csvReconcileReadTable_(ss, s.rightSheet);
  if (!left || !right) {
    // 入力がそろっていないのは、処理の失敗ではないので通知しない。画面で知らせて終わる。
    csvReconcileAlert_('「' + s.leftSheet + '」と「' + s.rightSheet + '」に、見出しのある表を入れてから実行してください。');
    return null;
  }

  var res;
  try {
    res = WitGas.guard(CSV_RECONCILE.name, function (ctx) {
      csvReconcileCheckColumns_(left, right, s);
      var r = WitGas.reconcile.compare(left, right, s.compare);
      WitGas.reconcile.writeReport(r, { spreadsheet: ss, sheetName: s.reportSheet, labels: s.labels });
      var text = WitGas.reconcile.summaryText(r, s.labels);
      ctx.setCount(r.summary.leftRows);
      ctx.setMessage(text);
      return text;
    }, {
      // 新しいスプレッドシートは、設定画面に「東京」と出ていても太平洋時間で保存されていることがある。
      // 実行記録を初めて作るときだけ、このスプレッドシートのタイムゾーンをスクリプトに合わせる（実機確認 W8）
      log: { spreadsheet: ss, sheetName: s.logSheet, matchTimeZone: true },
      notify: { to: s.notifyTo }
    });
  } catch (e) {
    // 実行記録と通知は guard が済ませている。見出しの間違いは、担当者に日本語で知らせて終わる。
    // それ以外の失敗は投げ直す（「実行数」画面に失敗として残り、詳しいエラーをそこで読める）。
    if (e && e.name === 'CsvFormatError') {
      csvReconcileAlert_(e.message);
      return { status: 'failure', errorType: e.name };
    }
    throw e;
  }

  if (res.status === 'success') {
    ss.toast(res.value, CSV_RECONCILE.name, 10);
  } else if (res.status === 'skipped') {
    ss.toast('ほかの照合が動いているため、今回は動かしませんでした。少し待ってからもう一度実行してください。', CSV_RECONCILE.name, 10);
  }
  return res;
}

/**
 * 設定と表を用意する（初めて入れたときと、版上げのときに動かす）。
 * まだ動いていない段だけを動かす。何度動かしても結果は変わらない。
 */
function migrateCsvReconcile() {
  var res = WitGas.guard(CSV_RECONCILE.name + '（用意）', function (ctx) {
    var r = WitGas.migrate.run({ key: CSV_RECONCILE.schemaKey, steps: CSV_RECONCILE_STEPS });
    ctx.setMessage('スキーマ ' + r.from + ' → ' + r.to);
    return r;
  }, { log: false, notify: false, rethrow: false });
  if (res.status === 'failure') {
    csvReconcileAlert_('設定の用意に失敗しました（' + res.errorType + '）。スプレッドシートのコピーに戻すか、実行数の画面でエラーを確かめてください。');
  } else if (res.status === 'success') {
    var r = res.value;
    csvReconcileAlert_(r.ran.length
      ? '設定を用意しました（スキーマの版 ' + r.from + ' → ' + r.to + '）。「設定」シートの値を確かめてください（特に「失敗の通知先」）。'
      : '設定は、もう用意されています（スキーマの版 ' + r.to + '）。');
  }
  return res;
}

/**
 * 点検する（版上げのあとや、困ったときに動かす）。直すことはしない。
 * @return {{ok: boolean, problems: string[]}}
 */
function checkCsvReconcile() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var problems = [];
  var current = WitGas.migrate.current(CSV_RECONCILE.schemaKey);
  var latest = CSV_RECONCILE_STEPS[CSV_RECONCILE_STEPS.length - 1].version;
  if (current !== latest) problems.push('スキーマの版が ' + current + ' です（この版のコードは ' + latest + '）。「設定と表を用意する」を実行してください。');
  var s = null;
  try {
    s = csvReconcileReadSettings_(ss);
  } catch (e) {
    problems.push(e && e.name === 'SettingsError' ? e.message : '設定を読めませんでした（' + (e && e.name) + '）。');
  }
  if (s) {
    if (s.notifyTo === CSV_RECONCILE.placeholderNotify) {
      problems.push('「失敗の通知先」が見本のまま（' + CSV_RECONCILE.placeholderNotify + '）です。先方の担当のアドレスに変えてください。');
    }
    var left = csvReconcileReadTable_(ss, s.leftSheet);
    var right = csvReconcileReadTable_(ss, s.rightSheet);
    if (!ss.getSheetByName(s.leftSheet)) problems.push('「' + s.leftSheet + '」シートがありません。');
    if (!ss.getSheetByName(s.rightSheet)) problems.push('「' + s.rightSheet + '」シートがありません。');
    if (left && right) {
      try {
        csvReconcileCheckColumns_(left, right, s);
      } catch (e) {
        problems.push(e.message);
      }
    }
  }
  var ok = problems.length === 0;
  csvReconcileAlert_(ok
    ? '点検：問題は見つかりませんでした（' + CSV_RECONCILE.appName + ' ' + CSV_RECONCILE_VERSION + '、スキーマの版 ' + current + '）。'
    : '点検：次のことを確かめてください。\n' + problems.map(function (p) { return '・' + p; }).join('\n'));
  return { ok: ok, problems: problems };
}

/**
 * 見本のデータ（架空）を入れる。試すとき・説明するときに使う。
 * 会計・CSV のシートにすでにデータがあるときは、消さずに止める。
 */
function setupCsvReconcileSample() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  WitGas.migrate.run({ key: CSV_RECONCILE.schemaKey, steps: CSV_RECONCILE_STEPS });
  var s = csvReconcileSettingsOrAlert_(ss);
  if (!s) return false;
  var used = [s.leftSheet, s.rightSheet].filter(function (name) {
    var sh = ss.getSheetByName(name);
    return sh && sh.getLastRow() > 0;
  });
  if (used.length > 0) {
    csvReconcileAlert_('「' + used.join('」「') + '」にデータがあるため、見本のデータは入れません。');
    return false;
  }

  var left = [
    ['請求番号', '取引先', '金額', '入金日'],
    ['INV-001', 'サンプル商店', 110000, new Date(2026, 0, 5)],
    ['INV-002', 'テスト工業', 55000, new Date(2026, 0, 6)],
    ['INV-003', '架空物産', 33000, new Date(2026, 0, 7)],
    ['INV-004', '見本建設', 220000, new Date(2026, 0, 8)],
    ['INV-005', '例示電機', 88000, new Date(2026, 0, 9)]
  ];
  // CSV を「テキストを数値、日付、数式に変換する」をオフにして取り込んだときの形（すべて文字）
  var right = [
    ['請求番号', '振込名義', '入金額', '入金日'],
    ['INV-001', 'ｻﾝﾌﾟﾙｼｮｳﾃﾝ', '110,000', '2026/1/5'],
    ['INV-002', 'ﾃｽﾄｺｳｷﾞｮｳ', '55,000', '2026/1/7'],
    ['INV-004', 'ﾐﾎﾝｹﾝｾﾂ', '200,000', '2026/1/8'],
    ['INV-005', 'ﾚｲｼﾞﾃﾞﾝｷ', '88,000', '2026/1/9'],
    ['INV-006', 'ﾌﾒｲ', '10,000', '2026/1/9']
  ];
  var ls = ss.getSheetByName(s.leftSheet) || ss.insertSheet(s.leftSheet);
  ls.getRange(1, 1, left.length, left[0].length).setValues(left);
  ls.getRange(2, 4, left.length - 1, 1).setNumberFormat('yyyy/mm/dd');

  var rs = ss.getSheetByName(s.rightSheet) || ss.insertSheet(s.rightSheet);
  var range = rs.getRange(1, 1, right.length, right[0].length);
  range.setNumberFormat('@'); // 文字のまま入れる（"110,000" を数に変えない）
  range.setValues(right);

  ss.toast('見本のデータを入れました。メニュー「照合 → 照合する」で試せます。', CSV_RECONCILE.name, 10);
  return true;
}

/** 引き継ぎ書を作る。 */
function writeCsvReconcileHandover() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var settings;
  try {
    var raw = WitGas.settings.read({ spreadsheet: ss, sheetName: CSV_RECONCILE.settingsSheet, items: CSV_RECONCILE_SETTINGS });
    settings = CSV_RECONCILE_SETTINGS.map(function (item) {
      return { name: '設定：' + item.key, value: raw[item.key], note: item.note || '' };
    });
  } catch (e) {
    settings = [{ name: '設定', value: '（読めなかった：' + (e && e.name) + '）', note: '「点検する」で確かめる' }];
  }
  return WitGas.handover.write({
    spreadsheet: ss,
    app: { name: CSV_RECONCILE.appName, version: CSV_RECONCILE_VERSION },
    scopes: CSV_RECONCILE_SCOPES,
    triggers: false, // トリガーを使わないので、一覧を読む権限（script.scriptapp）を持たない
    settings: settings.concat([
      { name: '設定の置き場所', value: '「' + CSV_RECONCILE.settingsSheet + '」シート', note: 'コードを入れ替えても消えない' }
    ]),
    stopSteps: [
      'この見本はトリガーを作らない。メニューから動かしたときだけ動く',
      'メニューを出さないようにするなら、main.js の onOpen を消す',
      '「照合結果」と「実行記録」のシートは、消してもかまわない（次に照合したときに作り直す）'
    ]
  });
}

// ---- 内部 ----

/** 設定シートを読み、照合に使う形にする。おかしければ SettingsError（項目名だけを書く） */
function csvReconcileReadSettings_(ss) {
  var sheetName = CSV_RECONCILE.settingsSheet;
  var v = WitGas.settings.read({ spreadsheet: ss, sheetName: sheetName, items: CSV_RECONCILE_SETTINGS });
  var list = function (key) {
    return String(v[key] || '').split(/[,、，]/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
  };
  var keys = list('キーの列');
  var columns = list('比べる列');
  if (keys.length === 0) throw csvReconcileSettingsError_('キーの列', 'が空です');
  if (columns.length === 0) throw csvReconcileSettingsError_('比べる列', 'が空です');
  var columnMap = {};
  list('列の対応').forEach(function (pair) {
    var m = /^(.+?)\s*[=＝→]\s*(.+)$/.exec(pair);
    if (!m) throw csvReconcileSettingsError_('列の対応', 'は「会計の列名=CSV の列名」をカンマで区切って書いてください');
    columnMap[m[1].trim()] = m[2].trim();
  });
  var used = keys.concat(columns);
  ['数の列', '日付の列'].forEach(function (k) {
    list(k).forEach(function (c) {
      if (used.indexOf(c) < 0) throw csvReconcileSettingsError_(k, 'には「キーの列」か「比べる列」にある列名を書いてください');
    });
  });
  var labels = { left: v['呼び名（会計）'], right: v['呼び名（CSV）'] };
  return {
    leftSheet: v['会計のシート'],
    rightSheet: v['CSV のシート'],
    reportSheet: v['照合結果のシート'],
    logSheet: v['実行記録のシート'],
    labels: labels,
    notifyTo: v['失敗の通知先'],
    compare: {
      key: keys.length === 1 ? keys[0] : keys,
      columns: columns,
      columnMap: columnMap,
      numberColumns: list('数の列'),
      dateColumns: list('日付の列'),
      width: v['全角と半角を区別しない'] === true
    }
  };
}

function csvReconcileSettingsError_(key, what) {
  var e = new Error('「' + CSV_RECONCILE.settingsSheet + '」シートの「' + key + '」' + what + '。');
  e.name = 'SettingsError';
  return e;
}

/** 設定を読む。設定の誤りは日本語で知らせて null（通知先も設定なので、メールでは知らせられない） */
function csvReconcileSettingsOrAlert_(ss) {
  try {
    return csvReconcileReadSettings_(ss);
  } catch (e) {
    if (e && e.name === 'SettingsError') {
      csvReconcileAlert_(e.message + '「設定」シートを直してから、もう一度実行してください。');
      return null;
    }
    throw e;
  }
}

/**
 * 照合に使う列が、両方の見出しにあるかを確かめる。なければ CsvFormatError を投げる。
 * メッセージには列名だけを書く（データの値は書かない）。
 */
function csvReconcileCheckColumns_(left, right, s) {
  var c = s.compare;
  var keys = typeof c.key === 'string' ? [c.key] : c.key;
  var leftNeeded = keys.concat(c.columns || []);
  var map = c.columnMap || {};
  var rightNeeded = leftNeeded.map(function (name) { return map.hasOwnProperty(name) ? map[name] : name; });
  var missing = function (table, names) {
    var header = table[0].map(function (h) { return h === null || h === undefined ? '' : String(h).trim(); });
    return names.filter(function (n) { return header.indexOf(n) < 0; });
  };
  var lines = [];
  var ml = missing(left, leftNeeded);
  var mr = missing(right, rightNeeded);
  if (ml.length > 0) {
    lines.push('「' + s.leftSheet + '」の見出し（1 行目）に「' + ml.join('」「') + '」がありません。');
  }
  if (mr.length > 0) {
    lines.push('「' + s.rightSheet + '」の見出し（1 行目）に「' + mr.join('」「') + '」がありません。' +
      'CSV の形式（1 行目の列名）を確かめてください。');
  }
  if (lines.length > 0) {
    var err = new Error(lines.join('\n'));
    err.name = 'CsvFormatError';
    throw err;
  }
}

/** シートの表を読む。シートがないか、見出しだけもないときは null。 */
function csvReconcileReadTable_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 1) return null;
  return sh.getDataRange().getValues();
}

/** 画面に知らせる。エディタやトリガーから動かしたとき（画面がない）はログに出す。 */
function csvReconcileAlert_(message) {
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (e) {
    console.log('[CSV照合] ' + message);
  }
}
