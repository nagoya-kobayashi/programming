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
const SUBMISSION_SUMMARY_SHEET = 'submission_summary';
const TASK_ATTRIBUTE_LABELS = ['基礎', '演習', '発展', 'その他'];

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
    if (action === 'getSubmissionSummary') return getSubmissionSummary_(e); // 集計済みシート取得

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
    if (action === 'getClassSubmissions') return getClassSubmissions_(e);
    if (action === 'saveScores') return saveScores_(e);
    if (action === 'getSubmissionSummary') return getSubmissionSummary_(e);
    if (action === 'buildSubmissionSummary') return buildSubmissionSummary_(e);
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

function normalizeSavedAtValue_(value) {
  if (value == null) return '';
  if (value instanceof Date) return fmtDate_(value);
  const s = String(value || '').trim();
  return s;
}

function isSavedAtNewerOrEqual_(savedAt, threshold) {
  if (!threshold) return true;
  if (!savedAt) return false;
  return savedAt >= threshold;
}

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

function normalizeTaskAttributeValue_(raw) {
  const s = String(raw || '').replace(/\s+/g, '').trim();
  if (!s) return '';
  const hit = TASK_ATTRIBUTE_LABELS.find(label => label === s);
  return hit || '';
}

function guessAttributeFromFolderName_(name) {
  const s = String(name || '').trim().toLowerCase();
  if (!s) return '';
  if (s.includes('基礎') || /^\(?\s*1/.test(s)) return '基礎';
  if (s.includes('演習') || /^\(?\s*2/.test(s)) return '演習';
  if (s.includes('発展') || /^\(?\s*3/.test(s)) return '発展';
  if (s.includes('その他')) return 'その他';
  return '';
}

function deriveAttributeFromPath_(taskId, pathMap) {
  const path = pathMap && pathMap[String(taskId)] ? String(pathMap[String(taskId)]) : '';
  if (!path) return 'その他';
  const parts = path.split(' / ').filter(Boolean);
  const second = parts.length >= 2 ? parts[1] : (parts[0] || '');
  const guessed = guessAttributeFromFolderName_(second);
  return guessed || 'その他';
}

function ensureTaskHeader_(sh) {
  if (!sh) return {};
  if (sh.getLastRow() === 0) {
    sh.appendRow(['TaskId','ParentId','IsFolder','Title','Attribute','DescriptionHtml','HintHtml','AnswerCode','InitialCode']);
  } else {
    const lastCol = sh.getLastColumn();
    const headerValues = sh.getRange(1, 1, 1, lastCol).getValues()[0] || [];
    const headerMap = findHeaderMap_(headerValues);
    if (headerMap['attribute'] == null) {
      sh.getRange(1, lastCol + 1).setValue('Attribute');
    }
  }
  const refreshed = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] || [];
  return findHeaderMap_(refreshed);
}

function buildTaskRecords_(values, header) {
  const tidCol = header['taskid'];
  const pidCol = header['parentid'];
  const ttlCol = header['title'];
  const isfCol = header['isfolder'];
  const records = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const taskId = tidCol != null ? String(row[tidCol] || '') : '';
    if (!taskId) continue;
    records.push({
      taskId,
      parentId: pidCol != null ? String(row[pidCol] || '') : '',
      title: ttlCol != null ? String(row[ttlCol] || '') : taskId,
      isFolder: isfCol != null ? toBool_(row[isfCol]) : false
    });
  }
  return records;
}

function ensureTaskAttributes_(sh, values, header) {
  if (!values || values.length < 1) return values;
  const attrCol = header['attribute'];
  const tidCol = header['taskid'];
  const isfCol = header['isfolder'];
  if (attrCol == null || tidCol == null) return values;

  const records = buildTaskRecords_(values, header);
  const pathMap = buildTaskPathMap_(records);
  const colValues = [];
  let changed = false;

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const taskId = String(row[tidCol] || '');
    const isFolder = isfCol != null ? toBool_(row[isfCol]) : false;
    const explicit = normalizeTaskAttributeValue_(row[attrCol]);
    let resolved = explicit;
    if (!resolved && !isFolder) {
      resolved = deriveAttributeFromPath_(taskId, pathMap);
    } else if (!resolved && isFolder) {
      resolved = '';
    }
    if (!resolved && !isFolder) resolved = 'その他';
    const next = resolved || '';
    if (next !== String(row[attrCol] || '')) {
      values[r][attrCol] = next;
      changed = true;
    }
    colValues.push([values[r][attrCol] || '']);
  }

  if (changed) {
    sh.getRange(2, attrCol + 1, colValues.length, 1).setValues(colValues);
  }
  return values;
}

