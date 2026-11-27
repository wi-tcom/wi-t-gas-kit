/**
 * 見本：帳票 PDF の一括作成
 *
 * 「明細」シートの 1 行を 1 枚の「お見積書」にして PDF を作り、スクリプトが作ったドライブのフォルダにまとめる。
 * 作った帳票は「作成記録」シートに残し、もう一度動かしても作成済みは飛ばす。
 * 件数が多いときは WitGas.resume で区切って続きを動かす。実行は WitGas.guard で包む。
 *
 * 使う部品：src/ の lock.js・resume.js・runlog.js・notify.js・guard.js・handover.js
 *
 * © 2026 wi-t.com Inc.
 */

/** 設定。引き継ぐときは、ここを見れば何をどう作っているか分かるようにしておく。 */
var PDF_BATCH = {
  name: '帳票PDF',                          // 実行記録・通知に出る処理名
  sourceSheet: '明細',
  recordSheet: '作成記録',
  logSheet: '実行記録',
  title: 'お見積書',                        // 帳票の題（「請求書」とは名乗らない）
  issuer: '見本商事株式会社（架空）',       // 発行元
  folderName: '見本 お見積書 PDF（wi-t-gas-kit）',
  folderProperty: 'PDF_BATCH_FOLDER_ID',    // 作ったフォルダの ID を置くスクリプトのプロパティ
  resumeKey: 'pdfBatch',
  budgetMs: 270000,                         // 1 回の実行で使う時間の上限（区切りを試すときは小さくする）
  columns: { number: '見積番号', to: '宛先', item: '品名', qty: '数量', price: '単価', date: '日付' },
  notifyTo: 'ops@example.com'               // 失敗を知らせる先。先方の担当のアドレスに変える
};

/** appsscript.json の oauthScopes と、使う理由（引き継ぎ書に出す。テストで appsscript.json と同じか確かめる） */
var PDF_BATCH_SCOPES = [
  { scope: 'https://www.googleapis.com/auth/spreadsheets.currentonly', reason: 'このスプレッドシートの明細・作成記録・実行記録を読み書きする' },
  { scope: 'https://www.googleapis.com/auth/drive.file', reason: 'PDF を置くフォルダと PDF を作る（このスクリプトが作ったものだけに触れる）' },
  { scope: 'https://www.googleapis.com/auth/script.scriptapp', reason: '件数が多いときの続きのトリガーを作る・消す。引き継ぎ書にトリガーを書く' },
  { scope: 'https://www.googleapis.com/auth/script.send_mail', reason: '失敗をメールで知らせる' },
  { scope: 'https://www.googleapis.com/auth/script.container.ui', reason: 'メニューと知らせを出す' }
];

/** スプレッドシートを開いたときにメニューを足す（シンプルトリガー）。 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('帳票')
    .addItem('PDF を作る', 'runPdfBatch')
    .addItem('作成を途中でやめる', 'stopPdfBatch')
    .addSeparator()
    .addItem('見本のデータを入れる', 'setupPdfBatchSample')
    .addItem('引き継ぎ書を作る', 'writePdfBatchHandover')
    .addToUi();
}

/**
 * PDF を作る（メニューから呼ぶ。続きのトリガーもこの関数を呼ぶ）。
 * 作成済みの見積番号は飛ばす。
 */
