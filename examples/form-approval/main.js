/**
 * 見本：フォーム → 承認 → 通知
 *
 * Google フォームの回答（回答のシート）を 10 分ごとに「承認」シートへ取り込み、承認者に件数を知らせる。
 * 承認者が「承認」シートの「判断」に「承認」か「差し戻し」を選ぶと、次の回に申請者へメールで結果を知らせる。
 * 実行は WitGas.guard で包む（二重に動かない・実行記録・失敗の通知）。
 * 先方ごとに変える値は「設定」シートに置く（WitGas.settings）。データの形の移行は WitGas.migrate。
 *
 * - フォームそのものは読まない（フォームの権限を持たない）。読むのは、フォームがつながった回答のシートだけ。
 * - 申請者のメールアドレスは、フォームの「メールアドレスを収集する」で集めた列から読む。
 * - 判断の取り込みは時間主導型のトリガー（10 分ごと）。編集のたびに動くトリガー（onEdit）は使わない。
 *
 * 使う部品：src/ の version.js・lock.js・runlog.js・notify.js・guard.js・handover.js・settings.js・migrate.js
 *
 * © 2026 wi-t.com Inc.
 */

/** この見本の版。変えたら CHANGELOG.md に書く。 */
var FORM_APPROVAL_VERSION = '1.0.0';

/** コードで決めている値（先方ごとには変えない）。先方ごとに変える値は FORM_APPROVAL_SETTINGS（設定シート）へ。 */
var FORM_APPROVAL = {
  name: '申請の承認',                       // 実行記録・通知に出る処理名
  appName: 'フォーム → 承認 → 通知（form-approval）',
  settingsSheet: '設定',
  schemaKey: 'formApproval',                // スキーマの版：スクリプトのプロパティ WitGas.schema:formApproval
  handler: 'runFormApproval',               // 定時に動かす関数
  everyMinutes: 10,
  budgetMs: 270000,                         // 1 回の実行で、知らせるのをやめる時間（4.5 分）
  placeholders: ['ops@example.com', 'approver@example.com'],
  judgments: ['承認', '差し戻し'],
  // 「承認」シートの見出し（この順で作る。読むときは名前で探す）
  columns: ['申請番号', '受付日時', '申請者', '判断', 'コメント', '状態', '知らせた日時', '回答の行'],
  states: {
    waiting: '未判断',
    sending: '送信中',
    approved: '知らせた（承認）',
    returned: '知らせた（差し戻し）',
    noAddress: '宛先なし（知らせていない）'
  }
};

/** 「設定」シートの項目と既定の値。先方ごとに変えるのはシートの値で、ここは変えない。 */
var FORM_APPROVAL_SETTINGS = [
  { key: '回答のシート', value: 'フォームの回答 1', required: true, note: 'フォームの回答がたまるシート（フォームの「回答」→「スプレッドシートにリンク」で作られる）' },
  { key: '承認のシート', value: '承認', required: true, note: '承認者が判断を選ぶシート' },
  { key: '実行記録のシート', value: '実行記録', required: true },
  { key: '列：タイムスタンプ', value: 'タイムスタンプ', required: true, note: '回答のシートの見出しの名前' },
  { key: '列：メールアドレス', value: 'メールアドレス', required: true, note: 'フォームの「メールアドレスを収集する」で集めた列' },
  { key: '写す列', value: '件名, 金額', note: '承認のシートに写す、回答のシートの見出し（カンマで区切る）' },
  { key: '申請番号の頭', value: 'A-', required: true, note: '申請番号は「A-0001」のように振る' },
  { key: '承認者の通知先', value: 'approver@example.com', type: 'email', required: true, note: '新しい申請の件数を知らせる。複数ならカンマで区切る' },
  { key: '失敗の通知先', value: 'ops@example.com', type: 'email', required: true, note: '先方の担当のアドレスに変える' },
  { key: '件名の頭', value: '[申請]', required: true },
  { key: '送り主の名前', value: '申請の受付', required: true, note: '申請者に届くメールの差出人の名前' },
  { key: '返信先', value: '', type: 'email', note: '申請者が返信したときの宛先。空なら、このスクリプトを動かす人' },
  { key: '承認のメールの文', value: '申請 {申請番号}（{受付日時} 受付）は承認されました。\n\nコメント：{コメント}\n\n※このメールは自動で送っています。', required: true, note: '{申請番号}・{受付日時}・{結果}・{コメント} が差し込まれる' },
  { key: '差し戻しのメールの文', value: '申請 {申請番号}（{受付日時} 受付）は差し戻しになりました。\n\n理由：{コメント}\n\n直したうえで、もう一度フォームから申請してください。\n※このメールは自動で送っています。', required: true },
  { key: '1 回に知らせる上限', value: 50, type: 'number', required: true, note: '1 回の実行で申請者に送るメールの数（1〜100）。残りは次の回' }
];