function loadTaskSheetWithAttributes_() {
  const ss = openSs_();
  const sh = ss.getSheetByName('task');
  if (!sh) return { sheet: null, header: {}, values: [] };
  const header = ensureTaskHeader_(sh);
  let values = sh.getDataRange().getValues();
  if (values.length > 0) {
    values = ensureTaskAttributes_(sh, values, header);
  }
  const refreshedHeader = values.length ? findHeaderMap_(values[0]) : header;
  return { sheet: sh, header: refreshedHeader, values };
}

function getTasks_(e) {
  const { sheet: sh, values } = loadTaskSheetWithAttributes_();
  if (!sh) return json_({ status: 'error', message: 'task シートがありません' });
  if (!values || values.length < 1) return json_({ status: 'ok', tasks: [] });
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
  const { sheet: sh, header, values } = loadTaskSheetWithAttributes_();
  if (!sh) return json_({ status: 'error', message: 'task シートがありません' });

  const tidCol = header['taskid'];
  const pidCol = header['parentid'];
  const isfCol = header['isfolder'];
  const ttlCol = header['title'];
  const attrCol = header['attribute'];
  const descCol= header['descriptionhtml'];
  const hintCol= header['hinthtml'];
  const ansCol = header['answercode'];
  const initCol= header['initialcode'];

  let rowIdx = -1;
  if (taskId && values && values.length) {
    for (let r = 1; r < values.length; r++) {
      if (String(values[r][tidCol]) === String(taskId)) {
        rowIdx = r + 1; break;
      }
    }
  }
  let newTaskId = taskId;
  if (rowIdx < 0 && !newTaskId) {
    newTaskId = 'T' + Utilities.getUuid().slice(0,8);
  }

  const recordsForPath = buildTaskRecords_(values || [], header);
  const explicitAttr = normalizeTaskAttributeValue_(body.Attribute || body.attribute || '');
  const pendingRecord = {
    taskId: newTaskId,
    parentId: parentId,
    title: title || newTaskId,
    isFolder: isFolder
  };
  const existingIdx = recordsForPath.findIndex(r => r.taskId === pendingRecord.taskId);
  if (existingIdx >= 0) recordsForPath[existingIdx] = pendingRecord; else recordsForPath.push(pendingRecord);
  const pathMap = buildTaskPathMap_(recordsForPath);
  let resolvedAttr = explicitAttr;
  if (!resolvedAttr && !isFolder) resolvedAttr = deriveAttributeFromPath_(pendingRecord.taskId, pathMap);
  if (!resolvedAttr && !isFolder) resolvedAttr = 'その他';
  if (isFolder && !resolvedAttr) resolvedAttr = '';

  if (rowIdx < 0) {
    const row = [];
    row[tidCol] = newTaskId;
    row[pidCol] = parentId;
    row[isfCol] = isFolder;
    row[ttlCol] = title;
    if (attrCol != null) row[attrCol] = resolvedAttr;
    row[descCol] = descriptionHtml;
    row[hintCol] = hintHtml;
    row[ansCol] = answerCode;
    row[initCol]= initialCode;
    sh.appendRow(row);
  } else {
    const row = rowIdx;
    sh.getRange(row, tidCol + 1).setValue(newTaskId);
    sh.getRange(row, pidCol + 1).setValue(parentId);
    sh.getRange(row, isfCol + 1).setValue(isFolder);
    sh.getRange(row, ttlCol + 1).setValue(title);
    if (attrCol != null) sh.getRange(row, attrCol + 1).setValue(resolvedAttr);
    sh.getRange(row, descCol + 1).setValue(descriptionHtml);
    sh.getRange(row, hintCol + 1).setValue(hintHtml);
    sh.getRange(row, ansCol + 1).setValue(answerCode);
    sh.getRange(row, initCol + 1).setValue(initialCode);
  }

  return json_({ status: 'ok', taskId: (rowIdx < 0 ? newTaskId : taskId) });
}

