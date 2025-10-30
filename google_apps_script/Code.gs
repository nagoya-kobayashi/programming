/** Code.gs — Google Apps Script サーバロジック（全量）
 *  - セッション発行/検証/削除（60分有効）
 *  - 課題エディタ: saveTask / getTasks
 *  - 学習画面: コード保存 / 読み出し
 *  - SALT 認証: getSalt / getUserMeta / initPassword / login(拡張)
 *  - application/x-www-form-urlencoded の "+"→空白 復元および厳密デコード
 *
 * シート構成：
 *   userシート:    [ID, Password, ClassId, Number, SALT]
 *   sessionシート: [SessionId, UserId, ClassId, Number, LastActive]
 *   taskシート:    [TaskId, ParentId, IsFolder, Title, DescriptionHtml, HintHtml, AnswerCode, InitialCode]
 *   <UserID>シート:[TaskId, Code, Output, HintOpened, Submitted, SavedAt]
 */

const SPREADSHEET_ID = '<<1ZCYBcG9jqGHUzu0oUnWyY41wNhTZlug4oEIB4f3tWvo>>'; // ★必ず実IDに置換（または ScriptProperties で設定）
const TIMEZONE = 'Asia/Tokyo';
const SESSION_TTL_MINUTES = 0;

/* ===================== Entry Points ===================== */

function doGet(e) {
  try {
    const action = (e.parameter.action || '').trim();

    // 1) 明示アクション優先（順序が重要）
    if (action === 'getTasks')     return getTasks_(e);        // 課題一覧（エディタ/学習画面 共通・セッション任意）
    if (action === 'getSalt')      return getSalt_(e);         // SALT 取得
    if (action === 'getUserMeta')  return getUserMeta_(e);     // ユーザ存在/初期登録可否
    if (action === 'initPassword') return initPassword_(e);    // 初期パスワード登録
    if (action === 'login')        return login_(e);           // 認証（ハッシュ/平文 後方互換）
    if (action === 'logout')       return logout_(e);          // ログアウト
    if (action === 'ping')         return json_({status:'ok'}); // 疎通確認

    // 2) 旧来との互換: セッション検証用途（actionなし + session で呼ばれる）
    if (!action && e.parameter.session && !e.parameter.taskId) {
      return validateSessionEndpoint_(e);
    }

    // 3) 保存データ取得（GET）: 明示的に taskId があるときのみ！
    if (e.parameter.taskId && (e.parameter.session || e.parameter.id)) {
      return getSavedTaskForUser_(e);
    }

    // 4) ここまでに該当しない GET はエラー
    return json_({ status: 'error', message: 'Unknown action' });
  } catch (err) {
    return json_({ status: 'error', message: String(err) });
  }
}

function doPost(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  try {
    if (action === 'getTasks') return getTasks_(e);
    if (action === 'getUserSnapshot') return getUserSnapshot_(e);
    if (action === 'saveTask') return saveTask_(e);
    return saveUserCode_(e);
  } catch (err) {
    return json_({ status: 'error', message: String(err) });
  }
}


/* ===================== Utilities ===================== */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// openById → ScriptProperties → ActiveSpreadsheet の順にフォールバック
function openSs_() {
  try {
    if (SPREADSHEET_ID && !/^<</.test(SPREADSHEET_ID)) {
      return SpreadsheetApp.openById(SPREADSHEET_ID);
    }
  } catch (e) {
    console.error('[openSs_] openById(SPREADSHEET_ID) failed:', e);
  }
  try {
    const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (id) return SpreadsheetApp.openById(id);
  } catch (e) {
    console.error('[openSs_] openById(ScriptProperties.SPREADSHEET_ID) failed:', e);
  }
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) return ss;
  } catch (e) {
    console.error('[openSs_] getActiveSpreadsheet() failed:', e);
  }
  throw new Error('Spreadsheet open failed. Set a valid SPREADSHEET_ID (or ScriptProperties), then redeploy the Web App.');
}

function fmtDate_(d) { return Utilities.formatDate(d, TIMEZONE, 'yyyy/MM/dd HH:mm:ss'); }

function findHeaderMap_(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    const key = String(h || '').replace(/^\uFEFF/, '').trim().toLowerCase();
    map[key] = i;
  });
  return map;
}

