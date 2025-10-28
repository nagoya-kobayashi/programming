// main.js: プログラミング授業環境のフロントエンドロジック（提出取り消し時の保存順序を修正）

let pyodide = null;
let editor = null;
let currentTaskId = null;
let previousTaskId = null;
let interruptBuffer = null;
let running = false;
let userClass = "";
let userNumber = "";
let userId = "";
let sessionId = "";

// 採点結果
let resultsData = {};

// 課題データ（フォルダ含む）
let tasksData = [];

// 設定
const APP_CONFIG = window.APP_CONFIG || {};
const statusColors = {
  cleared: "#52c41a",
  submitted: "#faad14",
  graded: "#1890ff",
  saved: "#13c2c2",
  empty: "#d9d9d9"
};

// 折り畳み状態・選択課題のキー（サーバURLで名前空間を分離）
const BASE_KEY = (suffix) => {
  const base = (typeof APP_CONFIG?.serverBaseUrl === "string" && APP_CONFIG.serverBaseUrl) || "default";
  return `learn.${suffix}.${base}`;
};
const COLLAPSE_KEY = () => BASE_KEY("collapsed");
const SELECTED_KEY = () => BASE_KEY("selectedTask");

// フォルダ折り畳み: フォルダID -> true(折り畳み)
const collapsed = Object.create(null);
let collapseLoaded = false;

// ヒント閲覧フラグ
let hintOpened = false;

// 提出状態（ローカル）
const taskSubmitted = Object.create(null);

// 実行結果バッファ（LFで統一）
let outputBuffer = "";

/* ===== Utility ===== */
/**
 * コーディングアシスト要素を検出して、見た目を濃くし、エディタのスクロールに追従させる
 * - CodeMirror 5/6 を自動判別してスクロール同期
 * - よくあるID/クラス名を列挙して既存要素を探す（存在しなければ何もしない）
 */
function enhanceCodingAssistFollow(){
  // 候補セレクタ（環境に合わせて増減可：既存のアシスト領域を検出する）
  const candidates = [
    '#codingAssist', '.coding-assist', '#assistPanel', '#assistOverlay', '#assist', '[data-role="coding-assist"]'
  ];
  let assistEl = null;
  for (const sel of candidates){
    const el = document.querySelector(sel);
    if (el){ assistEl = el; break; }
  }
  if (!assistEl){ return; } // 見つからなければ何もしない（副作用なし）

  // 見た目を強調
  assistEl.classList.add('coding-assist-boost', 'coding-assist-follow');

  // CodeMirror のスクロール要素を特定
  // CM5: editor.getScrollerElement()
  // CM6: editor.contentDOM / editor.scrollDOM（実装により異なる）
  let scroller = null;
  try {
    if (editor && typeof editor.getScrollerElement === 'function') {
      scroller = editor.getScrollerElement(); // CM5
    }
  } catch(_) {}
  if (!scroller){
    // 汎用フォールバック（CM6想定）
    scroller = document.querySelector('.cm-editor .cm-scroller, .cm-editor .cm-content') ||
               document.querySelector('.cm-editor') ||
               document.querySelector('.CodeMirror-scroll, .CodeMirror-sizer') ||
               document.getElementById('editor'); // 最後の保険
  }
  if (!scroller){ return; }

  // 右上にピン留めするイメージ：スクロール量に応じて逆方向へtranslateし、表示位置を固定する
  const sync = () => {
    const st = scroller.scrollTop || 0;
    const sl = scroller.scrollLeft || 0;
    // スクロールで流れてしまうのを相殺（見た目としては固定）
    assistEl.style.transform = `translate(${sl}px, ${st}px)`;
  };

  // 初期配置
  sync();
  // スクロール/リサイズに追従
  scroller.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('resize', sync);
}

function isBlankCode(s) { return !s || String(s).replace(/[\s\u00A0\uFEFF]/g, "") === ""; }
function log(...a){ console.log("[Learn]", ...a); }
function buildUrl(path) {
  const base = APP_CONFIG.serverBaseUrl || "";
  if (base.includes('script.google.com')) return base;
  return base + path;
}

/* ===== Local Snapshot Utilities ===== */
function _snapshotKey(){ const base = APP_CONFIG.serverBaseUrl || ''; return `learn.snapshot.${base}`; }
function loadSnapshot(){
  try {
    const k = _snapshotKey();
    const raw = localStorage.getItem(k);
    if (!raw) { console.log('[main] snapshot: not found key=', k); return null; }
    const obj = JSON.parse(raw);
    console.log('[main] snapshot: loaded', { key: k,
      tasks: Array.isArray(obj?.tasks) ? obj.tasks.length : -1,
      stateKeys: obj?.states ? Object.keys(obj.states).length : 0,
      fetchedAt: obj?.fetchedAt });
    return obj;
  }
  catch(e){ console.warn('snapshot parse error', e); return null; }
}
function getLocalState(taskId){
  const snap = loadSnapshot(); return (snap && snap.states) ? snap.states[String(taskId)] : null;
}
function saveLocalState(taskId){
  try{
    const snap = loadSnapshot() || {tasks: null, states: {}, fetchedAt: 0};
    const code = editor ? editor.getValue() : '';
    const output = (document.getElementById('outputArea')||{}).textContent || '';
    const state = {
      code: code,
      output: output,
      hintOpened: !!hintOpened,
      submitted: !!taskSubmitted[currentTaskId],
      savedAt: new Date().toISOString()
    };
    snap.states[String(taskId)] = state;
    localStorage.setItem(_snapshotKey(), JSON.stringify(snap));
  } catch(e){ console.warn('saveLocalState failed', e); }
}

/* ===== セッション永続化 ===== */
window.addEventListener("DOMContentLoaded", () => { init(); });