/* ===================== 学習画面：コード保存/取得 ===================== */

const USER_CODE_HEADER = ['TaskId','Code','Output','HintOpened','Submitted','SavedAt','Score','Comment'];

function ensureUserCodeHeader_(sh) {
  if (!sh) return;
  if (sh.getLastRow() === 0) {
    sh.appendRow(USER_CODE_HEADER);
    return;
  }
  const lastCol = Math.max(sh.getLastColumn(), USER_CODE_HEADER.length);
  const headerRange = sh.getRange(1, 1, 1, lastCol);
  const headerValues = headerRange.getValues()[0] || [];
  const existing = headerValues.map(v => String(v || '').trim().toLowerCase());
  let writeCol = sh.getLastColumn();
  USER_CODE_HEADER.forEach(label => {
    const lower = label.toLowerCase();
    if (!existing.includes(lower)) {
      writeCol += 1;
      sh.getRange(1, writeCol).setValue(label);
      existing.push(lower);
    }
  });
}

function getUserCodeSheet_(userId) {
  const ss = openSs_();
  let sh = ss.getSheetByName(userId);
  if (!sh) {
    sh = ss.insertSheet(userId);
  }
  ensureUserCodeHeader_(sh);
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

  const states = readUserTaskStates_(userId, '');
  const state = states[String(taskId)] || { code:'', output:'', hintOpened:false, submitted:false, score:'', comment:'', savedAt:'' };
  return json_({
    status: 'ok',
    data: {
      code: String(state.code || ''),
      output: String(state.output || ''),
      hintOpened: !!state.hintOpened,
      submitted: !!state.submitted,
      savedAt: state.savedAt || '',
      score: state.score ?? '',
      comment: state.comment || ''
    }
  });
}

function readUserTaskStates_(userId, minSavedAt) {
  const ss = openSs_();
  const sh = ss.getSheetByName(userId);
  if (!sh) return {};
  ensureUserCodeHeader_(sh);
  const rng = sh.getDataRange().getValues();
  if (!rng || rng.length < 2) return {};
  const header = findHeaderMap_(rng[0]);
  const tidCol = header['taskid'];
  if (tidCol == null) return {};
  const codeCol = header['code'];
  const outCol = header['output'];
  const hintCol = header['hintopened'];
  const subCol = header['submitted'];
  const savedCol = header['savedat'];
  const scoreCol = header['score'];
  const commentCol = header['comment'];
  const threshold = normalizeSavedAtValue_(minSavedAt);

  const states = {};
  for (let r = 1; r < rng.length; r++) {
    const row = rng[r];
    const taskId = String((tidCol != null ? row[tidCol] : '') || '').trim();
    if (!taskId) continue;
    const rawScore = scoreCol != null ? row[scoreCol] : '';
    let scoreValue = '';
    if (rawScore !== '' && rawScore != null) {
      const numeric = Number(rawScore);
      scoreValue = isNaN(numeric) ? rawScore : numeric;
    }
    const savedAtRaw = savedCol != null ? row[savedCol] : '';
    const normalizedSavedAt = normalizeSavedAtValue_(savedAtRaw);
    if (threshold && !isSavedAtNewerOrEqual_(normalizedSavedAt, threshold)) {
      continue;
    }
    states[taskId] = {
      code: codeCol != null ? (row[codeCol] || '') : '',
      output: outCol != null ? (row[outCol] || '') : '',
      hintOpened: hintCol != null ? toBool_(row[hintCol]) : false,
      submitted: subCol != null ? toBool_(row[subCol]) : false,
      savedAt: normalizedSavedAt,
      score: scoreValue,
      comment: commentCol != null ? String(row[commentCol] || '') : ''
    };
  }
  return states;
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
  ensureTaskHeader_(taskSh);
  let tasks = taskSh.getDataRange().getValues();
  if (tasks && tasks.length > 0) {
    const header = findHeaderMap_(tasks[0]);
    tasks = ensureTaskAttributes_(taskSh, tasks, header);
  }

  // states（ユーザー個別シート <UserID>）
  const states = readUserTaskStates_(sess.userId, '');


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
          states[tid] = { code:'', output:'', hintOpened:false, submitted:false, savedAt:'', score:'', comment:'' };
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
    sh.appendRow([ taskId, code, output, hintOpened, submitted, now, '', '' ]);
  } else {
    sh.getRange(rowIdx, codeCol + 1).setValue(code);
    sh.getRange(rowIdx, outCol + 1).setValue(output);
    sh.getRange(rowIdx, hintCol + 1).setValue(hintOpened);
    sh.getRange(rowIdx, subCol + 1).setValue(submitted);
    sh.getRange(rowIdx, savedCol + 1).setValue(now);
  }
  return json_({ status: 'ok' });
}

