/**
 * 見本：GAS の点検（gas-inspect）
 *
 * すでに使っている GAS のプロジェクトに 1 つだけファイルを足し、エディタから witInspect() を動かして、
 * トリガー・権限・6 分の上限・失敗の記録を点検する。結果は「点検結果」シートに、
 * 版・トリガー・権限・プロパティ（値は伏せる）・シートの構成は「引き継ぎ書」シートに書く。
 *
 * - 先方のコードは書き換えない。トリガーも作らない・消さない。プロパティも書かない。
 * - 書くのは「点検結果」と「引き継ぎ書」の 2 つのシートだけ（同じ名前の別のシートがあれば書かない）。
 * - 先方のグローバルの WitGas には触らない（npm run example:build で、部品ごと 1 つの関数に閉じ込める）。
 * - 関数の中身（コード）・シートの値は、どこにも書かない。書くのは関数名・トリガーの種類・件数まで。
 *
 * 使う部品：src/ の version.js・handover.js（この関数の中だけで使う）
 *
 * © 2026 wi-t.com Inc.
 */

/** この見本の版。変えたら CHANGELOG.md に書く。 */
var GAS_INSPECT_VERSION = '1.0.0';

var GAS_INSPECT = {
  sheetName: '点検結果',
  marker: '点検結果',
  handoverSheet: '引き継ぎ書',
  // 点検のファイル自身が足すグローバルの名前（先方の関数として数えない）
  ownNames: ['WIT_INSPECT', 'witInspect'],
  // トリガーの上限（1 人・1 スクリプトあたり）と、気をつける目安
  triggerLimit: 20,
  triggerWarnAt: 15,
  // 点検のために足すことがある権限（後片付けで外す）
  inspectScopes: [
    'https://www.googleapis.com/auth/script.scriptapp',
    'https://www.googleapis.com/auth/spreadsheets.currentonly'
  ]
};

var GAS_INSPECT_STATES = {
  good: 'よい',
  warn: '気をつける',
  fix: '直したほうがよい',
  look: '目で確かめる'
};

/** 広い権限と、代わりに使えることが多い狭い権限 */
var GAS_INSPECT_BROAD_SCOPES = {
  'https://www.googleapis.com/auth/drive': 'drive.file（このスクリプトが作った・開いたファイルだけ）か drive.readonly で足りないか',
  'https://www.googleapis.com/auth/spreadsheets': 'スプレッドシートに付いたスクリプトで、そのファイルだけを扱うなら spreadsheets.currentonly',
  'https://www.googleapis.com/auth/documents': 'ドキュメントに付いたスクリプトで、そのファイルだけを扱うなら documents.currentonly',
  'https://mail.google.com/': '送るだけなら script.send_mail（MailApp）や gmail.send、読むだけなら gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify': '読むだけなら gmail.readonly、送るだけなら gmail.send',
  'https://www.googleapis.com/auth/calendar': '読むだけなら calendar.readonly、予定だけなら calendar.events',
  'https://www.googleapis.com/auth/script.external_request': '外部に送る権限。送り先（UrlFetchApp の URL）を目で確かめる'
};

/** ECMAScript と GAS が最初から持っている名前（先方の関数として数えない） */
var GAS_INSPECT_STANDARD_NAMES = [
  'Object', 'Function', 'Array', 'Number', 'Boolean', 'String', 'Symbol', 'BigInt', 'Date', 'RegExp', 'Promise',
  'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'AggregateError',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry', 'Proxy', 'Reflect', 'JSON', 'Math', 'Intl',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent',
  'escape', 'unescape', 'eval', 'globalThis', 'console', 'Logger'
];

/** インストール型のトリガーに付けると、シンプルトリガーとしても動く名前 */
var GAS_INSPECT_SIMPLE_NAMES = ['onOpen', 'onEdit', 'onSelectionChange', 'onInstall'];

/** 二重に動くと困る種類のトリガー（開いたときなどは人が 1 回ずつ動かすので除く） */
var GAS_INSPECT_REPEATING_EVENTS = ['CLOCK', 'ON_FORM_SUBMIT', 'ON_EDIT', 'ON_CHANGE', 'ON_EVENT_UPDATED'];