// application/x-www-form-urlencoded の厳密デコード（+→空白）
function parseFormPost_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  const raw = e.postData.contents;
  const obj = {};
  raw.split('&').forEach(kv => {
    if (!kv) return;
    const [k, v=''] = kv.split('=');
    const key = decodeURIComponent(k.replace(/\+/g, ' '));
    const val = decodeURIComponent(v.replace(/\+/g, ' '));
    obj[key] = val;
  });
  return obj;
}

function toBool_(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y';
}

/* ===================== Session ===================== */

function validateSession_(sessionId) {
  if (!sessionId) return null;
  const ss = openSs_();
  let sh = ss.getSheetByName('session');
  if (!sh) return null;
  const rng = sh.getDataRange().getValues();
  if (rng.length < 2) return null;

  const header = findHeaderMap_(rng[0]);
  const sidCol = header['sessionid'];
  const uidCol = header['userid'];
  const clsCol = header['classid'];
  const numCol = header['number'];
  const actCol = header['lastactive'];

  for (let r = 1; r < rng.length; r++) {
    const row = rng[r];
    if (String(row[sidCol]) === String(sessionId)) {
      const last = row[actCol] ? new Date(row[actCol]) : null;
      const now = new Date();
      // TTL>0 のときのみ期限切れを判定。0以下は永続扱い。
      if (SESSION_TTL_MINUTES > 0) {
        if (last && (now - last) > SESSION_TTL_MINUTES * 60 * 1000) {
          sh.deleteRow(r + 1);
          return null;
        }
      }      sh.getRange(r + 1, actCol + 1).setValue(fmtDate_(now));
      return {
        sessionId: sessionId,
        userId: String(row[uidCol] || ''),
        classId: String(row[clsCol] || ''),
        number: String(row[numCol] || '')
      };
    }
  }
  return null;
}

function validateSessionEndpoint_(e) {
  const sid = (e.parameter.session || '').trim();
  const data = validateSession_(sid);
  if (!data) return json_({ status: 'error', message: 'Session expired' });
  return json_({ status: 'ok', userId: data.userId, classId: data.classId, number: data.number });
}

function removeSession_(sessionId) {
  const ss = openSs_();
  let sh = ss.getSheetByName('session');
  if (!sh) return;
  const rng = sh.getDataRange().getValues();
  const header = findHeaderMap_(rng[0]);
  const sidCol = header['sessionid'];
  for (let r = rng.length - 1; r >= 1; r--) {
    if (String(rng[r][sidCol]) === String(sessionId)) {
      sh.deleteRow(r + 1);
      return;
    }
  }
}

/* ===================== SALT-based Auth ===================== */

function getUserSheet_() {
  const ss = openSs_();
  const sh = ss.getSheetByName('user');
  if (!sh) throw new Error('user シートがありません');
  return sh;
}

// ID比較を堅牢に（大小無視・全角空白→半角・ゼロ幅除去・前後空白除去）
function _normalizeId_(s) {
  if (s == null) return '';
  return String(s)
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u3000/g, ' ')
    .trim()
    .toLowerCase();
}

function getUserRowById_(id) {
  const sh = getUserSheet_();
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return { sh, row: -1, header: {}, values };
  const header = findHeaderMap_(values[0]);
  const idCol = header['id'];
  if (idCol == null) return { sh, row: -1, header, values };
  const needle = _normalizeId_(id);
  for (let r = 1; r < values.length; r++) {
    if (_normalizeId_(values[r][idCol]) === needle) {
      return { sh, row: r + 1, header, values }; // 1-indexed
    }
  }
  return { sh, row: -1, header, values };
}

function getSalt_(e) {
  const id = (e.parameter.id || '').trim();
  if (!id) return json_({ status: 'error', message: 'missing id' });
  const meta = getUserRowById_(id);
  if (meta.row < 0) return json_({ status: 'ok', exists: false, message: 'user not found' });

  const saltCol = meta.header['salt'];
  const salt = saltCol != null ? (meta.values[meta.row - 1][saltCol] || '') : '';
  if (!salt) return json_({ status: 'error', message: 'SALT 未設定です（登録ページから初期設定してください）' });
  return json_({ status: 'ok', salt: String(salt) });
}