/* ===================== 採点用エンドポイント ===================== */

function getClassSubmissions_(e) {
  const body = parseFormPost_(e);
  let targetClass = (body.classId || '').trim();
  const userIdParam = (body.userId || '').trim();
  const lastLoadedAt = normalizeSavedAtValue_(body.lastLoadedAt || '');
  const requestAll = targetClass.toUpperCase() === 'ALL';
  if (requestAll) {
    targetClass = 'ALL';
  }

  const sh = getUserSheet_();
  const values = sh.getDataRange().getValues();
  if (!values || values.length < 2) {
    return json_({ status: 'error', message: 'user sheet empty' });
  }

  const header = findHeaderMap_(values[0]);
  const idCol = header['id'];
  const classCol = header['classid'];
  const numberCol = header['number'];
  if (idCol == null || classCol == null) {
    return json_({ status: 'error', message: 'user sheet missing id/class columns' });
  }

  let resolvedUserId = '';
  if (!targetClass && userIdParam) {
    const needle = _normalizeId_(userIdParam);
    for (let r = 1; r < values.length; r++) {
      if (_normalizeId_(values[r][idCol]) === needle) {
        targetClass = String(values[r][classCol] || '').trim();
        resolvedUserId = String(values[r][idCol] || '');
        break;
      }
    }
  }
  targetClass = targetClass.trim();
  if (!targetClass) {
    return json_({ status: 'error', message: 'missing classId or userId' });
  }

  const students = [];
  const normalizedUserIdNeedle = userIdParam ? _normalizeId_(userIdParam) : '';
  for (let r = 1; r < values.length; r++) {
    const rowClass = classCol != null ? String(values[r][classCol] || '').trim() : '';
    if (!requestAll && rowClass !== targetClass) continue;
    const userId = idCol != null ? String(values[r][idCol] || '') : '';
    const number = numberCol != null ? String(values[r][numberCol] || '') : '';
    if (!resolvedUserId && normalizedUserIdNeedle && _normalizeId_(values[r][idCol]) === normalizedUserIdNeedle) {
      resolvedUserId = userId;
    }
    students.push({ userId, number, classId: rowClass || targetClass });
  }
  students.sort((a, b) => {
    if (requestAll) {
      const clsCmp = String(a.classId || '').localeCompare(String(b.classId || ''));
      if (clsCmp !== 0) return clsCmp;
    }
    const na = parseInt(a.number, 10);
    const nb = parseInt(b.number, 10);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return String(a.number || '').localeCompare(String(b.number || ''));
  });

  const submissions = {};
  const { values: taskValues, header: taskHeader } = loadTaskSheetWithAttributes_();
  const filteredTasks = taskValues && taskValues.length ? [taskValues[0]] : [];
  const allowedTaskIds = new Set();
  if (taskValues && taskValues.length > 1) {
    const tidCol = taskHeader['taskid'];
    const isfCol = taskHeader['isfolder'];
    const attrCol = taskHeader['attribute'];
    for (let r = 1; r < taskValues.length; r++) {
      const row = taskValues[r];
      const isFolder = isfCol != null ? toBool_(row[isfCol]) : false;
      const attr = attrCol != null ? normalizeTaskAttributeValue_(row[attrCol]) : '';
      if (!isFolder && attr === 'その他') continue;
      filteredTasks.push(row);
      if (!isFolder && tidCol != null) {
        const tid = String(row[tidCol] || '');
        if (tid) allowedTaskIds.add(tid);
      }
    }
  }
  const filterStates = (states) => {
    if (!allowedTaskIds.size) return states;
    const result = {};
    Object.entries(states || {}).forEach(([tid, payload]) => {
      if (allowedTaskIds.has(String(tid))) result[tid] = payload;
    });
    return result;
  };
  students.forEach(stu => {
    const userStates = readUserTaskStates_(stu.userId, lastLoadedAt);
    const trimmed = filterStates(userStates);
    if (!lastLoadedAt || Object.keys(trimmed).length > 0) {
      submissions[stu.userId] = trimmed;
    }
  });

  const fetchedAt = fmtDate_(new Date());

  return json_({
    status: 'ok',
    classId: targetClass,
    resolvedUserId,
    fetchedAt,
    students,
    tasks: filteredTasks,
    submissions
  });
}

