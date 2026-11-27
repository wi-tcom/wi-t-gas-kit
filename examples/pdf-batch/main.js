/**
 * 見本：帳票 PDF の一括作成
 *
 * 「明細」シートの 1 行を 1 枚の「お見積書」にして PDF を作り、スクリプトが作ったドライブのフォルダにまとめる。
 * 作った帳票は「作成記録」シートに残し、もう一度動かしても作成済みは飛ばす。
 * 件数が多いときは WitGas.resume で区切って続きを動かす。実行は WitGas.guard で包む。
 * 先方ごとに変える値は「設定」シートに置く（WitGas.settings）。データの形の移行は WitGas.migrate。
 *
 * PDF は HTML から作り、Drive API（詳細サービス v3）で保存する。DriveApp は drive.file の権限では使えないため
 * （2026-11-27 の実機確認 P0）。drive.file では、このスクリプトが作ったフォルダとファイルにしか触れない。
 *
 * 使う部品：src/ の version.js・lock.js・resume.js・runlog.js・notify.js・guard.js・handover.js・settings.js・migrate.js
 *
 * © 2026 wi-t.com Inc.
 */

/** この見本の版。変えたら CHANGELOG.md に書く。 */
var PDF_BATCH_VERSION = '1.0.0';

/** コードで決めている値（先方ごとには変えない）。先方ごとに変える値は PDF_BATCH_SETTINGS（設定シート）へ。 */
var PDF_BATCH = {
  name: '帳票PDF',                          // 実行記録・通知に出る処理名
  appName: '帳票 PDF の一括作成（pdf-batch）',
  settingsSheet: '設定',
  schemaKey: 'pdfBatch',                    // スキーマの版：スクリプトのプロパティ WitGas.schema:pdfBatch
  resumeKey: 'pdfBatch',
  folderProperty: 'PDF_BATCH_FOLDER_ID'     // 作ったフォルダの ID を置くスクリプトのプロパティ
};

/** 「設定」シートの項目と既定の値。先方ごとに変えるのはシートの値で、ここは変えない。 */
var PDF_BATCH_SETTINGS = [
  { key: '明細のシート', value: '明細', required: true, note: '1 行が 1 枚の帳票になる表' },
  { key: '作成記録のシート', value: '作成記録', required: true, note: 'ここにある番号は作成済みとして飛ばす。行を消すと作り直す' },
  { key: '実行記録のシート', value: '実行記録', required: true },
  { key: '帳票の題', value: 'お見積書', required: true, note: '「請求書」とは名乗らない（税の要件は見本の範囲外）' },
  { key: '発行元', value: '見本商事株式会社（架空）', required: true },
  { key: 'PDF のフォルダ名', value: '見本 お見積書 PDF（wi-t-gas-kit）', required: true, note: 'スクリプトが作るフォルダの名前。作ったあとに変えても、作り直しはしない' },
  { key: '1 回の上限（ミリ秒）', value: 270000, type: 'number', required: true, note: '越える前に区切って続きを動かす。1〜360000' },
  { key: '失敗の通知先', value: 'ops@example.com', type: 'email', required: true, note: '先方の担当のアドレスに変える' },
  { key: '列：見積番号', value: '見積番号', required: true, note: '明細の見出しの名前' },
  { key: '列：宛先', value: '宛先', required: true },
  { key: '列：品名', value: '品名', required: true },
  { key: '列：数量', value: '数量', required: true },
  { key: '列：単価', value: '単価', required: true },
  { key: '列：日付', value: '日付', required: true }
];

/** データの形の移行（WitGas.migrate）。段は何度動かしても結果が変わらない書き方にする。 */
var PDF_BATCH_STEPS = [
  {
    version: 1,
    name: '設定シートと作成記録を用意する',
    run: function () {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      WitGas.settings.ensure({ spreadsheet: ss, sheetName: PDF_BATCH.settingsSheet, items: PDF_BATCH_SETTINGS });
      var s = pdfBatchReadSettings_(ss);
      pdfBatchRecordSheet_(ss, s);
    }
  }
];