async function init() {
  // localStorage 優先で読み出し
  sessionId = localStorage.getItem('sessionId') || sessionStorage.getItem('sessionId') || '';
  userId    = localStorage.getItem('userId')    || sessionStorage.getItem('userId')    || '';
  userClass = localStorage.getItem('classId')   || sessionStorage.getItem('classId')   || '';
  userNumber= localStorage.getItem('number')    || sessionStorage.getItem('number')    || '';

  // セッションが無ければ login.html へ
  if (!sessionId) { redirectToLogin(); return; }

  // サーバ検証（成功したら両Storageへ定着）
  if (APP_CONFIG.serverBaseUrl && sessionId) {
    try {
      const res = await fetch(APP_CONFIG.serverBaseUrl + '?session=' + encodeURIComponent(sessionId));
      const data = res.ok ? await res.json() : null;
      if (data && data.status === 'ok') {
        userId    = data.userId  || userId;
        userClass = data.classId || userClass;
        userNumber= data.number  || userNumber;
        persistSession(sessionId, userId, userClass, userNumber);
      } else {
        clearSession(); redirectToLogin(); return;
      }
    } catch {
      // 通信失敗時もとりあえず続行（保存時に再検証）
      persistSession(sessionId, userId, userClass, userNumber);
    }
  }

  // 学生情報表示
  const studentInfoDiv = document.getElementById("studentInfo");
  studentInfoDiv.textContent = `クラス:${userClass || "?"}　出席番号:${userNumber || "?"}`;

  // 課題一覧ロード→描画
  const snap = loadSnapshot();
  if (snap && Array.isArray(snap.tasks) && snap.tasks.length > 0) {
    console.log('[main] init: using snapshot tasks (no server getTasks)');
    const normalized = normalizeTasks(snap.tasks);
    applyTasksData(normalized);
    renderTaskTree();
  } else {
    console.log('[main] init: snapshot missing/empty -> call getTasks');
    await loadTaskListFromServer();
    renderTaskTree();
  }

  // Pyodide
  pyodide = await loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.22.1/full/" });

  // 採点結果（任意）
  await loadResults();

  // 割り込みバッファ
  if (typeof SharedArrayBuffer !== 'undefined') {
    interruptBuffer = new Uint8Array(new SharedArrayBuffer(1));
    if (pyodide.setInterruptBuffer) pyodide.setInterruptBuffer(interruptBuffer);
  }

  // エディタ・操作系
  initEditor();
  setupControls();

  // ===== 最初は自動選択しない。保存済み選択があれば復元、無ければガイダンス表示 =====
  const savedSelected = loadSelectedTaskId();
  if (savedSelected) {
    const found = tasksData.find(t => !t.isFolder && t.id === savedSelected);
    if (found) {
      selectTask(found.id);
      return;
    }
  }
  showNoSelectionState(); // 初期ガイダンス表示
  // エディタが初期化された後に追従を有効化
  try { enhanceCodingAssistFollow(); } catch(e){ console.warn('assist follow init failed', e); }
}

function showNoSelectionState() {
  currentTaskId = null;
  previousTaskId = null;
  hintOpened = false;
  // 問題文に案内文
  const problemTitleEl = document.getElementById("problemTitle");
  const problemTextEl = document.getElementById("problemText");
  const hintEl = document.getElementById("hint");
  problemTitleEl.textContent = "問題";
  problemTextEl.textContent = "画面左から課題を選択してください";
  if (hintEl) { hintEl.hidden = true; hintEl.innerHTML = ""; }

  // エディタ・出力は空表示
  if (editor) {
    editor.setOption('readOnly', false);
    editor.getDoc().setValue('');
  }
  const outArea = document.getElementById('outputArea');
  if (outArea) outArea.textContent = '';

  // Assist は無効＆グレー
  const assistToggle = document.getElementById("assistToggle");
  const assistLabel  = document.getElementById("assistLabel");
  if (assistToggle) { assistToggle.checked = false; assistToggle.disabled = true; }
  if (assistLabel)  { assistLabel.classList.add('disabled'); }
  updateGhostVisibility();

  // 実行/保存/提出は一旦無効（課題未選択なので）
  const runBtn = document.getElementById("runButton");
  const stopBtn = document.getElementById("stopButton");
  const saveBtn = document.getElementById("saveButton");
  const submitBtn = document.getElementById("submitButton");
  if (runBtn) runBtn.disabled = true;
  if (stopBtn) stopBtn.disabled = true;
  if (saveBtn) saveBtn.disabled = true;
  if (submitBtn) submitBtn.disabled = true;
}

function persistSession(sid, uid, cls, num) {
  try {
    localStorage.setItem('sessionId', sid);
    localStorage.setItem('userId', uid || '');
    localStorage.setItem('classId', cls || '');
    localStorage.setItem('number', num || '');
    sessionStorage.setItem('sessionId', sid);
    sessionStorage.setItem('userId', uid || '');
    sessionStorage.setItem('classId', cls || '');
    sessionStorage.setItem('number', num || '');
  } catch {}
}
function clearSession() {
  try {
    localStorage.removeItem('sessionId');
    localStorage.removeItem('userId');
    localStorage.removeItem('classId');
    localStorage.removeItem('number');
    sessionStorage.clear();
  } catch {}
}
function redirectToLogin() {
  const idParam = encodeURIComponent(userId || '');
  window.location.href = `login.html?id=${idParam}`;
}

/* ============ 課題一覧の取得・正規化 ============ */

function applyTasksData(normalized) {
  if (!Array.isArray(normalized)) {
    tasksData = [];
    return;
  }
  loadCollapsedState();
  const anySaved = Object.keys(collapsed).length > 0;
  const currentFolderIds = new Set(normalized.filter(t => t.IsFolder === true).map(t => t.TaskId));
  if (!anySaved) {
    currentFolderIds.forEach(id => (collapsed[id] = true));
    saveCollapsedState();
  } else {
    currentFolderIds.forEach(id => { if (!(id in collapsed)) collapsed[id] = true; });
    for (const id of Object.keys(collapsed)) {
      if (!currentFolderIds.has(id)) delete collapsed[id];
    }
    saveCollapsedState();
  }

  tasksData = normalized.map(t => ({
    id: t.TaskId,
    title: t.Title || t.TaskId,
    description: t.DescriptionHtml || '',
    hint: t.HintHtml || '',
    answer: t.AnswerCode || '',
    initialCode: t.InitialCode || '',
    parentId: t.ParentId || '',
    isFolder: !!t.IsFolder
  }));
}