function getUserMeta_(e) {
  const id = (e.parameter.id || '').trim();
  if (!id) return json_({ status: 'error', message: 'missing id' });
  const meta = getUserRowById_(id);
  if (meta.row < 0) return json_({ status: 'ok', exists: false });

  const row = meta.values[meta.row - 1];
  const pwCol = meta.header['password'];
  const clsCol = meta.header['classid'];
  const numCol = meta.header['number'];
  const saltCol = meta.header['salt'];

  const password = pwCol != null ? (row[pwCol] || '') : '';
  const classId = clsCol != null ? (row[clsCol] || '') : '';
  const number = numCol != null ? (row[numCol] || '') : '';
  const salt = saltCol != null ? (row[saltCol] || '') : '';

  const passwordSet = String(password).trim() !== '';

  return json_({
    status: 'ok',
    exists: true,
    passwordSet: passwordSet,
    classId: String(classId),
    number: String(number),
    salt: String(salt || '')
  });
}

function initPassword_(e) {
  const id = (e.parameter.id || '').trim();
  const salt = (e.parameter.salt || '').trim();
  const passwordHash = (e.parameter.passwordHash || '').trim();
  if (!id || !salt || !passwordHash) return json_({ status: 'error', message: 'missing params' });

  const meta = getUserRowById_(id);
  if (meta.row < 0) return json_({ status: 'error', message: 'user not found' });

  const rowIdx = meta.row;
  const pwCol = meta.header['password'];
  const saltCol = meta.header['salt'];

  const currentPw = pwCol != null ? (meta.values[rowIdx - 1][pwCol] || '') : '';
  if (String(currentPw).trim() !== '') {
    return json_({ status: 'error', message: 'すでにパスワードが設定済みです' });
  }
  if (saltCol == null || pwCol == null) {
    return json_({ status: 'error', message: 'user シートに SALT または Password 列がありません' });
  }
  const sh = meta.sh;
  sh.getRange(rowIdx, saltCol + 1).setValue(salt);
  sh.getRange(rowIdx, pwCol + 1).setValue(passwordHash);
  return json_({ status: 'ok' });
}

/* ===================== Login / Logout ===================== */

function login_(e) {
  const id = (e.parameter.id || '').trim();
  const passwordPlain = (e.parameter.password || '');      // 後方互換
  const passwordHash = (e.parameter.passwordHash || '');   // 新方式
  if (!id) return json_({ status: 'error', message: 'missing id' });

  const meta = getUserRowById_(id);
  if (meta.row < 0) return json_({ status: 'error', message: 'Login failed' });

  const row = meta.values[meta.row - 1];
  const pwCol = meta.header['password'];
  const clsCol = meta.header['classid'];
  const numCol = meta.header['number'];

  const savedPw = pwCol != null ? String(row[pwCol] || '') : '';
  const classId = clsCol != null ? String(row[clsCol] || '') : '';
  const number = numCol != null ? String(row[numCol] || '') : '';

  // 比較（passwordHash を優先）
  let ok = false;
  if (passwordHash) {
    ok = (savedPw && savedPw === passwordHash);
  } else if (passwordPlain) {
    ok = (savedPw && savedPw === passwordPlain);
  }
  if (!ok) return json_({ status: 'error', message: 'Login failed' });

  // 既存セッションの使い回し（同一ユーザの最新を優先）
  const ss = openSs_();
  let sh = ss.getSheetByName('session');
  if (!sh) sh = ss.insertSheet('session');
  if (sh.getLastRow() === 0) {
    sh.appendRow(['SessionId','UserId','ClassId','Number','LastActive']);
  }
  const all = sh.getDataRange().getValues();
  const header = findHeaderMap_(all[0]);
  const sidCol = header['sessionid'];
  const uidCol = header['userid'];
  const actCol = header['lastactive'];
  const needle = _normalizeId_(id);
  let existing = '';
  for (let r = all.length - 1; r >= 1; r--) {
    if (_normalizeId_(all[r][uidCol]) === needle) { existing = String(all[r][sidCol] || ''); break; }
  }
  let sessionId = existing || Utilities.getUuid();
  if (!existing) {
    sh.appendRow([sessionId, needle, classId, number, fmtDate_(new Date())]);
  } else {
    // 使い回す場合も最終アクセスを更新
    for (let r = all.length - 1; r >= 1; r--) {
      if (String(all[r][sidCol]) === sessionId) {
        sh.getRange(r + 1, actCol + 1).setValue(fmtDate_(new Date()));
        break;
      }
    }
  }

  return json_({ status: 'ok', sessionId: sessionId, userId: id, classId: classId, number: number });
}

function logout_(e) {
  const sid = (e.parameter.session || '').trim();
  if (sid) removeSession_(sid);
  return json_({ status: 'ok' });
}