/** appsscript.json の oauthScopes と、使う理由（引き継ぎ書に出す。テストで appsscript.json と同じか確かめる） */
var PDF_BATCH_SCOPES = [
  { scope: 'https://www.googleapis.com/auth/spreadsheets.currentonly', reason: 'このスプレッドシートの設定・明細・作成記録・実行記録を読み書きする' },
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
    .addItem('設定と表を用意する（版上げのときも）', 'migratePdfBatch')
    .addItem('点検する', 'checkPdfBatch')
    .addItem('見本のデータを入れる', 'setupPdfBatchSample')
    .addItem('引き継ぎ書を作る', 'writePdfBatchHandover')
    .addToUi();
}

/**
 * PDF を作る（メニューから呼ぶ。続きのトリガーもこの関数を呼ぶ）。
 * 作成済みの見積番号は飛ばす。
 */
function runPdfBatch() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (WitGas.migrate.needed({ key: PDF_BATCH.schemaKey, steps: PDF_BATCH_STEPS })) {
    pdfBatchAlert_('設定と表がまだ用意されていません（版上げの途中かもしれません）。メニュー「帳票 → 設定と表を用意する」を実行してから、もう一度実行してください。');
    return null;
  }
  var s = pdfBatchSettingsOrAlert_(ss);
  if (!s) return null;
  var source = ss.getSheetByName(s['明細のシート']);
  if (!source || source.getLastRow() < 2) {
    // 入力がないのは、処理の失敗ではないので通知しない。
    pdfBatchAlert_('「' + s['明細のシート'] + '」シートに、見出しと 1 行以上の明細を入れてから実行してください。');
    return null;
  }

  var counts = { created: 0, done: 0, blank: 0, invalid: 0 };
  var res;
  try {
    res = WitGas.guard(PDF_BATCH.name, function (ctx) {
      var table = source.getDataRange().getValues();
      var col = pdfBatchColumns_(table[0], s);
      var rows = table.slice(1);
      var records = pdfBatchRecordSheet_(ss, s);
      var done = pdfBatchDoneNumbers_(records);
      var folderId = pdfBatchFolder_(s);
      var tz = Session.getScriptTimeZone();

      var r = WitGas.resume.run({
        key: PDF_BATCH.resumeKey,
        total: rows.length,
        handler: 'runPdfBatch',
        budgetMs: s['1 回の上限（ミリ秒）'],
        step: function (i) {
          var rec = pdfBatchRecord_(rows[i], col, tz);
          if (!rec.number) { counts.blank++; return; }
          if (done.hasOwnProperty(rec.number)) { counts.done++; return; }
          if (!rec.valid) { counts.invalid++; return; }
          var fileName = pdfBatchFileName_(s, rec.number);
          // 途中で止まって作成記録に書けなかったときのために、同じ名前のファイルがあれば作らずにそれを記録する（上書きしない）
          var fileId = pdfBatchFindFile_(folderId, fileName);
          if (!fileId) {
            fileId = Drive.Files.create(
              { name: fileName, parents: [folderId], mimeType: 'application/pdf' },
              pdfBatchRender_(s, rec, fileName)
            ).id;
          }
          records.appendRow([pdfBatchCell_(rec.number), new Date(), fileId, pdfBatchCell_(fileName)]);
          done[rec.number] = true;
          counts.created++;
        }
      });
      ctx.setCount(counts.created);
      ctx.setMessage('作成 ' + counts.created + '、作成済み ' + counts.done + '、番号なし ' + counts.blank +
        '、不備 ' + counts.invalid + '、cursor ' + r.cursor);
      return r;
    }, {
      log: { spreadsheet: ss, sheetName: s['実行記録のシート'], matchTimeZone: true },
      notify: { to: s['失敗の通知先'] }
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
 * 設定と表を用意する（初めて入れたときと、版上げのときに動かす）。
 * まだ動いていない段だけを動かす。何度動かしても結果は変わらない。
 */
function migratePdfBatch() {
  var res = WitGas.guard(PDF_BATCH.name + '（用意）', function (ctx) {
    var r = WitGas.migrate.run({ key: PDF_BATCH.schemaKey, steps: PDF_BATCH_STEPS });
    ctx.setMessage('スキーマ ' + r.from + ' → ' + r.to);
    return r;
  }, { log: false, notify: false, rethrow: false });
  if (res.status === 'failure') {
    pdfBatchAlert_('設定と表の用意に失敗しました（' + res.errorType + '）。スプレッドシートのコピーに戻すか、実行数の画面でエラーを確かめてください。');
  } else if (res.status === 'success') {
    var r = res.value;
    pdfBatchAlert_(r.ran.length
      ? '設定と表を用意しました（スキーマの版 ' + r.from + ' → ' + r.to + '）。「設定」シートの値を確かめてください。'
      : '設定と表は、もう用意されています（スキーマの版 ' + r.to + '）。');
  }
  return res;
}

/**
 * 点検する（版上げのあとや、困ったときに動かす）。直すことはしない。
 * @return {{ok: boolean, problems: string[]}}
 */
function checkPdfBatch() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var problems = [];
  var current = WitGas.migrate.current(PDF_BATCH.schemaKey);
  var latest = PDF_BATCH_STEPS[PDF_BATCH_STEPS.length - 1].version;
  if (current !== latest) problems.push('スキーマの版が ' + current + ' です（この版のコードは ' + latest + '）。「設定と表を用意する」を実行してください。');
  var s = null;
  try {
    s = pdfBatchReadSettings_(ss);
  } catch (e) {
    problems.push(e && e.name === 'SettingsError' ? e.message : '設定を読めませんでした（' + (e && e.name) + '）。');
  }
  if (s) {
    var source = ss.getSheetByName(s['明細のシート']);
    if (!source) {
      problems.push('「' + s['明細のシート'] + '」シートがありません。');
    } else if (source.getLastRow() > 0) {
      try {
        pdfBatchColumns_(source.getRange(1, 1, 1, Math.max(1, source.getLastColumn())).getValues()[0], s);
      } catch (e) {
        problems.push(e.message);
      }
    }
    if (!ss.getSheetByName(s['作成記録のシート'])) problems.push('「' + s['作成記録のシート'] + '」シートがありません。');
  }
  var ok = problems.length === 0;
  pdfBatchAlert_(ok
    ? '点検：問題は見つかりませんでした（' + PDF_BATCH.appName + ' ' + PDF_BATCH_VERSION + '、スキーマの版 ' + current + '）。'
    : '点検：次のことを確かめてください。\n' + problems.map(function (p) { return '・' + p; }).join('\n'));
  return { ok: ok, problems: problems };
}

/**
 * 見本のデータ（架空）を入れる。明細・作成記録にデータがあるときは、消さずに止める。
 */
function setupPdfBatchSample() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  WitGas.migrate.run({ key: PDF_BATCH.schemaKey, steps: PDF_BATCH_STEPS });
  var s = pdfBatchSettingsOrAlert_(ss);
  if (!s) return false;
  var source = ss.getSheetByName(s['明細のシート']);
  var records = ss.getSheetByName(s['作成記録のシート']);
  var used = [];
  if (source && source.getLastRow() > 0) used.push(s['明細のシート']);
  if (records && records.getLastRow() > 1) used.push(s['作成記録のシート']);
  if (used.length > 0) {
    pdfBatchAlert_('「' + used.join('」「') + '」にデータがあるため、見本のデータは入れません。');
    return false;
  }
  var to = ['見本商店', 'テスト工業', '架空物産', '例示建設', 'サンプル電機', '仮名食品'];
  var items = ['ボールペン（黒）10 本', 'コピー用紙 Ａ４ 1 箱', 'ノート 5 冊', '付箋 20 個', 'ファイル 10 冊'];
  var rows = [[s['列：見積番号'], s['列：宛先'], s['列：品名'], s['列：数量'], s['列：単価'], s['列：日付']]];
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
  source = source || ss.insertSheet(s['明細のシート']);
  source.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  source.getRange(2, 6, rows.length - 1, 1).setNumberFormat('yyyy/mm/dd');
  pdfBatchToast_(ss, '見本のデータを 30 件入れました。メニュー「帳票 → PDF を作る」で試せます。');
  return true;
}

/** 引き継ぎ書を作る。 */
function writePdfBatchHandover() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var folderId = PropertiesService.getScriptProperties().getProperty(PDF_BATCH.folderProperty);
  var settings = [];
  try {
    var s = pdfBatchReadSettings_(ss);
    settings = PDF_BATCH_SETTINGS.map(function (item) {
      return { name: '設定：' + item.key, value: s[item.key], note: item.note || '' };
    });
  } catch (e) {
    settings = [{ name: '設定', value: '（読めなかった：' + (e && e.name) + '）', note: '「点検する」で確かめる' }];
  }
  return WitGas.handover.write({
    spreadsheet: ss,
    app: { name: PDF_BATCH.appName, version: PDF_BATCH_VERSION },
    scopes: PDF_BATCH_SCOPES,
    settings: settings.concat([
      { name: '設定の置き場所', value: '「' + PDF_BATCH.settingsSheet + '」シート', note: 'コードを入れ替えても消えない' },
      { name: 'PDF のフォルダ', value: folderId || '（まだ作っていない）', note: 'スクリプト プロパティ ' + PDF_BATCH.folderProperty }
    ]),
    stopSteps: [
      '作成の途中なら、メニュー「帳票 → 作成を途中でやめる」を実行する（続きのトリガーと進み具合が消える）',
      'トリガーの画面で、関数 runPdfBatch のトリガーが残っていないことを確かめる',
      'メニューを出さないようにするなら、main.js の onOpen を消す',
      '作った PDF は、ドライブのフォルダ（上の「PDF のフォルダ」）に残る。要らなければフォルダごと消す'
    ]
  });
}