function runPdfBatch() {
  var cfg = PDF_BATCH;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var source = ss.getSheetByName(cfg.sourceSheet);
  if (!source || source.getLastRow() < 2) {
    // 入力がないのは、処理の失敗ではないので通知しない。
    pdfBatchAlert_('「' + cfg.sourceSheet + '」シートに、見出しと 1 行以上の明細を入れてから実行してください。');
    return null;
  }

  var counts = { created: 0, done: 0, blank: 0, invalid: 0 };
  var res;
  try {
    res = WitGas.guard(cfg.name, function (ctx) {
      var table = source.getDataRange().getValues();
      var col = pdfBatchColumns_(table[0], cfg);
      var rows = table.slice(1);
      var records = pdfBatchRecordSheet_(ss, cfg);
      var done = pdfBatchDoneNumbers_(records);
      var folder = pdfBatchFolder_(cfg);
      var tz = Session.getScriptTimeZone();

      var r = WitGas.resume.run({
        key: cfg.resumeKey,
        total: rows.length,
        handler: 'runPdfBatch',
        budgetMs: cfg.budgetMs,
        step: function (i) {
          var rec = pdfBatchRecord_(rows[i], col, tz);
          if (!rec.number) { counts.blank++; return; }
          if (done.hasOwnProperty(rec.number)) { counts.done++; return; }
          if (!rec.valid) { counts.invalid++; return; }
          var fileName = pdfBatchFileName_(cfg, rec.number);
          // 途中で止まって作成記録に書けなかったときのために、同じ名前のファイルがあれば作らずにそれを記録する（上書きしない）
          var existing = folder.getFilesByName(fileName);
          var file = existing.hasNext() ? existing.next() : folder.createFile(pdfBatchRender_(cfg, rec, fileName));
          records.appendRow([pdfBatchCell_(rec.number), new Date(), file.getId(), pdfBatchCell_(fileName)]);
          done[rec.number] = true;
          counts.created++;
        }
      });
      ctx.setCount(counts.created);
      ctx.setMessage('作成 ' + counts.created + '、作成済み ' + counts.done + '、番号なし ' + counts.blank +
        '、不備 ' + counts.invalid + '、cursor ' + r.cursor);
      return r;
    }, {
      log: { spreadsheet: ss, sheetName: cfg.logSheet, matchTimeZone: true },
      notify: { to: cfg.notifyTo }
    });
  } catch (e) {
    // 実行記録と通知は guard が済ませている。明細の見出しの間違いは、担当者に日本語で知らせて終わる。
    if (e && e.name === 'SheetFormatError') {
      pdfBatchAlert_(e.message);
      return { status: 'failure', errorType: e.name };
    }
    throw e;
  }

  var text = res.status === 'skipped'
    ? 'ほかの作成が動いているため、今回は動かしませんでした。少し待ってからもう一度実行してください。'
    : 'PDF を ' + counts.created + ' 件作りました（作成済みで飛ばした ' + counts.done + ' 件' +
      (counts.invalid ? '、数量・単価の不備で飛ばした ' + counts.invalid + ' 件' : '') + '）。' +
      (res.status === 'continued' ? '残りは続きで作ります。' : '');
  pdfBatchToast_(ss, text);
  return res;
}

/** 作成を途中でやめる（続きのトリガーと進み具合を消す。作った PDF と作成記録は残る）。 */
function stopPdfBatch() {
  var r = WitGas.resume.cleanup(PDF_BATCH.resumeKey);
  pdfBatchAlert_(r.deletedState
    ? '作成を止めました。作った PDF と作成記録は残っています。もう一度「PDF を作る」で、残りを作ります。'
    : '途中の作成はありませんでした。');
  return r;
}

/**
 * 見本のデータ（架空）を入れる。「明細」「作成記録」にデータがあるときは、消さずに止める。
 */
function setupPdfBatchSample() {
  var cfg = PDF_BATCH;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var used = [cfg.sourceSheet, cfg.recordSheet].filter(function (name) {
    var s = ss.getSheetByName(name);
    return s && s.getLastRow() > 0;
  });
  if (used.length > 0) {
    pdfBatchAlert_('「' + used.join('」「') + '」にデータがあるため、見本のデータは入れません。');
    return false;
  }
  var c = cfg.columns;
  var to = ['見本商店', 'テスト工業', '架空物産', '例示建設', 'サンプル電機', '仮名食品'];
  var items = ['ボールペン（黒）10 本', 'コピー用紙 Ａ４ 1 箱', 'ノート 5 冊', '付箋 20 個', 'ファイル 10 冊'];
  var rows = [[c.number, c.to, c.item, c.qty, c.price, c.date]];
  for (var i = 1; i <= 30; i++) {
    rows.push([
      'Q-' + ('000' + i).slice(-4),
      to[i % to.length] + '株式会社（架空）',
      items[i % items.length],
      (i % 5) + 1,
      [120, 3500, 800, 300, 1500][i % 5],
      new Date(2026, 11, 1 + (i % 20))
    ]);
  }
  var sheet = ss.getSheetByName(cfg.sourceSheet) || ss.insertSheet(cfg.sourceSheet);
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sheet.getRange(2, 6, rows.length - 1, 1).setNumberFormat('yyyy/mm/dd');
  pdfBatchRecordSheet_(ss, cfg);
  pdfBatchToast_(ss, '見本のデータを 30 件入れました。メニュー「帳票 → PDF を作る」で試せます。');
  return true;
}