/** データの形の移行（WitGas.migrate）。段は何度動かしても結果が変わらない書き方にする。 */
var FORM_APPROVAL_STEPS = [
  {
    version: 1,
    name: '設定シートと承認のシートを用意する',
    run: function () {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      WitGas.settings.ensure({ spreadsheet: ss, sheetName: FORM_APPROVAL.settingsSheet, items: FORM_APPROVAL_SETTINGS });
      formApprovalLedger_(ss, formApprovalReadSettings_(ss));
    }
  }
];

/** appsscript.json の oauthScopes と、使う理由（引き継ぎ書に出す。テストで appsscript.json と同じか確かめる） */
var FORM_APPROVAL_SCOPES = [
  { scope: 'https://www.googleapis.com/auth/spreadsheets.currentonly', reason: 'このスプレッドシートの回答・承認・設定・実行記録を読み書きする' },
  { scope: 'https://www.googleapis.com/auth/script.scriptapp', reason: '10 分ごとのトリガーを作る・消す。引き継ぎ書にトリガーを書く' },
  { scope: 'https://www.googleapis.com/auth/script.send_mail', reason: '承認者と申請者に知らせる。失敗を知らせる' },
  { scope: 'https://www.googleapis.com/auth/script.container.ui', reason: 'メニューと知らせを出す' }
];

/** スプレッドシートを開いたときにメニューを足す（シンプルトリガー）。 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('申請')
    .addItem('今すぐ取り込む・知らせる', 'runFormApproval')
    .addSeparator()
    .addItem('定時の動きを始める（10 分ごと）', 'startFormApproval')
    .addItem('定時の動きを止める', 'stopFormApproval')
    .addSeparator()
    .addItem('設定と表を用意する（版上げのときも）', 'migrateFormApproval')
    .addItem('点検する', 'checkFormApproval')
    .addItem('見本のデータを入れる', 'setupFormApprovalSample')
    .addItem('引き継ぎ書を作る', 'writeFormApprovalHandover')
    .addToUi();
}

/**
 * 取り込む・知らせる（メニューから呼ぶ。10 分ごとのトリガーもこの関数を呼ぶ）。
 * 1. 回答のシートの新しい回答を「承認」シートに足し、承認者に件数を知らせる。
 * 2. 「判断」が選ばれた行の申請者に、結果を知らせる。
 */