function saveScores_(e) {
  const body = parseFormPost_(e);
  let entries = [];
  if (body.entries) {
    try { entries = JSON.parse(body.entries); } catch (_) { entries = []; }
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return json_({ status: 'error', message: 'no entries' });
  }

  const savedEntries = [];
  let updated = 0;
  for (const entry of entries) {
    if (!entry) continue;
    const userId = String(entry.userId || '').trim();
    const taskId = String(entry.taskId || '').trim();
    if (!userId || !taskId) continue;
    const comment = entry.comment != null ? String(entry.comment) : '';
    const scoreInput = entry.score;

    const sh = getUserCodeSheet_(userId);
    const rng = sh.getDataRange().getValues();
    if (!rng || rng.length === 0) continue;
    const header = findHeaderMap_(rng[0]);
    const tidCol = header['taskid'];
    const subCol = header['submitted'];
    const scoreCol = header['score'];
    const commentCol = header['comment'];
    const savedCol = header['savedat'];
    if (tidCol == null || scoreCol == null || commentCol == null) continue;

    let rowIdx = -1;
    for (let r = 1; r < rng.length; r++) {
      if (String(rng[r][tidCol]) === taskId) { rowIdx = r + 1; break; }
    }
    if (rowIdx < 0) {
      sh.appendRow([taskId, '', '', false, false, '', '', '']);
      rowIdx = sh.getLastRow();
    }

    const row = rowIdx - 1 < rng.length ? rng[rowIdx - 1] : null;
    const isSubmitted = row && subCol != null ? toBool_(row[subCol]) : true;
    if (!isSubmitted && !entry.force) {
      continue;
    }

    let scoreValue = '';
    if (scoreInput !== undefined && scoreInput !== null && String(scoreInput).trim() !== '') {
      const parsed = Number(scoreInput);
      scoreValue = isNaN(parsed) ? String(scoreInput) : parsed;
    }

    const savedAt = fmtDate_(new Date());
    sh.getRange(rowIdx, scoreCol + 1).setValue(scoreValue);
    sh.getRange(rowIdx, commentCol + 1).setValue(comment);
    if (subCol != null) sh.getRange(rowIdx, subCol + 1).setValue(false);
    if (savedCol != null) {
      sh.getRange(rowIdx, savedCol + 1).setValue(savedAt);
    }
    savedEntries.push({ userId, taskId, score: scoreValue, comment, savedAt });
    updated++;
  }

  return json_({ status: 'ok', updated, entries: savedEntries });
}

/* ===================== 集計シート生成・取得 ===================== */

function loadTasksForSummary_() {
  const { values, header } = loadTaskSheetWithAttributes_();
  if (!values || values.length < 2) return { tasks: [], pathMap: {} };
  const tidCol = header['taskid'];
  const ttlCol = header['title'];
  const pidCol = header['parentid'];
  const isfCol = header['isfolder'];
  const attrCol= header['attribute'];
  const tasks = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const taskId = tidCol != null ? String(row[tidCol] || '') : '';
    if (!taskId) continue;
    const title = ttlCol != null ? String(row[ttlCol] || '') : taskId;
    const parentId = pidCol != null ? String(row[pidCol] || '') : '';
    const isFolder = isfCol != null ? toBool_(row[isfCol]) : false;
    const attribute = attrCol != null ? normalizeTaskAttributeValue_(row[attrCol]) : '';
    tasks.push({ taskId, title, parentId, isFolder, attribute });
  }
  const pathMap = buildTaskPathMap_(tasks);
  return { tasks, pathMap };
}