async function loadTaskListFromServer() {
  tasksData = [];
  if (!APP_CONFIG.serverBaseUrl) {
    console.warn('[Main] serverBaseUrl 未設定');
    return;
  }
  const params = new URLSearchParams();
  params.append('action', 'getTasks');
  if (sessionId) params.append('session', sessionId);
  params.append('_ts', String(Date.now()));

  try {
    console.log('[main] getTasks: POST', APP_CONFIG.serverBaseUrl);
    const res = await fetch(APP_CONFIG.serverBaseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      cache: 'no-store',
    });
      const text = await safeText(res);
      if (!res.ok) { console.error('[Main] getTasks HTTP', res.status, text); return; }
      const json = safeJson(text);
      if (!json || json.status !== 'ok' || !Array.isArray(json.tasks)) {
        console.error('[Main] getTasks アプリエラー', json); return;
      }
      console.log('[main] getTasks: received tasks=', json.tasks.length);
      const normalized = normalizeTasks(json.tasks);
      applyTasksData(normalized);
  } catch (err) {
    console.error('[Main] getTasks 例外', err);
  }
}

function normalizeTasks(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  if (typeof raw[0] === "object" && !Array.isArray(raw[0])) {
    return raw.map(obj => normalizeTaskObject(obj));
  }
  if (Array.isArray(raw[0])) {
    const headerRow = raw[0].map(h => toCanonicalHeader(h));
    const rows = raw.slice(1);
    const idx = {
      taskid: headerRow.indexOf("taskid"),
      title: headerRow.indexOf("title"),
      descriptionhtml: headerRow.indexOf("descriptionhtml"),
      hinthtml: headerRow.indexOf("hinthtml"),
      answercode: headerRow.indexOf("answercode"),
      initialcode: headerRow.indexOf("initialcode"),
      parentid: headerRow.indexOf("parentid"),
      isfolder: headerRow.indexOf("isfolder"),
    };
    return rows.map(r => {
      const obj = {
        TaskId: getCell(r, idx.taskid),
        Title: getCell(r, idx.title),
        DescriptionHtml: getCell(r, idx.descriptionhtml),
        HintHtml: getCell(r, idx.hinthtml),
        AnswerCode: getCell(r, idx.answercode),
        InitialCode: getCell(r, idx.initialcode),
        ParentId: getCell(r, idx.parentid),
        IsFolder: toBool(getCell(r, idx.isfolder)),
      };
      return normalizeTaskObject(obj);
    }).filter(t => t.TaskId);
  }
  return [];
}
function toCanonicalHeader(h) {
  const s = String(h || "").replace(/^\uFEFF/, "").trim().toLowerCase();
  if (s === "isfolder" || s === "is_folder") return "isfolder";
  if (s === "parent" || s === "parent_id") return "parentid";
  return s;
}
function getCell(row, idx) { if (idx < 0 || idx == null) return ""; return row[idx]; }
function toBool(v) { const s = String(v || "").trim().toLowerCase(); return s === "true" || s === "1" || s === "yes" || s === "y"; }
function normalizeTaskObject(t) {
  const pick = (o, ks) => { for (const k of ks) { if (o[k] != null && o[k] !== "") return o[k]; } return ""; };
  return {
    TaskId: pick(t, ["TaskId","taskId","taskid"]),
    Title: pick(t, ["Title","title"]) || pick(t, ["TaskId","taskId","taskid"]),
    DescriptionHtml: pick(t, ["DescriptionHtml","descriptionHtml","description","Description"]),
    HintHtml: pick(t, ["HintHtml","hintHtml","hint","Hint"]),
    AnswerCode: pick(t, ["AnswerCode","answerCode","answer","Answer"]),
    InitialCode: pick(t, ["InitialCode","initialCode"]),
    ParentId: pick(t, ["ParentId","parentId","parentid"]),
    IsFolder: toBool(pick(t, ["IsFolder","isFolder","isfolder"]))
  };
}

/* ============ ツリー描画（フォルダ＋課題、横スクロール整列） ============ */

function renderTaskTree() {
  const ul = document.getElementById("tasks");
  while (ul.firstChild) ul.removeChild(ul.firstChild);

  const byParent = new Map();
  tasksData.forEach(t => {
    const key = t.parentId || "";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(t);
  });

  const sortChildren = (arr) => {
    arr.sort((a, b) => {
      const af = a.isFolder ? 0 : 1;
      const bf = b.isFolder ? 0 : 1;
      if (af !== bf) return af - bf;
      return (a.title || "").localeCompare(b.title || "");
    });
  };

  const renderGroup = (parentId, level) => {
    const list = byParent.get(parentId || "") || [];
    sortChildren(list);

    list.forEach(item => {
      const li = document.createElement("li");
      li.dataset.taskId = item.id;
      li.style.setProperty("--indent", `${level * 18}px`);

      // 1: インデント
      li.appendChild(Object.assign(document.createElement("span"), { className: "indent" }));

      // 2: フォルダトグル or PH
      if (item.isFolder) {
        const btn = document.createElement("span");
        btn.className = "toggle-btn";
        const isCollapsed = !!collapsed[item.id];
        btn.textContent = isCollapsed ? "+" : "−";
        btn.title = isCollapsed ? "展開" : "折り畳み";
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          collapsed[item.id] = !collapsed[item.id];
          saveCollapsedState();
          renderTaskTree();
        });
        li.appendChild(btn);
      } else {
        li.appendChild(Object.assign(document.createElement("span"), { className: "toggle-ph" }));
      }

      // 3: アイコン or PH
      if (item.isFolder) {
        li.appendChild(Object.assign(document.createElement("span"), { className: "icon-ph" }));
      } else {
        const icon = document.createElement("span");
        icon.className = "task-icon"; icon.style.background = statusColors.empty;
        li.appendChild(icon);
      }

      // 4: タイトル
      const titleCell = document.createElement("span");
      titleCell.className = "title-cell";
      titleCell.textContent = item.title || item.id;
      li.appendChild(titleCell);

      // 5: ステータス（課題のみ）
      if (!item.isFolder) {
        const badge = document.createElement("span");
        badge.className = "status-badge";
        badge.textContent = "";
        li.appendChild(badge);
      }

      // クリック
      if (item.isFolder) {
        li.classList.add("folder-item");
        li.addEventListener("click", () => {
          collapsed[item.id] = !collapsed[item.id];
          saveCollapsedState();
          renderTaskTree();
        });
        ul.appendChild(li);
        if (!collapsed[item.id]) renderGroup(item.id, level + 1);
      } else {
        li.addEventListener("click", () => selectTask(item.id));
        ul.appendChild(li);
      }
    });
  };

  renderGroup("", 0);

  applyResultsToList();
  updateStatusBadges();
  if (currentTaskId) saveLocalState(currentTaskId);
}