/* ===================== Task (課題) ===================== */

function getTasks_(e) {
  const ss = openSs_();
  const sh = ss.getSheetByName('task');
  if (!sh) return json_({ status: 'error', message: 'task シートがありません' });
  const values = sh.getDataRange().getValues();
  if (values.length < 1) return json_({ status: 'ok', tasks: [] });
  // そのまま返す（ヘッダ + 行）…クライアントでヘッダを用いて列名参照
  return json_({ status: 'ok', tasks: values });
}

function saveTask_(e) {
  // URLエンコードボディを厳密復号
  const body = parseFormPost_(e);

  // セッション任意（授業運用に合わせる）：sid が来たら検証
  const sid = (body.session || body.sessionId || '').trim();
  if (sid && !validateSession_(sid)) {
    return json_({ status: 'error', message: 'Session expired' });
  }

  const taskId = (body.TaskId || '').trim();
  const parentId = (body.ParentId || '').trim();
  const isFolder = toBool_(body.IsFolder);
  const title = body.Title || '';
  const descriptionHtml = body.DescriptionHtml || '';
  const hintHtml = body.HintHtml || '';
  const answerCode = body.AnswerCode || '';
  const initialCode = body.InitialCode || '';

  const ss = openSs_();
  let sh = ss.getSheetByName('task');
  if (!sh) sh = ss.insertSheet('task');
  if (sh.getLastRow() === 0) {
    sh.appendRow(['TaskId','ParentId','IsFolder','Title','DescriptionHtml','HintHtml','AnswerCode','InitialCode']);
  }
  const rng = sh.getDataRange().getValues();
  const header = findHeaderMap_(rng[0]);
  const tidCol = header['taskid'];
  const pidCol = header['parentid'];
  const isfCol = header['isfolder'];
  const ttlCol = header['title'];
  const descCol= header['descriptionhtml'];
  const hintCol= header['hinthtml'];
  const ansCol = header['answercode'];
  const initCol= header['initialcode'];

  let rowIdx = -1;
  if (taskId) {
    for (let r = 1; r < rng.length; r++) {
      if (String(rng[r][tidCol]) === String(taskId)) {
        rowIdx = r + 1; break;
      }
    }
  }
  let newTaskId = taskId;
  if (rowIdx < 0 && !newTaskId) {
    newTaskId = 'T' + Utilities.getUuid().slice(0,8);
  }

  if (rowIdx < 0) {
    sh.appendRow([ newTaskId, parentId, isFolder, title, descriptionHtml, hintHtml, answerCode, initialCode ]);
  } else {
    const row = rowIdx;
    sh.getRange(row, tidCol + 1).setValue(taskId);
    sh.getRange(row, pidCol + 1).setValue(parentId);
    sh.getRange(row, isfCol + 1).setValue(isFolder);
    sh.getRange(row, ttlCol + 1).setValue(title);
    sh.getRange(row, descCol + 1).setValue(descriptionHtml);
    sh.getRange(row, hintCol + 1).setValue(hintHtml);
    sh.getRange(row, ansCol + 1).setValue(answerCode);
    sh.getRange(row, initCol + 1).setValue(initialCode);
  }

  return json_({ status: 'ok', taskId: (rowIdx < 0 ? newTaskId : taskId) });
}

/* ===================== 学習画面：コード保存/取得 ===================== */

function getUserCodeSheet_(userId) {
  const ss = openSs_();
  let sh = ss.getSheetByName(userId);
  if (!sh) {
    sh = ss.insertSheet(userId);
    sh.appendRow(['TaskId','Code','Output','HintOpened','Submitted','SavedAt']);
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(['TaskId','Code','Output','HintOpened','Submitted','SavedAt']);
  }
  return sh;
}