function buildTaskPathMap_(tasks) {
  const map = new Map();
  tasks.forEach(t => map.set(String(t.taskId), t));
  const cache = {};
  const visiting = new Set();
  function resolve(id) {
    const key = String(id || '');
    if (!key) return '';
    if (cache[key]) return cache[key];
    if (visiting.has(key)) return key;
    visiting.add(key);
    const t = map.get(key);
    if (!t) { visiting.delete(key); return key; }
    const self = t.title || key;
    const parentId = t.parentId && map.has(String(t.parentId)) ? String(t.parentId) : '';
    const parentPath = parentId ? resolve(parentId) : '';
    const path = parentPath ? `${parentPath} / ${self}` : self;
    cache[key] = path;
    visiting.delete(key);
    return path;
  }
  tasks.forEach(t => { if (!t.isFolder) resolve(t.taskId); });
  return cache;
}

function listStudents_() {
  const sh = getUserSheet_();
  const values = sh.getDataRange().getValues();
  if (!values || values.length < 2) return [];
  const header = findHeaderMap_(values[0]);
  const idCol = header['id'];
  const classCol = header['classid'];
  const numberCol = header['number'];
  if (idCol == null || classCol == null) return [];
  const students = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const userId = idCol != null ? String(row[idCol] || '') : '';
    const classId = classCol != null ? String(row[classCol] || '') : '';
    if (!userId || !classId) continue;
    const number = numberCol != null ? String(row[numberCol] || '') : '';
    students.push({ userId, classId, number });
  }
  return students;
}

function classifySubmissionBucket_(state) {
  if (state && toBool_(state.submitted)) return 'submitted';
  const hasScore = state && state.score !== undefined && state.score !== null && String(state.score).trim() !== '';
  if (hasScore) {
    const num = Number(state.score);
    if (!isNaN(num)) {
      if (num === 100) return 'cleared';
      return 'graded';
    }
    return 'graded';
  }
  return 'pending';
}

function ensureCountBucket_(counts, classId, bucket) {
  if (!counts[classId]) {
    counts[classId] = { cleared: 0, graded: 0, submitted: 0, pending: 0 };
  }
  const target = counts[classId];
  if (!target[bucket]) target[bucket] = 0;
  target[bucket] += 1;
}

function recomputeSubmissionSummary_() {
  const { tasks, pathMap } = loadTasksForSummary_();
  const leafTasks = tasks.filter(t => !t.isFolder && t.attribute !== 'その他');
  const students = listStudents_();
  const classSet = new Set();
  students.forEach(s => { if (s && s.classId) classSet.add(String(s.classId)); });
  const classes = Array.from(classSet).sort((a, b) => String(a || '').localeCompare(String(b || '')));

  const summaryMap = new Map();
  tasks.forEach(t => {
    summaryMap.set(t.taskId, {
      taskId: t.taskId,
      title: t.title || t.taskId,
      path: pathMap[t.taskId] || t.title || t.taskId,
      parentId: t.parentId || '',
      isFolder: !!t.isFolder,
      attribute: t.attribute || '',
      counts: {}
    });
  });

  students.forEach(stu => {
    const states = readUserTaskStates_(stu.userId, '');
    leafTasks.forEach(task => {
      const state = states[String(task.taskId)] || {};
      const bucket = classifySubmissionBucket_(state);
      const entry = summaryMap.get(task.taskId);
      if (!entry) return;
      ensureCountBucket_(entry.counts, stu.classId, bucket);
    });
  });

  summaryMap.forEach(entry => {
    classes.forEach(cls => {
      if (!entry.counts[cls]) {
        entry.counts[cls] = { cleared: 0, graded: 0, submitted: 0, pending: 0 };
      }
    });
  });

  const filteredSummaryMap = new Map();
  summaryMap.forEach((entry, key) => {
    if (!entry.isFolder && entry.attribute === 'その他') return;
    filteredSummaryMap.set(key, entry);
  });

  const generatedAt = fmtDate_(new Date());
  writeSubmissionSummarySheet_(classes, filteredSummaryMap, generatedAt);

  const rows = Array.from(filteredSummaryMap.values()).sort((a, b) => {
    const ap = a.path || '';
    const bp = b.path || '';
    const cmp = ap.localeCompare(bp, 'ja');
    if (cmp !== 0) return cmp;
    return (a.taskId || '').localeCompare(b.taskId || '');
  });

  return {
    status: 'ok',
    generatedAt,
    classes,
    rows,
    tasks: tasks
      .filter(t => t.isFolder || t.attribute !== 'その他')
      .map(t => ({
      taskId: t.taskId,
      title: t.title || t.taskId,
      parentId: t.parentId || '',
      isFolder: !!t.isFolder,
      path: pathMap[t.taskId] || t.title || t.taskId,
      attribute: t.attribute || deriveAttributeFromPath_(t.taskId, pathMap)
    }))
  };
}