// ---- 内部 ----

function pdfBatchReadSettings_(ss) {
  var s = WitGas.settings.read({ spreadsheet: ss, sheetName: PDF_BATCH.settingsSheet, items: PDF_BATCH_SETTINGS });
  var budget = s['1 回の上限（ミリ秒）'];
  if (Math.floor(budget) !== budget || budget < 1 || budget > 360000) {
    var e = new Error('「' + PDF_BATCH.settingsSheet + '」シートの「1 回の上限（ミリ秒）」は 1〜360000 の整数にしてください。');
    e.name = 'SettingsError';
    throw e;
  }
  return s;
}

/** 設定を読む。設定の誤りは日本語で知らせて null（通知先も設定なので、メールでは知らせられない） */
function pdfBatchSettingsOrAlert_(ss) {
  try {
    return pdfBatchReadSettings_(ss);
  } catch (e) {
    if (e && e.name === 'SettingsError') {
      pdfBatchAlert_(e.message + '「設定」シートを直してから、もう一度実行してください。');
      return null;
    }
    throw e;
  }
}

/** 明細の見出しから列の位置を引く。足りなければ SheetFormatError を投げる（列名だけを書く） */
function pdfBatchColumns_(header, s) {
  var names = header.map(function (h) { return h === null || h === undefined ? '' : String(h).trim(); });
  var keys = { number: '列：見積番号', to: '列：宛先', item: '列：品名', qty: '列：数量', price: '列：単価', date: '列：日付' };
  var col = {};
  var missing = [];
  Object.keys(keys).forEach(function (k) {
    var i = names.indexOf(s[keys[k]]);
    if (i < 0) missing.push(s[keys[k]]);
    col[k] = i;
  });
  if (missing.length > 0) {
    var err = new Error('「' + s['明細のシート'] + '」の見出し（1 行目）に「' + missing.join('」「') + '」がありません。');
    err.name = 'SheetFormatError';
    throw err;
  }
  return col;
}