function getSavedTaskForUser_(e) {
  const sid = (e.parameter.session || '').trim();
  let userId = (e.parameter.id || '').trim();
  const taskId = (e.parameter.taskId || '').trim();

  if (!taskId) return json_({ status: 'error', message: 'missing taskId' });

  // セッション優先
  if (sid) {
    const ses = validateSession_(sid);
    if (!ses) return json_({ status: 'error', message: 'Session expired' });
    userId = ses.userId;
  }
  if (!userId) return json_({ status: 'error', message: 'missing user' });

  const sh = getUserCodeSheet_(userId);
  const rng = sh.getDataRange().getValues();
  const header = findHeaderMap_(rng[0]);
  const tidCol = header['taskid'];
  const codeCol= header['code'];
  const outCol = header['output'];
  const hintCol= header['hintopened'];
  const subCol = header['submitted'];

  for (let r = 1; r < rng.length; r++) {
    const row = rng[r];
    if (String(row[tidCol]) === String(taskId)) {
      const code = String(row[codeCol] || '');
      const output = String(row[outCol] || '');
      const hintOpened = String(row[hintCol] || '').toLowerCase() === 'true';
      const submitted = String(row[subCol] || '').toLowerCase() === 'true';
      return json_({ status: 'ok', data: { code, output, hintOpened, submitted } });
    }
  }
  return json_({ status: 'ok', data: { code: '', output: '', hintOpened: false, submitted: false } });
}

/**
 * 可能なら既存のSS取得ヘルパを利用し、無い場合のみフォールバック。
 */
function getSpreadsheetSafe_() {
  // 既存のヘルパがあればそれを使用（例：getSpreadsheet_ / openSpreadsheet_ など）
  if (typeof getSpreadsheet_ === 'function') return getSpreadsheet_();
  if (typeof openSpreadsheet_ === 'function') return openSpreadsheet_();
  if (typeof getSS_ === 'function') return getSS_();
  // フォールバック：グローバル定数 or スクリプトプロパティから取得
  var id = (typeof SPREADSHEET_ID !== 'undefined' && SPREADSHEET_ID) ||
           (PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || '');
  if (!id) throw new Error('SPREADSHEET_ID not set');
  return SpreadsheetApp.openById(id);
}

// 既存実装に極力寄せた「安全なSS取得」ルート
function _getSpreadsheetSafe_() {
  // 1) コンテナバインドなら最速・最安全
  try {
    var as = SpreadsheetApp.getActiveSpreadsheet();
    if (as) return as;
  } catch(_) {}
  // 2) 既存ヘルパ（プロジェクト内にある想定の関数名を順に試す）
  try { if (typeof getSpreadsheet_     === 'function') return getSpreadsheet_(); }     catch(_) {}
  try { if (typeof openSpreadsheet_    === 'function') return openSpreadsheet_(); }    catch(_) {}
  try { if (typeof getSS_              === 'function') return getSS_(); }              catch(_) {}
  try { if (typeof getSpreadsheet      === 'function') return getSpreadsheet(); }      catch(_) {}
  // 3) Script Properties → グローバル定数 → 最後に openById
  var id = '';
  try { id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || ''; } catch(_) {}
  if (!id && typeof SPREADSHEET_ID !== 'undefined') id = SPREADSHEET_ID;
  if (!id) throw new Error('SPREADSHEET_ID not set (ScriptProperties or global).');
  return SpreadsheetApp.openById(id);
}

/**
 * getUserSnapshot_
 *  セッションを検証し、taskシートの全件（ヘッダ含む）と、
 *  ユーザー個別シート（<UserID>）に保存されている code/output/hintOpened/submitted/savedAt を
 *  まとめて返す。既存APIには影響しない新規エンドポイント。
 */