/**
 * 点検する。
 *
 * @param {Object} [opts] テストのための差し替え
 * @param {Object} [opts.global] 先方の関数を探すグローバル（既定は globalThis）
 * @param {Object} [opts.spreadsheet] 書き先（既定は開いているスプレッドシート。なければ実行ログに出す）
 * @return {{sheetName: ?string, counts: Object, rows: Array<Array<string>>, handover: ?Object}}
 */
function gasInspectRun_(opts) {
  opts = opts || {};
  var g = opts.global || globalThis;
  var ss = opts.spreadsheet !== undefined ? opts.spreadsheet : SpreadsheetApp.getActiveSpreadsheet();
  var out = [];
  var add = function (state, item, reason, howTo, check) {
    out.push([state, item, reason || '', howTo || '', check || '']);
  };

  // 書き先に同じ名前の別のシートがあれば、何も書かずに止める（引き継ぎ書も書かない）
  if (ss) gasInspectSheetOrRefuse_(ss);

  var functions = gasInspectFunctions_(g);
  var triggers = gasInspectTriggers_();
  var scopes = gasInspectAuthorizedScopes_();

  var fnames = Object.keys(functions).sort();
  add(GAS_INSPECT_STATES.good, '関数', 'グローバルの関数 ' + fnames.length + ' 個を見た' + (fnames.length ? '：' + gasInspectClip_(fnames.join('・'), 250) : '') + '。',
    '', 'function で書いた関数だけを数える（README の「できないこと」）。');

  gasInspectCheckTriggers_(add, triggers, functions);
  gasInspectCheckHandlers_(add, triggers, functions);
  gasInspectCheckWebApp_(add, functions);
  gasInspectCheckScopes_(add, scopes);
  gasInspectCheckTimeZone_(add, ss);
  gasInspectCheckKit_(add, g);

  add(GAS_INSPECT_STATES.look, '6 分の上限',
    'この点検では実行の時間は読めない（読む権限を足さないため）。',
    '5 分を越えるものは、区切って続きを動かす（WitGas.resume）。',
    'エディタの「実行数」で、トリガーで動いた実行の時間と「時間超過」がないかを見る。');
  add(GAS_INSPECT_STATES.look, '権限を appsscript.json に書いているか',
    '書いていなければ、GAS がコードから権限を推し量る。この点検のファイルを足すと権限が増え、承認の画面が出る。',
    'oauthScopes に使う権限だけを書き、使う理由を引き継ぎ書に残す。',
    '「プロジェクトの設定」で appsscript.json を表示し、oauthScopes があるかを見る。');

  var handover = null;
  if (ss) {
    handover = gasInspectHandover_(add, ss, g);
  } else {
    add(GAS_INSPECT_STATES.look, '引き継ぎ書',
      'スプレッドシートに付いていないスクリプトなので、引き継ぎ書は作らなかった（シートを開く権限を足さないため）。',
      '', '');
  }

  add(GAS_INSPECT_STATES.look, '後片付け：元に戻したか',
    '点検のために足したファイル（wit-inspect）と、appsscript.json に足した権限は、点検のあとに外す。',
    'wit-inspect のファイルを消す。appsscript.json を点検の前の形に戻す（控えから貼り直す）。',
    '済んだら、この欄に「済み」と日付を書く。');

  var counts = gasInspectCount_(out);
  var head = [
    [GAS_INSPECT.marker, new Date(), '', '', ''],
    ['点検の版', 'gas-inspect ' + GAS_INSPECT_VERSION, '', '', ''],
    ['スクリプト ID', gasInspectSafe_(function () { return ScriptApp.getScriptId(); }) || '（読めなかった）', '', '', ''],
    ['見た範囲', 'トリガーは、この点検を動かした人が作ったものだけが見えます。ほかの人のトリガーは、その人がトリガーの画面で確かめてください。', '', '', ''],
    ['まとめ', gasInspectSummary_(counts), '', '', ''],
    ['', '', '', '', ''],
    ['状態', '項目', '理由', '直し方の例', '確認']
  ];
  var rows = head.concat(out);

  var sheetName = null;
  if (ss) {
    sheetName = gasInspectWriteSheet_(ss, rows);
  } else {
    rows.forEach(function (r) { console.log(r.filter(function (c) { return c !== ''; }).join(' | ')); });
  }
  return { sheetName: sheetName, counts: counts, rows: rows, handover: handover };
}