/** 引き継ぎ書を作る。 */
function writePdfBatchHandover() {
  var cfg = PDF_BATCH;
  var folderId = PropertiesService.getScriptProperties().getProperty(cfg.folderProperty);
  return WitGas.handover.write({
    scopes: PDF_BATCH_SCOPES,
    settings: [
      { name: '処理名', value: cfg.name },
      { name: '帳票の題', value: cfg.title },
      { name: '発行元', value: cfg.issuer },
      { name: '明細のシート', value: cfg.sourceSheet, note: '1 行目が見出し。' + pdfBatchColumnNames_(cfg).join('・') },
      { name: '作成記録のシート', value: cfg.recordSheet, note: 'ここにある見積番号は作成済みとして飛ばす。行を消すと作り直す' },
      { name: '実行記録のシート', value: cfg.logSheet },
      { name: 'PDF のフォルダ', value: folderId || '（まだ作っていない）', note: 'スクリプト プロパティ ' + cfg.folderProperty },
      { name: '1 回の上限', value: cfg.budgetMs, note: 'ミリ秒。越える前に区切って続きを動かす' },
      { name: '失敗の通知先', value: cfg.notifyTo }
    ],
    stopSteps: [
      '作成の途中なら、メニュー「帳票 → 作成を途中でやめる」を実行する（続きのトリガーと進み具合が消える）',
      'トリガーの画面で、関数 runPdfBatch のトリガーが残っていないことを確かめる',
      'メニューを出さないようにするなら、main.js の onOpen を消す',
      '作った PDF は、ドライブのフォルダ「' + cfg.folderName + '」に残る。要らなければフォルダごと消す'
    ]
  });
}

// ---- 内部 ----

/** 明細の見出しから列の位置を引く。足りなければ SheetFormatError を投げる（列名だけを書く） */
function pdfBatchColumns_(header, cfg) {
  var names = header.map(function (h) { return h === null || h === undefined ? '' : String(h).trim(); });
  var col = {};
  var missing = [];
  Object.keys(cfg.columns).forEach(function (k) {
    var i = names.indexOf(cfg.columns[k]);
    if (i < 0) missing.push(cfg.columns[k]);
    col[k] = i;
  });
  if (missing.length > 0) {
    var err = new Error('「' + cfg.sourceSheet + '」の見出し（1 行目）に「' + missing.join('」「') + '」がありません。');
    err.name = 'SheetFormatError';
    throw err;
  }
  return col;
}

function pdfBatchColumnNames_(cfg) {
  return Object.keys(cfg.columns).map(function (k) { return cfg.columns[k]; });
}

/** 1 行を帳票の中身にする。数量・単価が数として読めなければ valid: false */
function pdfBatchRecord_(row, col, tz) {
  var num = function (v) {
    if (typeof v === 'number') return v;
    var t = String(v === null || v === undefined ? '' : v).replace(/[,，\s]/g, '').replace(/^[¥￥]/, '');
    return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
  };
  var qty = num(row[col.qty]);
  var price = num(row[col.price]);
  var date = row[col.date];
  var dateText = '';
  if (date && typeof date.getTime === 'function' && !isNaN(date.getTime())) {
    var p = Utilities.formatDate(date, tz, 'yyyy-MM-dd').split('-');
    dateText = p[0] + '年' + Number(p[1]) + '月' + Number(p[2]) + '日';
  } else if (date !== null && date !== undefined) {
    dateText = String(date);
  }
  return {
    number: String(row[col.number] === null || row[col.number] === undefined ? '' : row[col.number]).trim(),
    to: String(row[col.to] === null || row[col.to] === undefined ? '' : row[col.to]),
    item: String(row[col.item] === null || row[col.item] === undefined ? '' : row[col.item]),
    qty: qty,
    price: price,
    date: dateText,
    valid: isFinite(qty) && isFinite(price) && qty >= 0 && price >= 0
  };
}