function runFormApproval() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (WitGas.migrate.needed({ key: FORM_APPROVAL.schemaKey, steps: FORM_APPROVAL_STEPS })) {
    formApprovalAlert_('設定と表がまだ用意されていません（版上げの途中かもしれません）。メニュー「申請 → 設定と表を用意する」を実行してから、もう一度実行してください。');
    return null;
  }
  var s = formApprovalSettingsOrTell_(ss);
  if (!s) return null;

  var c = { imported: 0, sent: 0, noAddress: 0, left: 0, sending: 0 };
  var res;
  try {
    res = WitGas.guard(FORM_APPROVAL.name, function (ctx) {
      var startedAt = new Date().getTime();
      var answers = formApprovalReadAnswers_(ss, s);
      var ledger = formApprovalLedger_(ss, s);

      // 1. 取り込む
      var fresh = formApprovalNewAnswers_(answers, ledger);
      if (fresh.length > 0) {
        formApprovalAppend_(ledger, s, answers, fresh);
        c.imported = fresh.length;
        formApprovalTellApprover_(ss, s, c.imported, formApprovalCountWaiting_(ledger));
      }

      // 2. 知らせる
      formApprovalNotifyJudged_(ledger, s, c, startedAt);

      ctx.setCount(c.sent);
      ctx.setMessage('取り込み ' + c.imported + '、知らせた ' + c.sent + '、宛先なし ' + c.noAddress +
        '、次の回へ ' + c.left + '、送信中のまま ' + c.sending);
      return c;
    }, {
      log: { spreadsheet: ss, sheetName: s['実行記録のシート'], matchTimeZone: true },
      notify: { to: s['失敗の通知先'] }
    });
  } catch (e) {
    // 実行記録と通知は guard が済ませている。シートの見出しの間違いは、日本語で知らせて終わる。
    if (e && e.name === 'SheetFormatError') {
      formApprovalAlert_(e.message);
      return { status: 'failure', errorType: e.name };
    }
    throw e;
  }

  if (res.status === 'skipped') {
    formApprovalToast_(ss, 'ほかの取り込みが動いているため、今回は動かしませんでした。少し待ってからもう一度実行してください。');
  } else {
    formApprovalToast_(ss, '新しい申請 ' + c.imported + ' 件を取り込み、' + c.sent + ' 件の結果を知らせました。' +
      (c.left ? '残りの ' + c.left + ' 件は次の回に知らせます。' : '') +
      (c.noAddress ? '宛先がなく知らせられなかったものが ' + c.noAddress + ' 件あります。' : ''));
  }
  return res;
}

/** 定時の動きを始める（10 分ごとのトリガーを 1 つだけ張る。前のものがあれば張り直す）。 */
function startFormApproval() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (WitGas.migrate.needed({ key: FORM_APPROVAL.schemaKey, steps: FORM_APPROVAL_STEPS })) {
    formApprovalAlert_('先に、メニュー「申請 → 設定と表を用意する」を実行してください。');
    return null;
  }
  var s = formApprovalSettingsOrTell_(ss);
  if (!s) return null;
  var removed = formApprovalDeleteTriggers_();
  ScriptApp.newTrigger(FORM_APPROVAL.handler).timeBased().everyMinutes(FORM_APPROVAL.everyMinutes).create();
  formApprovalAlert_('定時の動きを始めました（' + FORM_APPROVAL.everyMinutes + ' 分ごと）。' +
    (removed ? '前のトリガー ' + removed + ' 個は張り直しました。' : '') +
    'トリガーは、このメニューを実行した人のものとして動きます。');
  return { removed: removed };
}

/** 定時の動きを止める（トリガーを消す。シートの中身は残る）。 */
function stopFormApproval() {
  var removed = formApprovalDeleteTriggers_();
  formApprovalAlert_(removed
    ? '定時の動きを止めました（トリガー ' + removed + ' 個を消しました）。シートの中身は残っています。'
    : '定時の動きは、もう止まっています（この人が作ったトリガーはありません）。');
  return { removed: removed };
}

/**
 * 設定と表を用意する（初めて入れたときと、版上げのときに動かす）。
 * まだ動いていない段だけを動かす。何度動かしても結果は変わらない。
 */
function migrateFormApproval() {
  var res = WitGas.guard(FORM_APPROVAL.name + '（用意）', function (ctx) {
    var r = WitGas.migrate.run({ key: FORM_APPROVAL.schemaKey, steps: FORM_APPROVAL_STEPS });
    ctx.setMessage('スキーマ ' + r.from + ' → ' + r.to);
    return r;
  }, { log: false, notify: false, rethrow: false });
  if (res.status === 'failure') {
    formApprovalAlert_('設定と表の用意に失敗しました（' + res.errorType + '）。スプレッドシートのコピーに戻すか、実行数の画面でエラーを確かめてください。');
  } else if (res.status === 'success') {
    var r = res.value;
    formApprovalAlert_(r.ran.length
      ? '設定と表を用意しました（スキーマの版 ' + r.from + ' → ' + r.to + '）。「設定」シートの通知先を確かめてください。'
      : '設定と表は、もう用意されています（スキーマの版 ' + r.to + '）。');
  }
  return res;
}

/**
 * 点検する（版上げのあとや、困ったときに動かす）。直すことはしない。
 * 回答のシートと承認のシートを突き合わせ、取り込み漏れ・送信中のまま・知らせたあとに変わった判断を数える。
 * @return {{ok: boolean, problems: string[], counts: Object}}
 */