function loadCollapsedState() {
  if (collapseLoaded) return;
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY());
    if (raw) Object.assign(collapsed, JSON.parse(raw) || {});
  } catch {}
  collapseLoaded = true;
}
function saveCollapsedState() {
  try { localStorage.setItem(COLLAPSE_KEY(), JSON.stringify({ ...collapsed })); } catch {}
}

/* ============ 採点データ/アイコン/バッジ ============ */

async function loadResults() {
  try {
    const resultsPath = APP_CONFIG.resultsPath;
    if (!resultsPath) { resultsData = {}; return; }
    const res = await fetch(buildUrl(resultsPath));
    if (res.ok) resultsData = (await res.json()) || {};
    else resultsData = {};
    applyResultsToList();
    updateStatusBadges();
  } catch { resultsData = {}; }
}
function getCachedSubmitted(taskId) { const c = loadFromCache(taskId); return !!(c && c.submitted); }
function getCachedHasCode(taskId) { const c = loadFromCache(taskId); return !!(c && !isBlankCode(c.code || "")); }
function computeStatusKey(taskId) {
  const classData = resultsData[userClass] || {};
  const studentData = classData[userNumber] || {};
  const result = studentData[taskId];
  if (result && result.score !== undefined) return "graded";
  if (taskSubmitted[taskId] || getCachedSubmitted(taskId)) return "submitted";
  if (getCachedHasCode(taskId)) return "saved";
  return "empty";
}
function applyResultsToList() {
  document.querySelectorAll("#taskList li").forEach(li => {
    const icon = li.querySelector(".task-icon"); if (!icon) return;
    const taskId = li.dataset.taskId;
    icon.style.background = statusColors[computeStatusKey(taskId)] || statusColors.empty;
  });
}
function updateStatusBadges() {
  document.querySelectorAll("#taskList li").forEach(li => {
    const badge = li.querySelector(".status-badge"); if (!badge) return;
    const taskId = li.dataset.taskId;
    const classData = resultsData[userClass] || {};
    const studentData = classData[userNumber] || {};
    const result = studentData[taskId];
    let label = "";
    if (result && result.score !== undefined) label = "[採点済]";
    else if (taskSubmitted[taskId] || getCachedSubmitted(taskId)) label = "[提出済]";
    else if (getCachedHasCode(taskId)) label = "[編集中]";
    badge.textContent = label;
  });
}

/* ============ 課題選択・表示（切替保存は非同期・UIは即時） ============ */