// ---- 集める ----

/** 先方の関数：グローバルにある、先方が書いた関数の名前と中身（中身は点検に使うだけで、どこにも書かない） */
function gasInspectFunctions_(g) {
  var map = {};
  Object.getOwnPropertyNames(g).forEach(function (name) {
    if (GAS_INSPECT_STANDARD_NAMES.indexOf(name) >= 0 || GAS_INSPECT.ownNames.indexOf(name) >= 0) return;
    var f;
    try {
      f = g[name];
    } catch (e) {
      return;
    }
    if (typeof f !== 'function') return;
    var src = '';
    try {
      src = Function.prototype.toString.call(f);
    } catch (e) {
      return;
    }
    if (/\{\s*\[native code\]\s*\}\s*$/.test(src)) return;
    map[name] = src;
  });
  return map;
}

function gasInspectTriggers_() {
  var list = gasInspectSafe_(function () { return ScriptApp.getProjectTriggers(); });
  if (!list) return null;
  return list.map(function (t) {
    var source = gasInspectSafe_(function () { return String(t.getTriggerSource()); }) || '';
    var sourceId = gasInspectSafe_(function () {
      return typeof t.getTriggerSourceId === 'function' ? t.getTriggerSourceId() : null;
    });
    return {
      handler: String(t.getHandlerFunction()),
      event: String(t.getEventType()),
      source: source,
      sourceId: sourceId === null || sourceId === undefined ? '' : String(sourceId)
    };
  });
}

function gasInspectAuthorizedScopes_() {
  return gasInspectSafe_(function () {
    var info = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL);
    return info && typeof info.getAuthorizedScopes === 'function' ? info.getAuthorizedScopes() : null;
  });
}

// ---- 点検 ----

function gasInspectCheckTriggers_(add, triggers, functions) {
  var S = GAS_INSPECT_STATES;
  if (triggers === null) {
    add(S.look, 'トリガー', 'トリガーの一覧を読めなかった（権限 script.scriptapp がない見込み）。',
      'README の「点検のしかた」のとおり、点検のあいだだけ権限を足す。', 'トリガーの画面で、関数名と種類を控える。');
    return;
  }
  var n = triggers.length;
  if (n === 0) {
    add(S.good, 'トリガーの数', 'この人が作ったトリガーはない。', '', 'ほかの人が作ったトリガーがないかは、その人に確かめてもらう。');
    return;
  }
  add(n >= GAS_INSPECT.triggerWarnAt ? S.warn : S.good, 'トリガーの数',
    n + ' 個（1 人・1 スクリプトあたり ' + GAS_INSPECT.triggerLimit + ' 個まで）。',
    n >= GAS_INSPECT.triggerWarnAt ? '要らないもの・動き終わったものを消す。' : '', '');

  // 関数がないトリガー
  triggers.forEach(function (t) {
    if (!functions.hasOwnProperty(t.handler)) {
      add(S.fix, 'トリガー：' + t.handler, '動かす関数 ' + t.handler + ' が見つからない（消した・名前を変えた見込み）。動くたびに失敗する。',
        '関数を戻すか、トリガーを消す。', '');
    }
  });

  // 同じ関数・同じ種類・同じ起動元のトリガーが 2 つ以上
  var groups = {};
  triggers.forEach(function (t) {
    var k = [t.handler, t.event, t.source, t.sourceId].join('\n');
    (groups[k] = groups[k] || []).push(t);
  });
  Object.keys(groups).forEach(function (k) {
    var g = groups[k];
    if (g.length < 2) return;
    var t = g[0];
    if (t.event === 'CLOCK') {
      add(S.warn, 'トリガー：' + t.handler, '時間主導型が ' + g.length + ' 個ある。時刻がちがうなら意図どおりのこともある。',
        '同じ時刻なら 1 つにする。', 'トリガーの画面で、それぞれの時刻と「無効」になっていないかを見る。');
    } else {
      add(S.fix, 'トリガー：' + t.handler, '同じ種類（' + t.event + '）のトリガーが ' + g.length + ' 個あり、1 回のできごとで ' + g.length + ' 回動く。',
        '1 つだけ残して消す。', '');
    }
  });

  // インストール型に、シンプルトリガーと同じ名前の関数
  triggers.forEach(function (t) {
    if (GAS_INSPECT_SIMPLE_NAMES.indexOf(t.handler) >= 0 && functions.hasOwnProperty(t.handler)) {
      add(S.fix, 'トリガー：' + t.handler, '関数の名前が ' + t.handler + ' なので、シンプルトリガーとしても動き、インストール型と合わせて二重に動く。',
        '関数の名前を変え（例：' + t.handler + 'Installed）、トリガーをその名前で張り直す。', '');
    }
  });

  if (triggers.some(function (t) { return t.event === 'CLOCK'; })) {
    add(S.look, '動き終わったトリガー', '1 回だけの時間主導型は、動き終わっても一覧に「無効」で残る。一覧からは、動き終わったかを見分けられない。',
      '動き終わったものは消す。', 'トリガーの画面で「無効」のものがないかを見る。');
  }
}