function checkFormApproval() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var problems = [];
  var counts = null;
  var current = WitGas.migrate.current(FORM_APPROVAL.schemaKey);
  var latest = FORM_APPROVAL_STEPS[FORM_APPROVAL_STEPS.length - 1].version;
  if (current !== latest) problems.push('スキーマの版が ' + current + ' です（この版のコードは ' + latest + '）。「設定と表を用意する」を実行してください。');
  var s = null;
  try {
    s = formApprovalReadSettings_(ss);
  } catch (e) {
    problems.push(e && e.name === 'SettingsError' ? e.message : '設定を読めませんでした（' + (e && e.name) + '）。');
  }
  if (s) {
    ['承認者の通知先', '失敗の通知先'].forEach(function (key) {
      if (FORM_APPROVAL.placeholders.indexOf(String(s[key]).trim()) >= 0) {
        problems.push('「設定」シートの「' + key + '」が見本のアドレスのままです。');
      }
    });
    var triggers = formApprovalTriggers_();
    if (triggers === null) {
      problems.push('トリガーの一覧を読めませんでした。');
    } else if (triggers.length === 0) {
      problems.push('定時の動きが止まっています（' + FORM_APPROVAL.handler + ' のトリガーがありません）。使うときは「定時の動きを始める」を実行してください。ほかの人が始めたなら、その人のトリガーの画面で確かめてください。');
    } else if (triggers.length > 1) {
      problems.push(FORM_APPROVAL.handler + ' のトリガーが ' + triggers.length + ' 個あります。「定時の動きを始める」で 1 つに張り直してください。');
    }
    var answers = null;
    try {
      answers = formApprovalReadAnswers_(ss, s);
    } catch (e) {
      problems.push(e && e.name === 'SheetFormatError' ? e.message : '回答のシートを読めませんでした（' + (e && e.name) + '）。');
    }
    var ledgerSheet = ss.getSheetByName(s['承認のシート']);
    if (!ledgerSheet) problems.push('「' + s['承認のシート'] + '」シートがありません。');
    if (answers && ledgerSheet) {
      counts = formApprovalReconcile_(answers, formApprovalLedger_(ss, s, true));
      if (counts.notImported) problems.push('まだ取り込んでいない回答が ' + counts.notImported + ' 件あります（次の回に取り込みます）。');
      if (counts.missingAnswer) problems.push('回答のシートから消えた（または並べ替えた）申請が ' + counts.missingAnswer + ' 件あります。回答のシートの行は消さず、並べ替えないでください。');
      if (counts.sending) problems.push('「送信中」のままの申請が ' + counts.sending + ' 件あります。送信の途中で止まった見込みです。動かした人の Gmail の「送信済み」で届いたかを確かめ、状態を直してください（送っていなければ「未判断」に戻すと、次の回に送ります）。');
      if (counts.changedAfter) problems.push('知らせたあとに「判断」が変わった申請が ' + counts.changedAfter + ' 件あります。申請者には前の結果が届いています。');
      if (counts.noAddress) problems.push('宛先がなく知らせられなかった申請が ' + counts.noAddress + ' 件あります。フォームの「メールアドレスを収集する」がオンかを確かめてください。');
    }
  }
  var ok = problems.length === 0;
  formApprovalAlert_(ok
    ? '点検：問題は見つかりませんでした（' + FORM_APPROVAL.appName + ' ' + FORM_APPROVAL_VERSION + '、スキーマの版 ' + current +
      (counts ? '、判断待ち ' + counts.waiting + ' 件' : '') + '）。'
    : '点検：次のことを確かめてください。\n' + problems.map(function (p) { return '・' + p; }).join('\n'));
  return { ok: ok, problems: problems, counts: counts };
}

/**
 * 見本のデータ（架空）を入れる。回答のシートがあるとき（フォームがつながっているときを含む）は、何もしない。
 */