async function selectTask(nextTaskId) {
  // 前タスクを非同期で保存（提出済はスキップ）
  if (previousTaskId && previousTaskId !== nextTaskId) {
    if (!taskSubmitted[previousTaskId] && !getCachedSubmitted(previousTaskId)) {
      const prevCode = editor ? editor.getValue() : '';
      const prevOut  = outputBuffer;
      const prevHint = hintOpened;
      saveToCache(previousTaskId, { code: prevCode, output: prevOut, hintOpened: prevHint, submitted: false });
      saveSpecificTask(previousTaskId,
        { code: prevCode, output: prevOut, hintOpened: prevHint, submitted: false },
        true
      ).catch(e => console.warn('[Main] bg save error', e));
    }
  }

  // �O�^�̏����p�X�i���݃L���b�V������‏݂��鏉��j
  if (currentTaskId) saveLocalState(currentTaskId);

  previousTaskId = nextTaskId;
  currentTaskId = nextTaskId;
  saveSelectedTaskId(nextTaskId);

  // ハイライト
  document.querySelectorAll("#taskList li").forEach(li => {
    const isTask = !!li.querySelector(".task-icon");
    li.classList.toggle("active", isTask && li.dataset.taskId === nextTaskId);
  });

  const task = tasksData.find(t => t.id === nextTaskId);
  if (!task) return;

  document.getElementById("problemTitle").textContent = task.title;
  const toHtmlWithBr = (s) => String(s || "").replace(/\r\n|\n/g, "<br>");
  const problemTextEl = document.getElementById("problemText");
  const hintEl = document.getElementById("hint");
  problemTextEl.innerHTML = toHtmlWithBr(task.description);

  const appendedNote = `<div style="margin-top:8px;color:#666;font-size:12px;">※コーディングアシストを使えます。</div>`;
  hintEl.innerHTML = (task.hint ? toHtmlWithBr(task.hint) + appendedNote : appendedNote);
  hintEl.hidden = true;

  // Assist 初期化（ラベル灰色 & 無効）
  const assistToggle = document.getElementById("assistToggle");
  const assistLabel  = document.getElementById("assistLabel");
  assistToggle.checked = false; assistToggle.disabled = true; assistLabel.classList.add('disabled');
  updateGhostVisibility();

  // 出力初期化
  clearOutput();

  // 「読み込み中」表示（即座にキャッシュで上書きされうる）
  if (editor) { editor.getDoc().setValue('読み込み中...'); editor.setOption('readOnly','nocursor'); }
  const outArea = document.getElementById('outputArea');
  outArea.textContent = '読み込み中...';

  // Assist本文セット
  document.getElementById("ghostText").textContent = task.answer || "";

  const requestId = nextTaskId;
  const loadingOut = outArea;

  // 先にキャッシュ表示（UIは即時切替）
  const cached = loadFromCache(nextTaskId);
  console.log('[main] selectTask:', nextTaskId, { hasCache: !!cached });
  if (cached) {
    if (editor) editor.getDoc().setValue(cached.code || '');
    outputBuffer = (cached.output || '').replace(/\r\n/g, "\n");
    outArea.textContent = outputBuffer;
    hintOpened = !!cached.hintOpened;
    taskSubmitted[nextTaskId] = !!cached.submitted;
    setSubmitButtonState(!!taskSubmitted[nextTaskId]);
    if (taskSubmitted[nextTaskId]) lockEditor(); else unlockEditor();

    if (hintOpened) {
      hintEl.hidden = false;
      assistToggle.disabled = false;
      assistLabel.classList.remove('disabled');
      updateGhostVisibility();
    }
  }

  // ローカルスナップショット反映（あれば即適用）
  const st = getLocalState(nextTaskId);
  console.log('[main] selectTask localState:', nextTaskId, { hasLocalState: !!st });
  if (st) {
    if (editor) editor.getDoc().setValue(st.code || '');
    const outEl = document.getElementById('outputArea');
    if (outEl) outEl.textContent = st.output || '';
    outputBuffer = String(st.output || '').replace(/\r\n/g, "\n");
    hintOpened = !!st.hintOpened;
    taskSubmitted[nextTaskId] = !!st.submitted;
    setSubmitButtonState(!!taskSubmitted[nextTaskId]);
  }
  // === ここが変更点 ===
  // ローカル（キャッシュ or スナップショット）に状態があればサーバ読込はスキップして通信削減
  let saved = null;
  const hasLocalState = !!cached || !!st;
  console.log('[main] selectTask: hasLocalState=', hasLocalState, ' -> ', hasLocalState ? 'skip server' : 'fetch server');
  if (!hasLocalState) {
    // ローカルに何もないときのみサーバから取得
    saved = await loadTaskFromServer(nextTaskId);
    console.log('[main] selectTask: server loaded=', !!saved);
  }
  if (currentTaskId !== requestId) {
    if (editor && editor.getOption('readOnly') === 'nocursor' && editor.getValue() === '読み込み中...') {
      editor.setOption('readOnly', false); editor.getDoc().setValue('');
    }
    if (loadingOut && loadingOut.textContent.trim() === '読み込み中...') loadingOut.textContent = '';
    return;
  }
  if (editor) editor.setOption('readOnly', false);

  if (saved) {
    if (editor) editor.getDoc().setValue(saved.code || '');
    outputBuffer = String(saved.output || '').replace(/\r\n/g, "\n");
    outArea.textContent = outputBuffer;
    hintOpened = !!saved.hintOpened;
    taskSubmitted[nextTaskId] = !!saved.submitted;
    setSubmitButtonState(!!taskSubmitted[nextTaskId]);
    if (taskSubmitted[nextTaskId]) lockEditor(); else unlockEditor();
    saveToCache(nextTaskId, { code: editor ? editor.getValue() : (saved.code || ''), output: outputBuffer, hintOpened, submitted: taskSubmitted[nextTaskId] });

    if (hintOpened) {
      hintEl.hidden = false;
      assistToggle.disabled = false;
      assistLabel.classList.remove('disabled');
      updateGhostVisibility();
    }
  } else if (!cached && !st) {
    applyInitialCodeIfBlank(task);
    console.log('[main] selectTask: applied InitialCode (no cache/state)');
  } else {
    if (!taskSubmitted[nextTaskId] && (isBlankCode(editor ? editor.getValue() : cached.code || "") || ((editor ? editor.getValue() : (cached.code || "")).trim() === "読み込み中..."))) {
      applyInitialCodeIfBlank(task);
      console.log('[main] selectTask: applied InitialCode (was blank/loading)');
    }
  }
  if (saved && !taskSubmitted[nextTaskId] && (isBlankCode(saved.code || '') || String((saved.code || '').trim()) === "読み込み中...")) applyInitialCodeIfBlank(task);
  // ヒント押下：表示＋Assist「有効化だけ」（自動チェックなし）＋即保存（非同期）
  document.getElementById("hintButton").onclick = () => {
    hintEl.hidden = false;
    if (assistToggle.disabled) { assistToggle.disabled = false; assistLabel.classList.remove('disabled'); updateGhostVisibility(); }
    if (!hintOpened) {
      hintOpened = true;
      if (!taskSubmitted[nextTaskId]) {
        const codeNow = editor ? editor.getValue() : '';
        const outNow  = outputBuffer;
        saveToCache(nextTaskId, { code: codeNow, output: outNow, hintOpened: true, submitted: taskSubmitted[nextTaskId] });
        saveSpecificTask(nextTaskId, { code: codeNow, output: outNow, hintOpened: true, submitted: taskSubmitted[nextTaskId] }, true)
          .catch(e => console.warn('[Main] hint save error', e));
      }
    }
    if (currentTaskId) saveLocalState(currentTaskId);
  };

  updateStatusIcon(computeStatusKey(nextTaskId));
  applyResultsToList(); updateStatusBadges();
}

/* 特定課題の保存（現在の課題IDを変更しない） */
async function saveSpecificTask(taskId, data, silent = true) {
  const useGs = (APP_CONFIG.serverBaseUrl || '').includes('script.google.com');
  const payload = {
    taskId,
    code: String(data.code || ""),
    output: String(data.output || "").replace(/\r\n/g, "\n"),
    hintOpened: !!data.hintOpened,
    submitted: !!data.submitted
  };
  if (sessionId) payload.session = sessionId;
  else {
    payload.id = userId;
    if (userClass) payload.classId = userClass;
    if (userNumber) payload.number = userNumber;
  }
  let headers, body;
  if (useGs) {
    const sp = new URLSearchParams(); Object.keys(payload).forEach(k => sp.append(k, payload[k]));
    headers = { 'Content-Type': 'application/x-www-form-urlencoded' }; body = sp.toString();
  } else { headers = { 'Content-Type': 'application/json' }; body = JSON.stringify(payload); }
  try {
    const res = await fetch(buildUrl(APP_CONFIG.saveScript || "/save"), { method: 'POST', headers, body });
    if (!silent) showStatusMessage(res.ok ? '保存しました' : '保存に失敗しました', res.ok ? 'success' : 'error');
  } catch { if (!silent) showStatusMessage('保存に失敗しました','error'); }
}