/** 1 行を帳票の中身にする。数量・単価が数として読めなければ valid: false */
function pdfBatchRecord_(row, col, tz) {
  var text = function (v) { return String(v === null || v === undefined ? '' : v); };
  var num = function (v) {
    if (typeof v === 'number') return v;
    var t = text(v).replace(/[,，\s]/g, '').replace(/^[¥￥]/, '');
    return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
  };
  var qty = num(row[col.qty]);
  var price = num(row[col.price]);
  var date = row[col.date];
  var dateText = '';
  if (date && typeof date.getTime === 'function' && !isNaN(date.getTime())) {
    var p = Utilities.formatDate(date, tz, 'yyyy-MM-dd').split('-');
    dateText = p[0] + '年' + Number(p[1]) + '月' + Number(p[2]) + '日';
  } else {
    dateText = text(date);
  }
  return {
    number: text(row[col.number]).trim(),
    to: text(row[col.to]),
    item: text(row[col.item]),
    qty: qty,
    price: price,
    date: dateText,
    valid: isFinite(qty) && isFinite(price) && qty >= 0 && price >= 0
  };
}

/** 帳票を PDF の Blob にする（HTML から作る。P0 の結果で作り方を確定する） */
function pdfBatchRender_(s, rec, fileName) {
  var esc = function (v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
  var yen = function (n) {
    return '¥' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };
  var amount = rec.qty * rec.price;
  var html = '<html><head><meta charset="utf-8"><style>' +
    'body{font-family:sans-serif;font-size:11pt;} h1{font-size:20pt;text-align:center;letter-spacing:0.5em;}' +
    'table{border-collapse:collapse;width:100%;margin:12pt 0;} th,td{border:1px solid #333;padding:4px 8px;} td.n{text-align:right;}' +
    '.meta{text-align:right;} .note{font-size:9pt;color:#555;}' +
    '</style></head><body>' +
    '<h1>' + esc(s['帳票の題']) + '</h1>' +
    '<p class="meta">見積番号：' + esc(rec.number) + '<br>日付：' + esc(rec.date) + '</p>' +
    '<p>' + esc(rec.to) + ' 御中</p>' +
    '<p>下記のとおりお見積り申し上げます。</p>' +
    '<table><tr><th>品名</th><th>数量</th><th>単価</th><th>金額</th></tr>' +
    '<tr><td>' + esc(rec.item) + '</td><td class="n">' + esc(rec.qty) + '</td><td class="n">' + yen(rec.price) +
    '</td><td class="n">' + yen(amount) + '</td></tr></table>' +
    '<p>合計：' + yen(amount) + '</p>' +
    '<p class="meta">' + esc(s['発行元']) + '</p>' +
    '<p class="note">これは wi-t-gas-kit の見本です。</p>' +
    '</body></html>';
  return Utilities.newBlob(html, 'text/html', fileName + '.html').getAs('application/pdf').setName(fileName);
}

/** ファイル名：「お見積書_Q-0001.pdf」。ファイル名に使えない字は「_」にする */
function pdfBatchFileName_(s, number) {
  return s['帳票の題'] + '_' + String(number).replace(/[\\/:*?"<>|\r\n\t]/g, '_') + '.pdf';
}

/** 作成記録のシート（なければ見出しをつけて作る） */
function pdfBatchRecordSheet_(ss, s) {
  var name = s['作成記録のシート'];
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 4).setValues([[s['列：見積番号'], '作成日時', 'ファイル ID', 'ファイル名']]);
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

/**
 * PDF のフォルダの ID（スクリプトが作ったもの。なければ作って ID をスクリプトのプロパティに置く）。
 * ゴミ箱に入っている・見えないときは作り直す。
 */
function pdfBatchFolder_(s) {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PDF_BATCH.folderProperty);
  if (id) {
    try {
      var f = Drive.Files.get(id, { fields: 'id,trashed' });
      if (f && !f.trashed) return f.id;
    } catch (e) {
      // 消された・見えない。作り直す
    }
  }
  var folder = Drive.Files.create({ name: s['PDF のフォルダ名'], mimeType: 'application/vnd.google-apps.folder' });
  props.setProperty(PDF_BATCH.folderProperty, folder.id);
  return folder.id;
}

/** フォルダの中に、同じ名前のファイル（ゴミ箱を除く）があれば、その ID */
function pdfBatchFindFile_(folderId, name) {
  var q = "name = '" + pdfBatchQuote_(name) + "' and '" + pdfBatchQuote_(folderId) + "' in parents and trashed = false";
  var files = Drive.Files.list({ q: q, fields: 'files(id,name)' }).files || [];
  return files.length ? files[0].id : null;
}

/** Drive API の検索の文字の中で、\ と ' を逃がす */
function pdfBatchQuote_(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** セルに書く文字：式として読まれないようにする */
function pdfBatchCell_(v) {
  var t = String(v);
  return /^[=+\-@]/.test(t) ? "'" + t : t;
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