/** 帳票を PDF の Blob にする（HTML から作る。P0 の結果で作り方を確定する） */
function pdfBatchRender_(cfg, rec, fileName) {
  var esc = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
  var yen = function (n) {
    var s = String(Math.round(n));
    return '¥' + s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };
  var amount = rec.qty * rec.price;
  var html = '<html><head><meta charset="utf-8"><style>' +
    'body{font-family:sans-serif;font-size:11pt;} h1{font-size:20pt;text-align:center;letter-spacing:0.5em;}' +
    'table{border-collapse:collapse;width:100%;margin:12pt 0;} th,td{border:1px solid #333;padding:4px 8px;} td.n{text-align:right;}' +
    '.meta{text-align:right;} .note{font-size:9pt;color:#555;}' +
    '</style></head><body>' +
    '<h1>' + esc(cfg.title) + '</h1>' +
    '<p class="meta">見積番号：' + esc(rec.number) + '<br>日付：' + esc(rec.date) + '</p>' +
    '<p>' + esc(rec.to) + ' 御中</p>' +
    '<p>下記のとおりお見積り申し上げます。</p>' +
    '<table><tr><th>品名</th><th>数量</th><th>単価</th><th>金額</th></tr>' +
    '<tr><td>' + esc(rec.item) + '</td><td class="n">' + esc(rec.qty) + '</td><td class="n">' + yen(rec.price) +
    '</td><td class="n">' + yen(amount) + '</td></tr></table>' +
    '<p>合計：' + yen(amount) + '</p>' +
    '<p class="meta">' + esc(cfg.issuer) + '</p>' +
    '<p class="note">これは wi-t-gas-kit の見本です。</p>' +
    '</body></html>';
  return Utilities.newBlob(html, 'text/html', fileName + '.html').getAs('application/pdf').setName(fileName);
}

/** ファイル名：「お見積書_Q-0001.pdf」。ファイル名に使えない字は「_」にする */
function pdfBatchFileName_(cfg, number) {
  return cfg.title + '_' + String(number).replace(/[\\/:*?"<>|\r\n\t]/g, '_') + '.pdf';
}

/** 作成記録のシート（なければ見出しをつけて作る） */
function pdfBatchRecordSheet_(ss, cfg) {
  var sheet = ss.getSheetByName(cfg.recordSheet) || ss.insertSheet(cfg.recordSheet);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 4).setValues([[cfg.columns.number, '作成日時', 'ファイル ID', 'ファイル名']]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** 作成記録にある見積番号 */
function pdfBatchDoneNumbers_(sheet) {
  var done = {};
  var last = sheet.getLastRow();
  if (last < 2) return done;
  sheet.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) {
    var n = String(r[0] === null || r[0] === undefined ? '' : r[0]).replace(/^'/, '').trim();
    if (n) done[n] = true;
  });
  return done;
}

/** PDF のフォルダ（スクリプトが作ったもの。なければ作って ID をスクリプトのプロパティに置く） */
function pdfBatchFolder_(cfg) {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(cfg.folderProperty);
  if (id) {
    try {
      var f = DriveApp.getFolderById(id);
      if (typeof f.isTrashed !== 'function' || !f.isTrashed()) return f;
    } catch (e) {
      // 消された・見えない。作り直す
    }
  }
  var folder = DriveApp.createFolder(cfg.folderName);
  props.setProperty(cfg.folderProperty, folder.getId());
  return folder;
}

/** セルに書く文字：式として読まれないようにする */
function pdfBatchCell_(s) {
  s = String(s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/** 画面に知らせる。トリガーやエディタから動かしたとき（画面がない）はログに出す。 */
function pdfBatchAlert_(message) {
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (e) {
    console.log('[帳票PDF] ' + message);
  }
}

function pdfBatchToast_(ss, message) {
  try {
    ss.toast(message, PDF_BATCH.name, 10);
  } catch (e) {
    console.log('[帳票PDF] ' + message);
  }
}