/* InitialCode（空のときだけ適用） */
function applyInitialCodeIfBlank(task) {
  const initial = task.initialCode || '';
  const cur = editor ? editor.getValue() : '';
  if (!isBlankCode(cur) && cur.trim() !== "読み込み中...") return;
  if (editor) editor.getDoc().setValue(initial);
  outputBuffer = ""; document.getElementById('outputArea').textContent = "";
  hintOpened = false; taskSubmitted[currentTaskId] = false; setSubmitButtonState(false); unlockEditor();
  saveToCache(currentTaskId, { code: initial, output: "", hintOpened: false, submitted: false });
  saveSpecificTask(currentTaskId, { code: initial, output: "", hintOpened: false, submitted: false }, true)
    .catch(e => console.warn('[Main] init save error', e));
}

/* ============ エディタ / 実行 / 保存 ============ */

function initEditor() {
  editor = CodeMirror.fromTextArea(document.getElementById("editor"), {
    mode: "python", lineNumbers: true, indentUnit: 4, indentWithTabs: false, smartIndent: true,
    gutters: ["CodeMirror-lint-markers"], lint: { async: true, getAnnotations: pythonLinter }
  });
  editor.on("change", () => { syncGhostScroll(); enableSaveSubmitButtons(); updateStatusBadges(); applyResultsToList(); });
  editor.on("scroll", syncGhostScroll);
  setTimeout(() => {
    const wrapper = editor.getWrapperElement();
    const gutter = wrapper.querySelector('.CodeMirror-gutters');
    const gutterWidth = gutter ? gutter.offsetWidth : 0;
    document.getElementById('ghostText').style.left = (32 + gutterWidth) + 'px';
  }, 0);
}
function syncGhostScroll() {
  if (!editor) return;
  const cm = editor.getScrollerElement(); const ghost = document.getElementById("ghostText");
  ghost.scrollTop = cm.scrollTop; ghost.scrollLeft = cm.scrollLeft;
}
function updateGhostVisibility() {
  const assistOn = document.getElementById("assistToggle").checked;
  document.getElementById("ghostText").style.display = assistOn ? "block" : "none";
}

function setupControls() {
  document.getElementById("playButton").addEventListener("click", () => {
    // 実行前の保存は行わない（出力が反映された後に保存するため）
    if (!running) runCode();
  });
  document.getElementById("stopIconButton").addEventListener("click", () => { if (running) stopCode(); });
  document.getElementById("saveButton").addEventListener("click", () => { saveToServer(false, false); disableSaveButton(); });
  document.getElementById("submitButton").addEventListener("click", () => {
    const isSubmitted = taskSubmitted[currentTaskId];
    if (isSubmitted) { cancelSubmission(); } else { submitToServer(); }
  });
  document.getElementById("assistToggle").addEventListener("change", updateGhostVisibility);

  const logoutBtn = document.getElementById('logoutButton');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      if (sessionId && APP_CONFIG.serverBaseUrl) {
        try {
          const params = new URLSearchParams({ action: 'logout', session: sessionId });
          await fetch(APP_CONFIG.serverBaseUrl + '?' + params.toString());
        } catch {}
      }
      clearSession();
      redirectToLogin();
    });
  }

  updatePlayStopButtons();
}
function disableSaveButton(){ document.getElementById("saveButton").disabled = true; }
function enableSaveSubmitButtons(){
  const runBtn = document.getElementById("runButton");
  const stopBtn = document.getElementById("stopButton");
  const saveBtn = document.getElementById("saveButton");
  const submitBtn = document.getElementById("submitButton");
  if (runBtn) runBtn.disabled = false;
  if (stopBtn) stopBtn.disabled = false;
  if (saveBtn) saveBtn.disabled = false;
  if (submitBtn) submitBtn.disabled = false;
}

let statusTimerId = null;
function showStatusMessage(msg, type='success') {
  const div = document.getElementById("statusMessage");
  div.textContent = msg; div.classList.remove('success','error'); div.classList.add(type==='error'?'error':'success');
  if (statusTimerId) clearTimeout(statusTimerId);
  statusTimerId = setTimeout(()=>{ div.textContent=''; div.classList.remove('success','error'); statusTimerId=null; }, 10000);
}