/** トリガーで動く関数が、二重実行の防止と失敗の扱いを持っているか（関数から呼んでいる関数まで見る） */
function gasInspectCheckHandlers_(add, triggers, functions) {
  if (!triggers) return;
  var S = GAS_INSPECT_STATES;
  var seen = {};
  triggers.forEach(function (t) {
    if (seen[t.handler] || !functions.hasOwnProperty(t.handler)) return;
    seen[t.handler] = true;
    var code = gasInspectReachable_(t.handler, functions);
    var guarded = /WitGas\.guard\s*\(/.test(code);
    var repeating = triggers.some(function (x) {
      return x.handler === t.handler && GAS_INSPECT_REPEATING_EVENTS.indexOf(x.event) >= 0;
    });

    if (repeating) {
      if (guarded || /LockService\s*\.\s*get(Script|Document|User)Lock/.test(code) || /WitGas\.lock\.run\s*\(/.test(code)) {
        add(S.good, '二重実行：' + t.handler, 'ロックを使っている。', '', '');
      } else {
        add(S.warn, '二重実行：' + t.handler, 'ロックが見当たらない。前の実行が終わる前に次が始まると、同じ処理が二重に動く。',
          'WitGas.guard（または WitGas.lock.run）で包む。', '');
      }
    }

    var hasCatch = /\bcatch\s*[({]/.test(code);
    var tells = /\b(MailApp|GmailApp)\s*\.\s*send/.test(code) || /WitGas\.notify\./.test(code);
    var rethrows = /\bthrow\b/.test(code);
    if (guarded) {
      add(S.good, '失敗の扱い：' + t.handler, 'WitGas.guard で包んでいる（記録と通知は guard の設定による）。', '', '');
    } else if (!hasCatch) {
      add(S.warn, '失敗の扱い：' + t.handler, '失敗をつかまえていない。失敗は「実行数」の画面と、トリガーの失敗の知らせでしか分からない。',
        'WitGas.guard で包み、実行記録と失敗の通知を残す。', 'トリガーの失敗の知らせの送り先と頻度を、トリガーの画面で見る。');
    } else if (!tells && !rethrows) {
      add(S.warn, '失敗の扱い：' + t.handler, '失敗をつかまえているが、人に知らせず、投げ直してもいない見込み。失敗しても「実行数」では「完了」になる。',
        'つかまえたら知らせる（WitGas.notify）か、記録したあと投げ直す。', 'catch の中で何をしているかを目で見る。');
    } else {
      add(S.good, '失敗の扱い：' + t.handler, '失敗をつかまえて、知らせるか投げ直している。', '', '');
    }
  });
}

function gasInspectCheckWebApp_(add, functions) {
  ['doGet', 'doPost'].forEach(function (name) {
    if (functions.hasOwnProperty(name)) {
      add(GAS_INSPECT_STATES.look, 'ウェブアプリ：' + name, name + ' があるので、ウェブアプリとして公開している見込み。',
        '使っていないなら、公開を止める（「デプロイを管理」）。', '「デプロイを管理」で、誰として動き、誰がアクセスできるかを見る。');
    }
  });
}

function gasInspectCheckScopes_(add, scopes) {
  var S = GAS_INSPECT_STATES;
  if (!scopes) {
    add(S.look, '承認済みの権限', '承認済みの権限を読めなかった。', '', '「概要」の画面の「プロジェクトの OAuth スコープ」を見る。');
    return;
  }
  add(S.good, '承認済みの権限', scopes.length + ' 個（一つずつ下に出す）。', '', '');
  scopes.slice().sort().forEach(function (scope) {
    var mine = GAS_INSPECT.inspectScopes.indexOf(scope) >= 0
      ? '点検のために足したなら、後片付けで外す。' : '';
    if (GAS_INSPECT_BROAD_SCOPES.hasOwnProperty(scope)) {
      add(S.warn, '権限：' + gasInspectShortScope_(scope), '広い権限。' + GAS_INSPECT_BROAD_SCOPES[scope] + '。',
        '狭い権限で足りるなら appsscript.json の oauthScopes を書き換える。' + mine, '');
    } else {
      add(S.good, '権限：' + gasInspectShortScope_(scope), '', mine, '');
    }
  });
}

function gasInspectCheckTimeZone_(add, ss) {
  if (!ss) return;
  var script = gasInspectSafe_(function () { return Session.getScriptTimeZone(); });
  var sheet = gasInspectSafe_(function () { return ss.getSpreadsheetTimeZone(); });
  if (!script || !sheet) {
    add(GAS_INSPECT_STATES.look, 'タイムゾーン', 'タイムゾーンを読めなかった。', '', '「プロジェクトの設定」と、スプレッドシートの「設定」を見比べる。');
  } else if (script !== sheet) {
    add(GAS_INSPECT_STATES.warn, 'タイムゾーン', 'スクリプトは ' + script + '、スプレッドシートは ' + sheet + '。日付や時刻がずれることがある。',
      'どちらかに合わせる（ふつうは Asia/Tokyo）。', '');
  } else {
    add(GAS_INSPECT_STATES.good, 'タイムゾーン', 'スクリプトとスプレッドシートが同じ（' + script + '）。', '', '');
  }
}

/** 先方のプロジェクトに WitGas の部品が入っていれば、版がそろっているか */
function gasInspectCheckKit_(add, g) {
  var W = gasInspectSafe_(function () { return g.WitGas; });
  if (!W || typeof W !== 'object') return;
  var kit = typeof W.version === 'string' ? W.version : null;
  var differs = Object.keys(W).filter(function (k) {
    var v = W[k];
    return v && (typeof v === 'object' || typeof v === 'function') && typeof v.VERSION === 'string' && kit !== null && v.VERSION !== kit;
  });
  if (kit === null) {
    add(GAS_INSPECT_STATES.warn, '部品集 WitGas', '部品集の版（version.js）が入っていない。', 'version.js を足す。', '引き継ぎ書の「版」を見る。');
  } else if (differs.length > 0) {
    add(GAS_INSPECT_STATES.warn, '部品集 WitGas', '部品集の版（' + kit + '）と違う部品がある：' + differs.join('・') + '。入れ替え忘れの見込み。',
      '同じ版の部品にそろえる。', '');
  } else {
    add(GAS_INSPECT_STATES.good, '部品集 WitGas', '版 ' + kit + ' でそろっている。', '', '');
  }
}

function gasInspectHandover_(add, ss, g) {
  var W = gasInspectSafe_(function () { return g.WitGas; });
  try {
    var r = WitGas.handover.write({
      spreadsheet: ss,
      sheetName: GAS_INSPECT.handoverSheet,
      kit: W && typeof W === 'object' ? W : null,
      scopes: [],
      stopSteps: [
        'トリガーの画面で、止めたい関数のトリガーを消す（消す前に、この引き継ぎ書で関数名と種類を控える）。',
        'ウェブアプリとして公開していれば、「デプロイを管理」で公開を止める。'
      ]
    });
    add(GAS_INSPECT_STATES.good, '引き継ぎ書', '「' + r.sheetName + '」シートに書いた。' +
      (r.notes.length ? '読めなかったもの ' + r.notes.length + ' 件（シートの最後）。' : ''), '',
      '権限の理由と止め方を、先方と書き足す。');
    return r;
  } catch (e) {
    add(GAS_INSPECT_STATES.look, '引き継ぎ書', '書けなかった（' + (e && e.name ? e.name : 'Error') + '）。同じ名前の別のシートがある見込み。',
      '', '「' + GAS_INSPECT.handoverSheet + '」シートの名前を変えてから、もう一度点検する。');
    return null;
  }
}

// ---- 書く ----

/** 「点検結果」シート（なければ null）。同じ名前の別のシートなら投げる */
function gasInspectSheetOrRefuse_(ss) {
  var sheet = ss.getSheetByName(GAS_INSPECT.sheetName);
  if (sheet && sheet.getLastRow() > 0 && sheet.getRange(1, 1, 1, 1).getValues()[0][0] !== GAS_INSPECT.marker) {
    var e = new Error('「' + GAS_INSPECT.sheetName + '」という名前の別のシートがあるので、何も書きませんでした。そのシートの名前を変えてから、もう一度点検してください。');
    e.name = 'SheetInUseError';
    throw e;
  }
  return sheet;
}

function gasInspectWriteSheet_(ss, rows) {
  var sheet = gasInspectSheetOrRefuse_(ss);
  if (sheet && sheet.getLastRow() > 0) sheet.clearContents();
  var fresh = !sheet;
  if (!sheet) sheet = ss.insertSheet(GAS_INSPECT.sheetName);
  sheet.getRange(1, 1, rows.length, 5).setValues(rows.map(function (r) { return r.map(gasInspectCell_); }));
  sheet.getRange(1, 2, 1, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  if (fresh) {
    [140, 220, 420, 360, 360].forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });
  }
  return GAS_INSPECT.sheetName;
}

// ---- 小さな道具 ----

/** name から呼んでいる（名前が出てくる）先方の関数をたどり、中身をつなげる */
function gasInspectReachable_(name, functions) {
  var names = Object.keys(functions);
  var done = {};
  var queue = [name];
  var code = [];
  while (queue.length) {
    var n = queue.shift();
    if (done[n]) continue;
    done[n] = true;
    var src = functions[n];
    code.push(src);
    names.forEach(function (other) {
      if (!done[other] && new RegExp('\\b' + other.replace(/\$/g, '\\$') + '\\b').test(src)) queue.push(other);
    });
  }
  return code.join('\n');
}

function gasInspectCount_(rows) {
  var c = { good: 0, warn: 0, fix: 0, look: 0 };
  var keyOf = {};
  Object.keys(GAS_INSPECT_STATES).forEach(function (k) { keyOf[GAS_INSPECT_STATES[k]] = k; });
  rows.forEach(function (r) { c[keyOf[r[0]]]++; });
  return c;
}

function gasInspectSummary_(c) {
  var S = GAS_INSPECT_STATES;
  return S.fix + ' ' + c.fix + ' / ' + S.warn + ' ' + c.warn + ' / ' + S.look + ' ' + c.look + ' / ' + S.good + ' ' + c.good;
}

function gasInspectShortScope_(scope) {
  return String(scope).replace(/^https:\/\/www\.googleapis\.com\/auth\//, '');
}

function gasInspectClip_(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function gasInspectSafe_(fn) {
  try {
    return fn();
  } catch (e) {
    return null;
  }
}

function gasInspectCell_(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

/** ビルドしたファイルが外に出すもの（WIT_INSPECT） */
var WIT_INSPECT_API = {
  run: gasInspectRun_,
  VERSION: GAS_INSPECT_VERSION
};