function setupFormApprovalSample() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  WitGas.migrate.run({ key: FORM_APPROVAL.schemaKey, steps: FORM_APPROVAL_STEPS });
  var s = formApprovalSettingsOrTell_(ss);
  if (!s) return false;
  if (ss.getSheetByName(s['回答のシート'])) {
    formApprovalAlert_('「' + s['回答のシート'] + '」シートがあるため、見本のデータは入れません。');
    return false;
  }
  var extra = formApprovalSplit_(s['写す列']);
  var header = [s['列：タイムスタンプ'], s['列：メールアドレス']].concat(extra);
  var sample = [
    { mail: 'applicant1@example.com', values: { '件名': '出張旅費（大阪）', '金額': 32000 } },
    { mail: 'applicant2@example.com', values: { '件名': '書籍の購入', '金額': 4800 } },
    { mail: 'applicant3@example.com', values: { '件名': '研修の参加費', '金額': 15000 } }
  ];
  var rows = [header].concat(sample.map(function (x, i) {
    return [new Date(2026, 11, 1, 9, 10 + i, 0), x.mail].concat(extra.map(function (h) {
      return x.values.hasOwnProperty(h) ? x.values[h] : '';
    }));
  }));
  var sheet = ss.insertSheet(s['回答のシート']);
  sheet.getRange(1, 1, rows.length, header.length).setValues(rows);
  formApprovalToast_(ss, '見本の回答を 3 件入れました（宛先は架空の example.com）。メニュー「申請 → 今すぐ取り込む・知らせる」で試せます。');
  return true;
}

/** 引き継ぎ書を作る。 */
function writeFormApprovalHandover() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var settings;
  try {
    var s = formApprovalReadSettings_(ss);
    settings = FORM_APPROVAL_SETTINGS.map(function (item) {
      return { name: '設定：' + item.key, value: s[item.key], note: item.note || '' };
    });
  } catch (e) {
    settings = [{ name: '設定', value: '（読めなかった：' + (e && e.name) + '）', note: '「点検する」で確かめる' }];
  }
  return WitGas.handover.write({
    spreadsheet: ss,
    app: { name: FORM_APPROVAL.appName, version: FORM_APPROVAL_VERSION },
    scopes: FORM_APPROVAL_SCOPES,
    settings: settings.concat([
      { name: '設定の置き場所', value: '「' + FORM_APPROVAL.settingsSheet + '」シート', note: 'コードを入れ替えても消えない' },
      { name: '定時の動き', value: FORM_APPROVAL.everyMinutes + ' 分ごとに ' + FORM_APPROVAL.handler, note: 'トリガーは「定時の動きを始める」を実行した人のもの' }
    ]),
    stopSteps: [
      'メニュー「申請 → 定時の動きを止める」を実行する（トリガーを作った人が実行する）',
      'トリガーの画面で、関数 ' + FORM_APPROVAL.handler + ' のトリガーが残っていないことを確かめる',
      '申請の受付もやめるなら、フォームの「回答」で「回答を受け付ける」をオフにする',
      'メニューを出さないようにするなら、main.js の onOpen を消す'
    ]
  });
}

// ---- 内部：取り込む ----

/** 回答のシートを読む。見出しが足りなければ SheetFormatError（列名だけを書く） */
function formApprovalReadAnswers_(ss, s) {
  var sheet = ss.getSheetByName(s['回答のシート']);
  if (!sheet) {
    throw formApprovalFormatError_('「' + s['回答のシート'] + '」シートがありません。フォームの「回答」から、このスプレッドシートにつないでください。');
  }
  var table = sheet.getLastRow() === 0 ? [[]] : sheet.getDataRange().getValues();
  var names = table[0].map(function (h) { return h === null || h === undefined ? '' : String(h).trim(); });
  var wanted = [s['列：タイムスタンプ'], s['列：メールアドレス']].concat(formApprovalSplit_(s['写す列']));
  var missing = wanted.filter(function (w) { return names.indexOf(w) < 0; });
  if (missing.length > 0) {
    throw formApprovalFormatError_('「' + s['回答のシート'] + '」の見出し（1 行目）に「' + missing.join('」「') + '」がありません。');
  }
  return {
    rows: table.slice(1),
    time: names.indexOf(s['列：タイムスタンプ']),
    mail: names.indexOf(s['列：メールアドレス']),
    copy: formApprovalSplit_(s['写す列']).map(function (h) { return { name: h, index: names.indexOf(h) }; })
  };
}