function getUserSnapshot_(e) {
  try { Logger.log('getUserSnapshot_ start, session=' + (e && e.parameter && e.parameter.session)); } catch(_) {}
  const sessionId = (e && e.parameter && e.parameter.session) || '';
  const sess = validateSession_(sessionId); // {userId, classId, number} 想定
  try { Logger.log('validated userId=' + (sess && sess.userId)); } catch(_) {}
  if (!sess || !sess.userId) throw new Error('Invalid session');

  // 既存ルートに寄せて取得（openByIdは最後の手段）
  const ss = _getSpreadsheetSafe_();
  try { Logger.log('spreadsheet name=' + ss.getName()); } catch(_) {}

  // tasks（既存 getTasks_ と同等の形式：ヘッダ行＋明細行）
  const taskSh = ss.getSheetByName('task');
  if (!taskSh) throw new Error('task sheet not found');
  const tasks = taskSh.getDataRange().getValues();

  // states（ユーザー個別シート <UserID>）
  const states = {};
  const userSh = ss.getSheetByName(sess.userId);
  if (userSh) {
    const data = userSh.getDataRange().getValues();
    if (data && data.length > 1) {
      const header = data[0];
      const idx = {};
      for (var i = 0; i < header.length; i++) idx[String(header[i])] = i;
      // 大小両対応（後方互換）
      const idxTaskId    = (idx.taskId ?? idx.TaskId);
      const idxCode      = (idx.code ?? idx.Code);
      const idxOutput    = (idx.output ?? idx.Output);
      const idxHint      = (idx.hintOpened ?? idx.HintOpened);
      const idxSubmitted = (idx.submitted ?? idx.Submitted);
      const idxSavedAt   = (idx.savedAt ?? idx.SavedAt);
      for (var r = 1; r < data.length; r++) {
        var row = data[r];
        var tId = String((idxTaskId != null ? row[idxTaskId] : '') || '');
        if (!tId) continue;
        states[tId] = {
          code:      (idxCode != null ? row[idxCode] : ''),
          output:    (idxOutput != null ? row[idxOutput] : ''),
          hintOpened:(idxHint != null ? row[idxHint] : false),
          submitted: (idxSubmitted != null ? row[idxSubmitted] : false),
          savedAt:   (idxSavedAt != null ? row[idxSavedAt] : '')
        };
      }
    }
  }

  // ★ 未アクセス課題の既定状態を埋める（code/output/savedAt 空、hintOpened/submitted false）
  //    → main.html 側で全課題についてローカル状態がヒットし、サーバ読み込みをスキップ可能にする
  if (tasks && tasks.length > 1) {
    var tHeader = tasks[0], th = {};
    for (var j=0; j<tHeader.length; j++) th[String(tHeader[j])] = j;
    var idxTId = (th.taskId ?? th.TaskId);
    var idxIsFolder = (th.isFolder ?? th.IsFolder);
    for (var k=1; k<tasks.length; k++) {
      var tRow = tasks[k];
      var tid = String((idxTId != null ? tRow[idxTId] : '') || '');
      if (!tid) continue;
      // フォルダ行はスキップ（必要ならコメントアウトして全行に付与してもよい）
      var isFolder = false;
      if (idxIsFolder != null) {
        var v = tRow[idxIsFolder];
        // GASの真偽値/文字列TRUE両対応
        isFolder = (v === true || String(v).toUpperCase() === 'TRUE');
      }
      if (isFolder) continue;
      if (!states.hasOwnProperty(tid)) {
        states[tid] = { code:'', output:'', hintOpened:false, submitted:false, savedAt:'' };
      }
    }
  }

  return ContentService.createTextOutput(JSON.stringify({status:'ok', tasks: tasks, states: states}))
    .setMimeType(ContentService.MimeType.JSON);
}

function saveUserCode_(e) {
  const body = parseFormPost_(e);

  const sid = (body.session || '').trim();
  let userId = (body.id || '').trim(); // セッションがなければ ID 直指定も許可（環境要件）
  const taskId = (body.taskId || '').trim();
  const code = String(body.code || '');
  const output = String(body.output || '');
  const hintOpened = toBool_(body.hintOpened);
  const submitted = toBool_(body.submitted);

  if (!taskId) return json_({ status: 'error', message: 'missing taskId' });

  if (sid) {
    const ses = validateSession_(sid);
    if (!ses) return json_({ status: 'error', message: 'Session expired' });
    userId = ses.userId;
  }
  if (!userId) return json_({ status: 'error', message: 'missing user' });

  const sh = getUserCodeSheet_(userId);
  const rng = sh.getDataRange().getValues();
  const header = findHeaderMap_(rng[0]);
  const tidCol = header['taskid'];
  const codeCol= header['code'];
  const outCol = header['output'];
  const hintCol= header['hintopened'];
  const subCol = header['submitted'];
  const savedCol = header['savedat'];

  let rowIdx = -1;
  for (let r = 1; r < rng.length; r++) {
    if (String(rng[r][tidCol]) === String(taskId)) { rowIdx = r + 1; break; }
  }
  const now = fmtDate_(new Date());
  if (rowIdx < 0) {
    sh.appendRow([ taskId, code, output, hintOpened, submitted, now ]);
  } else {
    sh.getRange(rowIdx, codeCol + 1).setValue(code);
    sh.getRange(rowIdx, outCol + 1).setValue(output);
    sh.getRange(rowIdx, hintCol + 1).setValue(hintOpened);
    sh.getRange(rowIdx, subCol + 1).setValue(submitted);
    sh.getRange(rowIdx, savedCol + 1).setValue(now);
  }
  return json_({ status: 'ok' });
}