async function runCode() {
  clearOutput(); enableSaveSubmitButtons();
  let code = editor ? editor.getValue() : '';
  const indentSize = editor && editor.getOption ? editor.getOption('indentUnit') || 4 : 4;
  code = code.replace(/\t/g, ' '.repeat(indentSize));
  if (!code.trim()) { appendOutput("実行するコードがありません。\n"); return; }
  running = true; updatePlayStopButtons();
  if (interruptBuffer) interruptBuffer[0] = 0; enableSaveSubmitButtons();
  try {
    const outEl = document.getElementById("outputArea") || document.getElementById("output");
    const scrollToBottom = () => { if (outEl) outEl.scrollTop = outEl.scrollHeight; };

    // 出力エコー：
    // 1) CRLF→LF 正規化
    // 2) リテラル "\\n" → 実改行に復元
    // 3) 末尾が改行でなければ改行を補って表示（printの改行を保証）
    const __safeAppend = (text) => {
      let t = String(text);
      t = t.replace(/\r\n/g, "\n");
      t = t.replace(/\\n/g, "\n");
      if (!t.endsWith("\n")) {
        appendOutput(t + "\n");
      } else {
        appendOutput(t);
      }
      scrollToBottom();
    };
    pyodide.setStdout({ batched: __safeAppend });
    pyodide.setStderr({ batched: __safeAppend });
    // Python から呼ぶ出力関数（プロンプト表示に使う）
    window.__append_output = (text) => { appendOutput(String(text)); };

    // --- ここから input() の差し替え ---
    // JS → Python への入力ブリッジ
    window._waitForInput = null;
    window._resolveInput = null;

    // 出力欄に入力欄を出して、入力完了まで待機する Promise
    function showInputField(promptText) {
      return new Promise((resolve) => {
        const wrap = document.createElement("span");
        wrap.className = "inline-input";
        const input = document.createElement("input");
        input.type = "text";
        input.autocomplete = "off";
        // 入力欄は常に空欄（プレースホルダを出さない）
        input.placeholder = "";
        wrap.appendChild(input);
        // プロンプト文字列は Python 側で js.__append_output により既に出力済み（改行なし）
        // ここでは「横の入力欄」だけ追加する
        outEl.appendChild(wrap);
        input.focus();
        scrollToBottom();
        const submit = () => {
          const val = input.value ?? "";
          wrap.remove();
          appendOutput(val + "\n");  // 入力値は実際の改行で出力に残す
          scrollToBottom();
          resolve(val);
        };
        input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
      });
    }

    // Python から js.show_input_field(...) で呼べるように、グローバルへ公開
    window.show_input_field = showInputField;

    // ==== ここから：同期 input を「await できる input」に機械変換して async 包で実行 ====
    // 1) input( を await __await_input__( に置換（識別子の一部は除外）
    const patched = code.replace(/(^|[^A-Za-z0-9_])input\s*\(/g, '$1await __await_input__(');
    // 2) 行ごとにインデントを付けて __user_main に包む（全コードを関数内に確実に収める）
    const body = patched.split('\n').map(line => '    ' + line).join('\n');
    const wrapped = `
import js, asyncio
async def __await_input__(prompt=""):
    p = str(prompt) if prompt is not None else ""
    if p:
        # 改行せずプロンプトを出力欄に出す
        try:
            js.__append_output(p)
        except Exception:
            pass
    # 出力欄の「横入力」UIで入力を取得（Promise を await）
    v = await js.show_input_field(p)
    # 入力文字列自体は JS 側で出力欄に append済み（残す仕様）
    return str(v)
async def __user_main():
${body}
await __user_main()
`;
    await pyodide.runPythonAsync(wrapped);
  } catch (err) { appendOutput(err.toString()+"\n"); }
  finally {
    running=false; updatePlayStopButtons();
    // 実行後に保存（出力を含めた最新状態）— 非同期でUIを止めない
    if (currentTaskId && !taskSubmitted[currentTaskId]) {
      const codeNow = editor ? editor.getValue() : '';
      const outNow  = outputBuffer;
      saveToCache(currentTaskId, { code: codeNow, output: outNow, hintOpened, submitted: false });
      saveSpecificTask(currentTaskId, { code: codeNow, output: outNow, hintOpened, submitted: false }, true)
        .catch(e => console.warn('[Main] run save error', e));
      applyResultsToList(); updateStatusBadges();
    }
    if (currentTaskId) saveLocalState(currentTaskId);
  }
}
function stopCode(){
  if (interruptBuffer){ interruptBuffer[0]=2; appendOutput("\n実行を停止しました。\n"); }
  else appendOutput("\nこの環境では停止機能は利用できません。\n");
  running=false; updatePlayStopButtons();
}

/* 出力 */
function appendOutput(text){ const a=document.getElementById("outputArea"); a.appendChild(document.createTextNode(text)); outputBuffer += String(text).replace(/\r\n/g,"\n"); }
function clearOutput(){ const a=document.getElementById("outputArea"); a.innerHTML=""; outputBuffer=""; }

/* input() ブラウザ入力 */
async function collectInputs(prompts){
  const outArea=document.getElementById("outputArea"); const results=[];
  for (let i=0;i<prompts.length;i++){
    const p=prompts[i]||"";
    if (p){ const sp=document.createElement("span"); sp.textContent=p; outArea.appendChild(sp); outputBuffer+=p; }
    const input=document.createElement("input"); input.type="text"; input.className="py-input"; outArea.appendChild(input); input.focus();
    const v = await new Promise((resolve)=>{ input.addEventListener("keydown", function h(e){ if(e.key==="Enter"){ input.removeEventListener("keydown",h); resolve(input.value); } }); });
    const node=document.createTextNode(v); outArea.replaceChild(node,input); results.push(v); outArea.appendChild(document.createElement("br")); outputBuffer+=v+"\n";
  }
  return results;
}

/* 保存・提出 */
function saveToServer(silent=false, submittedFlag=false){
  if (!currentTaskId) { if(!silent) showStatusMessage('課題が選択されていません', 'error'); return; }
  if (taskSubmitted[currentTaskId] && submittedFlag!==true){ if(!silent) showStatusMessage('提出済みのため保存はスキップしました','success'); return; }
  const code = editor ? editor.getValue() : '';
  const output = outputBuffer.replace(/\r\n/g,"\n");
  const url = buildUrl(APP_CONFIG.saveScript || "/save");
  const useGs = (APP_CONFIG.serverBaseUrl || '').includes('script.google.com');
  const payload = { taskId: currentTaskId, code, output, hintOpened, submitted: submittedFlag || taskSubmitted[currentTaskId]===true };
  if (sessionId) payload.session = sessionId;
  else { payload.id=userId; if(userClass) payload.classId=userClass; if(userNumber) payload.number=userNumber; }

  let headers, body;
  if (useGs) { const sp=new URLSearchParams(); Object.keys(payload).forEach(k=>sp.append(k,payload[k])); headers={'Content-Type':'application/x-www-form-urlencoded'}; body=sp.toString(); }
  else { headers={'Content-Type':'application/json'}; body=JSON.stringify(payload); }

  fetch(url, { method:'POST', headers, body })
    .then(async (res)=>{
      if (useGs){
        if (submittedFlag) taskSubmitted[currentTaskId] = true;
        if (!silent) showStatusMessage(submittedFlag?'提出しました':'保存しました','success');
        saveToCache(currentTaskId, { code, output, hintOpened, submitted: !!taskSubmitted[currentTaskId] });
        updateStatusIcon(computeStatusKey(currentTaskId)); applyResultsToList(); updateStatusBadges(); if (currentTaskId) saveLocalState(currentTaskId); return;
      }
      try {
        const data = await res.json();
        const ok = res.ok && data && data.status === 'ok';
        if (ok && submittedFlag) taskSubmitted[currentTaskId] = true;
        if (!silent) showStatusMessage(ok ? (submittedFlag?'提出しました':'保存しました') : (submittedFlag?'提出に失敗しました':'保存に失敗しました'), ok?'success':'error');
        saveToCache(currentTaskId, { code, output, hintOpened, submitted: !!taskSubmitted[currentTaskId] });
        updateStatusIcon(computeStatusKey(currentTaskId)); applyResultsToList(); updateStatusBadges(); if (currentTaskId) saveLocalState(currentTaskId);
      } catch (e) {
        if (res.ok){ if (submittedFlag) taskSubmitted[currentTaskId]=true; if(!silent) showStatusMessage(submittedFlag?'提出しました':'保存しました','success');
          saveToCache(currentTaskId, { code, output, hintOpened, submitted: !!taskSubmitted[currentTaskId] });
          updateStatusIcon(computeStatusKey(currentTaskId)); applyResultsToList(); updateStatusBadges(); if (currentTaskId) saveLocalState(currentTaskId);
        } else { if(!silent) showStatusMessage(submittedFlag?'提出に失敗しました':'保存に失敗しました','error'); }
      }
    })
    .catch(()=>{ if(!silent) showStatusMessage(submittedFlag?'提出に失敗しました':'保存に失敗しました','error'); });
}

function submitToServer(){
  if(!currentTaskId) return;
  saveToServer(false,true);
  taskSubmitted[currentTaskId]=true;
  lockEditor();
  setSubmitButtonState(true);
  updateStatusIcon('submitted');
  applyResultsToList();
  updateStatusBadges();
  if (currentTaskId) saveLocalState(currentTaskId);
}

/* ★修正箇所：提出取り消し時は、先に未提出フラグへ変更してから保存を呼ぶ */
function cancelSubmission(){
  if(!currentTaskId) return;
  // 1) 先にローカル状態を未提出へ（payload.submitted が false になる）
  taskSubmitted[currentTaskId]=false;

  // 2) 上書き保存を実行（未提出状態でサーバ反映）
  saveToServer(false,false);

  // 3) キャッシュも未提出で更新
  const codeNow = editor ? editor.getValue() : '';
  saveToCache(currentTaskId, { code: codeNow, output: outputBuffer, hintOpened, submitted: false });

  // 4) UI 更新
  unlockEditor();
  setSubmitButtonState(false);
  updateStatusIcon('saved');
  applyResultsToList();
  updateStatusBadges();
  if (currentTaskId) saveLocalState(currentTaskId);
}

function updateStatusIcon(status){ if(!currentTaskId) return; const key=(status in statusColors)?status:computeStatusKey(currentTaskId); const el=document.querySelector(`#taskList li[data-task-id='${currentTaskId}'] .task-icon`); if(el) el.style.background = statusColors[key] || statusColors.empty; }

/* ロック/アンロック */
function lockEditor(){ if(editor) editor.setOption('readOnly',true); document.getElementById('editorWrapper').classList.add('locked'); document.getElementById('playButton').disabled=true; document.getElementById('stopIconButton').disabled=true; document.getElementById('saveButton').disabled=true; }
function unlockEditor(){ if(editor) editor.setOption('readOnly',false); document.getElementById('editorWrapper').classList.remove('locked'); document.getElementById('playButton').disabled=false; document.getElementById('stopIconButton').disabled=false; enableSaveSubmitButtons(); }
function setSubmitButtonState(isSubmitted){ const b=document.getElementById('submitButton'); if(b) b.textContent = isSubmitted ? '提出取り消し' : '提出'; }

/* サーバ読込 */
async function loadTaskFromServer(taskId){
  try {
    if (!APP_CONFIG.serverBaseUrl) return null;
    let url;
    if (sessionId) { const p=new URLSearchParams({ session:sessionId, taskId }); url = APP_CONFIG.serverBaseUrl + '?' + p.toString(); }
    else { const p=new URLSearchParams({ id:userId, taskId }); if(userClass) p.set('classId',userClass); if(userNumber) p.set('number',userNumber); url = APP_CONFIG.serverBaseUrl + '?' + p.toString(); }
    const res = await fetch(url);
    if (!res.ok) { if (res.status===401) { clearSession(); redirectToLogin(); } return null; }
    const json = await res.json();
    if (json && json.status==='ok') return json.data || null;
    if (json && json.status==='error') { clearSession(); redirectToLogin(); }
    return null;
  } catch { return null; }
}

/* ローカルキャッシュ */
function getCacheKey(taskId){ const base = (localStorage.getItem('sessionId') || sessionStorage.getItem('sessionId') || userId || ''); return `cache_${base}_${taskId}`; }
function loadFromCache(taskId){ try { const j=localStorage.getItem(getCacheKey(taskId)); return j?JSON.parse(j):null; } catch { return null; } }
function saveToCache(taskId,data){ try { localStorage.setItem(getCacheKey(taskId), JSON.stringify(data)); } catch {} }
function saveSelectedTaskId(taskId){ try { localStorage.setItem(SELECTED_KEY(), String(taskId||"")); } catch {} }
function loadSelectedTaskId(){ try { return localStorage.getItem(SELECTED_KEY()) || ""; } catch { return ""; } }

/* Lint / Utility */
async function pythonLinter(text){
  const annotations=[]; if(!text.trim()) return annotations;
  try { await pyodide.runPythonAsync(`compile(${JSON.stringify(text)}, '<input>', 'exec')`); }
  catch(err){ const msg=err.toString(); const m=msg.match(/line (\d+)/); const line=m?parseInt(m[1],10)-1:0;
    annotations.push({ from: CodeMirror.Pos(line,0), to: CodeMirror.Pos(line,1), message: msg, severity:'error' });
  }
  return annotations;
}
function updatePlayStopButtons(){ const p=document.getElementById("playButton"), s=document.getElementById("stopIconButton"); if(running){ p.hidden=true; s.hidden=false; } else { p.hidden=false; s.hidden=true; } }
function handleSessionExpired(){ alert('セッションがタイムアウトしました。再度ログインしてください。'); clearSession(); redirectToLogin(); }
async function safeText(res){ try { return await res.text(); } catch { return ""; } }
function safeJson(text){ try { const cleaned=text.replace(/^[)\]\}'\s]+/,""); return JSON.parse(cleaned); } catch { return null; } }