/**
 * 承認のシート（なければ作る）。足りない見出しは右に足す。判断の列は「承認」「差し戻し」から選ぶ形にする。
 * readOnly なら何も足さずに読むだけ（点検で使う）。
 */
function formApprovalLedger_(ss, s, readOnly) {
  var name = s['承認のシート'];
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  var header = sheet.getLastRow() === 0 ? [] : sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0]
    .map(function (h) { return h === null || h === undefined ? '' : String(h).trim(); });
  var fresh = header.length === 0;
  var want = FORM_APPROVAL.columns.concat(formApprovalSplit_(s['写す列']));
  var add = readOnly ? [] : want.filter(function (w) { return header.indexOf(w) < 0; });
  if (add.length > 0) {
    sheet.getRange(1, header.length + 1, 1, add.length).setValues([add]).setFontWeight('bold');
    header = header.concat(add);
  }
  if (fresh && !readOnly) {
    sheet.setFrozenRows(1);
    var rule = SpreadsheetApp.newDataValidation().requireValueInList(FORM_APPROVAL.judgments, true).setAllowInvalid(false).build();
    sheet.getRange(2, header.indexOf('判断') + 1, Math.max(1, sheet.getMaxRows() - 1), 1).setDataValidation(rule);
    sheet.getRange(2, header.indexOf('受付日時') + 1, Math.max(1, sheet.getMaxRows() - 1), 1).setNumberFormat('yyyy-mm-dd hh:mm');
    sheet.getRange(2, header.indexOf('知らせた日時') + 1, Math.max(1, sheet.getMaxRows() - 1), 1).setNumberFormat('yyyy-mm-dd hh:mm');
  }
  var col = {};
  header.forEach(function (h, i) { if (h !== '' && !col.hasOwnProperty(h)) col[h] = i; });
  var last = sheet.getLastRow();
  var rows = last < 2 ? [] : sheet.getRange(2, 1, last - 1, header.length).getValues();
  return { sheet: sheet, col: col, width: header.length, rows: rows };
}