function writeSubmissionSummarySheet_(classes, summaryMap, generatedAt) {
  const header = ['TaskId', 'Title', 'Path', 'ParentId', 'IsFolder'];
  classes.forEach(cls => {
    header.push(`${cls} クリア済`, `${cls} 採点済`, `${cls} 提出済`, `${cls} 未提出`);
  });
  const meta = new Array(header.length).fill('');
  meta[0] = 'GeneratedAt';
  meta[1] = generatedAt || '';

  const rows = Array.from(summaryMap.values()).map(entry => {
    const row = [entry.taskId, entry.title, entry.path, entry.parentId || '', entry.isFolder || false];
    classes.forEach(cls => {
      const c = entry.counts[cls] || {};
      row.push(
        Number(c.cleared || 0),
        Number(c.graded || 0),
        Number(c.submitted || 0),
        Number(c.pending || 0)
      );
    });
    return row;
  });

  const all = [meta, header].concat(rows);
  const ss = openSs_();
  let sh = ss.getSheetByName(SUBMISSION_SUMMARY_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SUBMISSION_SUMMARY_SHEET);
  }
  sh.clearContents();
  if (all.length > 0 && header.length > 0) {
    sh.getRange(1, 1, all.length, header.length).setValues(all);
  }
  try { sh.setFrozenRows(2); } catch (_) {}
}

function readSubmissionSummarySheet_() {
  const ss = openSs_();
  const sh = ss.getSheetByName(SUBMISSION_SUMMARY_SHEET);
  if (!sh) return null;
  const values = sh.getDataRange().getValues();
  if (!values || values.length < 2) return null;
  const header = values[1] || [];
  const classCols = [];
  for (let c = 5; c < header.length; c += 4) {
    const label = String(header[c] || '');
    const cls = label.split(' ')[0] || '';
    if (!cls) continue;
    classCols.push({ classId: cls, base: c });
  }
  const rows = [];
  for (let r = 2; r < values.length; r++) {
    const row = values[r] || [];
    const entry = {
      taskId: String(row[0] || ''),
      title: String(row[1] || ''),
      path: String(row[2] || ''),
      parentId: String(row[3] || ''),
      isFolder: toBool_(row[4]),
      counts: {}
    };
    const parts = (entry.path || '').split(' / ').filter(Boolean);
    const second = parts.length >= 2 ? parts[1] : (parts[0] || '');
    entry.attribute = guessAttributeFromFolderName_(second) || 'その他';
    if (!entry.isFolder && entry.attribute === 'その他') continue;
    classCols.forEach(col => {
      const base = col.base;
      entry.counts[col.classId] = {
        cleared: Number(row[base] || 0) || 0,
        graded: Number(row[base + 1] || 0) || 0,
        submitted: Number(row[base + 2] || 0) || 0,
        pending: Number(row[base + 3] || 0) || 0
      };
    });
    if (entry.taskId) rows.push(entry);
  }
  const generatedAt = values[0] && values[0][1] ? String(values[0][1]) : '';
  const classes = classCols.map(c => c.classId);
  const tasks = rows.map(r => ({
    taskId: r.taskId,
    title: r.title,
    parentId: r.parentId,
    isFolder: r.isFolder,
    path: r.path,
    attribute: r.attribute || 'その他'
  }));
  return {
    generatedAt,
    classes,
    rows,
    tasks
  };
}

function getSubmissionSummary_(e) {
  const data = readSubmissionSummarySheet_();
  if (data) {
    return json_({ status: 'ok', generatedAt: data.generatedAt, classes: data.classes, rows: data.rows, tasks: data.tasks, source: 'cached' });
  }
  const built = recomputeSubmissionSummary_();
  built.source = 'rebuilt';
  return json_(built);
}

function buildSubmissionSummary_(e) {
  const result = recomputeSubmissionSummary_();
  result.source = 'rebuilt';
  return json_(result);
}



