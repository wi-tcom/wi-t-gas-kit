/**
 * 見本：CSV照合
 *
 * 「会計」シートの表と、「CSV貼り付け」シートに取り込んだ CSV（銀行の入金明細など）を
 * 請求番号で突き合わせ、「照合結果」シートに一致・不一致・片方だけ を出す。
 * 実行は WitGas.guard で包み、「実行記録」シートに件数を残し、失敗したらメールで知らせる。
 *
 * 使う部品：src/ の lock.js・runlog.js・notify.js・guard.js・reconcile.js
 *
 * © 2026 wi-t.com Inc.
 */

/** 設定。引き継ぐときは、ここを見れば何をどう照合しているか分かるようにしておく。 */
var CSV_RECONCILE = {
  name: 'CSV照合',                       // 実行記録・通知に出る処理名
  leftSheet: '会計',                     // 手元の表
  rightSheet: 'CSV貼り付け',             // CSV を取り込むシート
  reportSheet: '照合結果',
  logSheet: '実行記録',
  labels: { left: '会計', right: '銀行' },
  compare: {
    key: '請求番号',
    columns: ['金額', '入金日'],          // 比べる列（会計シートの列名）
    columnMap: { '金額': '入金額' },      // 列名が違う列：会計 → CSV
    numberColumns: ['金額'],
    dateColumns: ['入金日'],
    width: true
  },
  notifyTo: 'ops@example.com'            // 失敗を知らせる先。先方の担当のアドレスに変える
};

/** スプレッドシートを開いたときにメニューを足す（シンプルトリガー）。 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('照合')
    .addItem('照合する', 'runCsvReconcile')
    .addSeparator()
    .addItem('見本のデータを入れる', 'setupCsvReconcileSample')
    .addToUi();
}

/** 照合する（メニューから呼ぶ）。 */
function runCsvReconcile() {
  var cfg = CSV_RECONCILE;
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var left = csvReconcileReadTable_(ss, cfg.leftSheet);
  var right = csvReconcileReadTable_(ss, cfg.rightSheet);
  if (!left || !right) {
    // 入力がそろっていないのは、処理の失敗ではないので通知しない。画面で知らせて終わる。
    csvReconcileAlert_('「' + cfg.leftSheet + '」と「' + cfg.rightSheet + '」に、見出しのある表を入れてから実行してください。');
    return null;
  }

  var res;
  try {
    res = WitGas.guard(cfg.name, function (ctx) {
      csvReconcileCheckColumns_(left, right, cfg);
      var r = WitGas.reconcile.compare(left, right, cfg.compare);
      WitGas.reconcile.writeReport(r, { spreadsheet: ss, sheetName: cfg.reportSheet, labels: cfg.labels });
      var text = WitGas.reconcile.summaryText(r, cfg.labels);
      ctx.setCount(r.summary.leftRows);
      ctx.setMessage(text);
      return text;
    }, {
      // 新しいスプレッドシートは、設定画面に「東京」と出ていても太平洋時間で保存されていることがある。
      // 実行記録を初めて作るときだけ、このスプレッドシートのタイムゾーンをスクリプトに合わせる（実機確認 W8）
      log: { spreadsheet: ss, sheetName: cfg.logSheet, matchTimeZone: true },
      notify: { to: cfg.notifyTo }
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
    ss.toast(res.value, cfg.name, 10);
  } else if (res.status === 'skipped') {
    ss.toast('ほかの照合が動いているため、今回は動かしませんでした。少し待ってからもう一度実行してください。', cfg.name, 10);
  }
  return res;
}

/**
 * 見本のデータ（架空）を入れる。試すとき・説明するときに使う。
 * 「会計」「CSV貼り付け」にすでにデータがあるときは、消さずに止める。
 */
function setupCsvReconcileSample() {
  var cfg = CSV_RECONCILE;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var used = [cfg.leftSheet, cfg.rightSheet].filter(function (name) {
    var s = ss.getSheetByName(name);
    return s && s.getLastRow() > 0;
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
  var ls = ss.getSheetByName(cfg.leftSheet) || ss.insertSheet(cfg.leftSheet);
  ls.getRange(1, 1, left.length, left[0].length).setValues(left);
  ls.getRange(2, 4, left.length - 1, 1).setNumberFormat('yyyy/mm/dd');

  var rs = ss.getSheetByName(cfg.rightSheet) || ss.insertSheet(cfg.rightSheet);
  var range = rs.getRange(1, 1, right.length, right[0].length);
  range.setNumberFormat('@'); // 文字のまま入れる（"110,000" を数に変えない）
  range.setValues(right);

  ss.toast('見本のデータを入れました。メニュー「照合 → 照合する」で試せます。', cfg.name, 10);
  return true;
}

/**
 * 照合に使う列が、両方の見出しにあるかを確かめる。なければ CsvFormatError を投げる。
 * メッセージには列名だけを書く（データの値は書かない）。
 */
function csvReconcileCheckColumns_(left, right, cfg) {
  var c = cfg.compare;
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
    lines.push('「' + cfg.leftSheet + '」の見出し（1 行目）に「' + ml.join('」「') + '」がありません。');
  }
  if (mr.length > 0) {
    lines.push('「' + cfg.rightSheet + '」の見出し（1 行目）に「' + mr.join('」「') + '」がありません。' +
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
  var s = ss.getSheetByName(name);
  if (!s || s.getLastRow() < 1) return null;
  return s.getDataRange().getValues();
}

/** 画面に知らせる。エディタやトリガーから動かしたとき（画面がない）はログに出す。 */
function csvReconcileAlert_(message) {
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (e) {
    console.log('[CSV照合] ' + message);
  }
}