/** 受付のキー：タイムスタンプ（秒）と申請者のアドレス。シートに書いて読み直すとミリ秒がずれることがあるので秒にする */
function formApprovalKey_(time, mail) {
  var t = time && typeof time.getTime === 'function' ? Math.round(time.getTime() / 1000) : String(time);
  return t + '|' + String(mail === null || mail === undefined ? '' : mail).replace(/^'/, '').trim().toLowerCase();
}

/** まだ承認のシートにない回答の、回答のシートでの番号（0 から） */
function formApprovalNewAnswers_(answers, ledger) {
  var have = {};
  ledger.rows.forEach(function (r) {
    var k = formApprovalKey_(r[ledger.col['受付日時']], r[ledger.col['申請者']]);
    have[k] = (have[k] || 0) + 1;
  });
  var fresh = [];
  answers.rows.forEach(function (r, i) {
    var time = r[answers.time];
    if (time === '' || time === null || time === undefined) return; // 空の行
    var k = formApprovalKey_(time, r[answers.mail]);
    if (have[k]) {
      have[k]--;
    } else {
      fresh.push(i);
    }
  });
  return fresh;
}

function formApprovalAppend_(ledger, s, answers, fresh) {
  var next = ledger.rows.length + 1;
  var col = ledger.col;
  var out = fresh.map(function (i, n) {
    var a = answers.rows[i];
    var row = [];
    for (var k = 0; k < ledger.width; k++) row.push('');
    row[col['申請番号']] = s['申請番号の頭'] + ('000' + (next + n)).slice(-4);
    row[col['受付日時']] = a[answers.time];
    row[col['申請者']] = formApprovalCell_(a[answers.mail]);
    row[col['状態']] = FORM_APPROVAL.states.waiting;
    row[col['回答の行']] = i + 2;
    answers.copy.forEach(function (c) { row[col[c.name]] = formApprovalCell_(a[c.index]); });
    return row;
  });
  ledger.sheet.getRange(ledger.rows.length + 2, 1, out.length, ledger.width).setValues(out);
  ledger.rows = ledger.rows.concat(out);
}

/** 承認者に、新しい申請の件数を知らせる（件数とシートの場所だけ。申請の中身は書かない） */
function formApprovalTellApprover_(ss, s, imported, waiting) {
  MailApp.sendEmail({
    to: s['承認者の通知先'],
    subject: s['件名の頭'] + ' 新しい申請 ' + imported + ' 件（判断待ち ' + waiting + ' 件）',
    name: s['送り主の名前'],
    body: [
      '新しい申請が ' + imported + ' 件届きました。判断待ちは全部で ' + waiting + ' 件です。',
      '',
      '「' + s['承認のシート'] + '」シートの「判断」で「承認」か「差し戻し」を選んでください。',
      '差し戻しのときは、「コメント」に理由を書いてください。選んでから ' + FORM_APPROVAL.everyMinutes + ' 分ほどで、申請者に結果を知らせます。',
      '',
      ss.getUrl()
    ].join('\n')
  });
}

function formApprovalCountWaiting_(ledger) {
  return ledger.rows.filter(function (r) { return r[ledger.col['状態']] === FORM_APPROVAL.states.waiting; }).length;
}

// ---- 内部：知らせる ----

/**
 * 判断が選ばれた「未判断」の行の申請者に知らせる。
 * 送る前に状態を「送信中」にして書き込みを確定し、送れたら「知らせた」にする。
 * 途中で止まっても二度送らない（「送信中」のまま残り、点検で見つかる）。
 */
function formApprovalNotifyJudged_(ledger, s, c, startedAt) {
  var col = ledger.col;
  var S = FORM_APPROVAL.states;
  var limit = s['1 回に知らせる上限'];
  var tz = Session.getScriptTimeZone();
  for (var i = 0; i < ledger.rows.length; i++) {
    var r = ledger.rows[i];
    if (r[col['状態']] === S.sending) { c.sending++; continue; }
    if (r[col['状態']] !== S.waiting) continue;
    var judgment = String(r[col['判断']]).trim();
    if (FORM_APPROVAL.judgments.indexOf(judgment) < 0) continue;

    var to = String(r[col['申請者']]).replace(/^'/, '').trim();
    if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to)) {
      formApprovalSetCells_(ledger, i, { '状態': S.noAddress });
      c.noAddress++;
      continue;
    }
    if (c.sent >= limit || new Date().getTime() - startedAt > FORM_APPROVAL.budgetMs || MailApp.getRemainingDailyQuota() < 1) {
      c.left++;
      continue;
    }
    formApprovalSetCells_(ledger, i, { '状態': S.sending });
    SpreadsheetApp.flush();
    MailApp.sendEmail(formApprovalResultMail_(s, r, col, judgment, to, tz));
    formApprovalSetCells_(ledger, i, {
      '状態': judgment === '承認' ? S.approved : S.returned,
      '知らせた日時': new Date()
    });
    SpreadsheetApp.flush();
    c.sent++;
  }
}

function formApprovalResultMail_(s, r, col, judgment, to, tz) {
  var received = r[col['受付日時']];
  var vars = {
    '申請番号': String(r[col['申請番号']]),
    '受付日時': received && typeof received.getTime === 'function' ? Utilities.formatDate(received, tz, 'yyyy-MM-dd HH:mm') : String(received),
    '結果': judgment,
    'コメント': String(r[col['コメント']]).trim() || '（なし）'
  };
  var template = judgment === '承認' ? s['承認のメールの文'] : s['差し戻しのメールの文'];
  var mail = {
    to: to,
    subject: s['件名の頭'] + ' 申請 ' + vars['申請番号'] + '：' + judgment,
    name: s['送り主の名前'],
    body: String(template).replace(/\{(申請番号|受付日時|結果|コメント)\}/g, function (m, k) { return vars[k]; })
  };
  if (s['返信先']) mail.replyTo = s['返信先'];
  return mail;
}

function formApprovalSetCells_(ledger, i, values) {
  Object.keys(values).forEach(function (name) {
    var c = ledger.col[name];
    ledger.sheet.getRange(i + 2, c + 1, 1, 1).setValues([[values[name]]]);
    ledger.rows[i][c] = values[name];
  });
}

// ---- 内部：突き合わせ・トリガー ----

/** 回答のシートと承認のシートの突き合わせ（件数だけ） */
function formApprovalReconcile_(answers, ledger) {
  var col = ledger.col;
  var S = FORM_APPROVAL.states;
  var inAnswers = {};
  answers.rows.forEach(function (r) {
    if (r[answers.time] === '' || r[answers.time] === null) return;
    var k = formApprovalKey_(r[answers.time], r[answers.mail]);
    inAnswers[k] = (inAnswers[k] || 0) + 1;
  });
  var out = { notImported: formApprovalNewAnswers_(answers, ledger).length, missingAnswer: 0, waiting: 0, sending: 0, changedAfter: 0, noAddress: 0 };
  ledger.rows.forEach(function (r) {
    var k = formApprovalKey_(r[col['受付日時']], r[col['申請者']]);
    if (inAnswers[k]) inAnswers[k]--; else out.missingAnswer++;
    var state = r[col['状態']];
    var j = String(r[col['判断']]).trim();
    if (state === S.waiting) out.waiting++;
    if (state === S.sending) out.sending++;
    if (state === S.noAddress) out.noAddress++;
    if ((state === S.approved && j !== '承認') || (state === S.returned && j !== '差し戻し')) out.changedAfter++;
  });
  return out;
}

function formApprovalTriggers_() {
  try {
    return ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === FORM_APPROVAL.handler; });
  } catch (e) {
    return null;
  }
}

function formApprovalDeleteTriggers_() {
  var list = formApprovalTriggers_() || [];
  list.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  return list.length;
}

// ---- 内部：設定・小さな道具 ----

function formApprovalReadSettings_(ss) {
  var s = WitGas.settings.read({ spreadsheet: ss, sheetName: FORM_APPROVAL.settingsSheet, items: FORM_APPROVAL_SETTINGS });
  var limit = s['1 回に知らせる上限'];
  if (Math.floor(limit) !== limit || limit < 1 || limit > 100) {
    var e = new Error('「' + FORM_APPROVAL.settingsSheet + '」シートの「1 回に知らせる上限」は 1〜100 の整数にしてください。');
    e.name = 'SettingsError';
    throw e;
  }
  return s;
}

/**
 * 設定を読む。設定の誤りは画面で知らせて null。
 * 定時に動いているとき（画面がない）は気づけないので、「失敗の通知先」だけでも読めればメールで知らせる（1 時間に 1 通まで）。
 */
function formApprovalSettingsOrTell_(ss) {
  try {
    return formApprovalReadSettings_(ss);
  } catch (e) {
    if (!(e && e.name === 'SettingsError')) throw e;
    if (formApprovalAlert_(e.message + '「設定」シートを直してから、もう一度実行してください。')) return null;
    try {
      var item = FORM_APPROVAL_SETTINGS.filter(function (it) { return it.key === '失敗の通知先'; });
      var to = WitGas.settings.read({ spreadsheet: ss, sheetName: FORM_APPROVAL.settingsSheet, items: item })['失敗の通知先'];
      WitGas.notify.failure({ name: FORM_APPROVAL.name, errorType: 'SettingsError' }, { to: to, linkUrl: ss.getUrl() });
    } catch (e2) {
      console.error('[申請の承認] 設定の誤りを知らせられませんでした（' + (e2 && e2.name) + '）');
    }
    return null;
  }
}

function formApprovalFormatError_(message) {
  var e = new Error(message);
  e.name = 'SheetFormatError';
  return e;
}

function formApprovalSplit_(v) {
  return String(v === null || v === undefined ? '' : v).split(/[,，、]/)
    .map(function (x) { return x.trim(); })
    .filter(function (x) { return x !== ''; });
}

/** セルに書く文字：式として読まれないようにする（フォームの回答は誰でも書けるため） */
function formApprovalCell_(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

/** 画面に知らせる。トリガーやエディタから動かしたとき（画面がない）はログに出して false。 */
function formApprovalAlert_(message) {
  try {
    SpreadsheetApp.getUi().alert(message);
    return true;
  } catch (e) {
    console.log('[申請の承認] ' + message);
    return false;
  }
}

function formApprovalToast_(ss, message) {
  try {
    ss.toast(message, FORM_APPROVAL.name, 10);
  } catch (e) {
    console.log('[申請の承認] ' + message);
  }
}
