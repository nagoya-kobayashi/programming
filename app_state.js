// app_state.js: 共有状態とストレージ系ユーティリティ

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
let pyWorker = null;
let workerReady = false;
let workerInitPromise = null;
let workerCanInterrupt = false;
let resultsData = {};
let tasksData = [];

const commPayload = window.CommPayload || null;
const sheetIO = window.SheetIO || null;
if (!commPayload) console.error('[main] CommPayload が読み込まれていません');
if (!sheetIO) console.error('[main] SheetIO が読み込まれていません');

const APP_CONFIG = window.APP_CONFIG || {};
const statusColors = {
  cleared: "#52c41a",
  submitted: "#9254de",
  graded: "#ff8fb7",
  saved: "#13c2c2",
  editing: "#fa541c",
  empty: "#d9d9d9"
};

const BASE_KEY = (suffix) => {
  const base = (typeof APP_CONFIG?.serverBaseUrl === "string" && APP_CONFIG.serverBaseUrl) || "default";
  return `learn.${suffix}.${base}`;
};
const COLLAPSE_KEY = () => BASE_KEY("collapsed");
const SELECTED_KEY = () => BASE_KEY("selectedTask");
let snapshotCache = null;
let snapshotCacheRaw = null;

const collapsed = Object.create(null);
let collapseLoaded = false;
let hintOpened = false;
const taskSubmitted = Object.create(null);
let outputBuffer = "";
const taskDirtyState = Object.create(null);
const taskSyncedState = Object.create(null);

function isBlankCode(s) { return !s || String(s).replace(/[\s\u00A0\uFEFF]/g, "") === ""; }
function log(...a){ console.log("[Learn]", ...a); }

function _snapshotKey(){ const base = APP_CONFIG.serverBaseUrl || ''; return `learn.snapshot.${base}`; }
function loadSnapshot(force = false){
  try {
    const k = _snapshotKey();
    const raw = localStorage.getItem(k);
    if (!raw) {
      snapshotCache = null;
      snapshotCacheRaw = null;
      return null;
    }
    if (!force && snapshotCache && snapshotCacheRaw === raw) {
      return snapshotCache;
    }
    const obj = JSON.parse(raw);
    snapshotCache = obj;
    snapshotCacheRaw = raw;
    console.log('[main] snapshot: loaded', {
      key: k,
      tasks: Array.isArray(obj?.tasks) ? obj.tasks.length : -1,
      stateKeys: obj?.states ? Object.keys(obj.states).length : 0,
      fetchedAt: obj?.fetchedAt
    });
    return obj;
  }
  catch(e){
    snapshotCache = null;
    snapshotCacheRaw = null;
    console.warn('snapshot parse error', e);
    return null;
  }
}
function getLocalState(taskId){
  const snap = loadSnapshot(); return (snap && snap.states) ? snap.states[String(taskId)] : null;
}
function getSnapshotState(taskId){
  if (!taskId) return null;
  const snap = loadSnapshot();
  return (snap && snap.states) ? snap.states[String(taskId)] : null;
}
function snapshotStateSubmitted(taskId){
  const state = getSnapshotState(taskId);
  return !!(state && state.submitted);
}
function snapshotStateHasCode(taskId){
  const state = getSnapshotState(taskId);
  if (!state) return false;
  return !isBlankCode(state.code || "");
}
function saveLocalState(taskId, overrideState = null){
  try{
    const snap = loadSnapshot() || {tasks: null, states: {}, fetchedAt: 0};
    if (!snap.states) snap.states = {};
    const stateKey = String(taskId);
    const existing = snap.states[stateKey] || {};
    const state = { ...existing };
    if (overrideState) {
      Object.assign(state, overrideState);
    } else {
      state.code = editor ? editor.getValue() : '';
      state.output = (document.getElementById('outputArea')||{}).textContent || '';
      state.hintOpened = !!hintOpened;
      state.submitted = !!taskSubmitted[taskId];
      state.savedAt = new Date().toISOString();
    }
    if (!state.savedAt) state.savedAt = new Date().toISOString();
    if (typeof state.submitted === 'undefined') state.submitted = !!taskSubmitted[taskId];
    if (typeof state.hintOpened === 'undefined') state.hintOpened = !!hintOpened;
    if (typeof state.code === 'undefined') state.code = editor ? editor.getValue() : '';
    if (typeof state.output === 'undefined') state.output = (document.getElementById('outputArea')||{}).textContent || '';
    if (typeof state.score === 'undefined') state.score = existing.score ?? '';
    if (typeof state.comment === 'undefined') state.comment = existing.comment ?? '';
    snap.states[stateKey] = state;
    const snapshotKey = _snapshotKey();
    const raw = JSON.stringify(snap);
    localStorage.setItem(snapshotKey, raw);
    snapshotCache = snap;
    snapshotCacheRaw = raw;
  } catch(e){ console.warn('saveLocalState failed', e); }
}
function setTaskDirty(taskId, dirty = true){
  if (!taskId) return;
  if (taskSubmitted[taskId]) { taskDirtyState[taskId] = false; return; }
  taskDirtyState[taskId] = !!dirty;
}
function markTaskDirty(taskId){
  if (!taskId) return;
  setTaskDirty(taskId, true);
}
function isTaskDirty(taskId){
  if (!taskId) return false;
  return !!taskDirtyState[taskId];
}
function markTaskSynced(taskId, state){
  if (!taskId) return;
  taskSyncedState[taskId] = state ? {
    code: state.code || '',
    output: state.output || '',
    hintOpened: !!state.hintOpened,
    submitted: !!state.submitted
  } : null;
  taskDirtyState[taskId] = false;
}
function getTaskSyncedState(taskId){
  return taskSyncedState[taskId] || null;
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

function getCacheKey(taskId){ const base = (localStorage.getItem('sessionId') || sessionStorage.getItem('sessionId') || userId || ''); return `cache_${base}_${taskId}`; }
function loadFromCache(taskId){
  try {
    const j=localStorage.getItem(getCacheKey(taskId));
    if (!j) return null;
    const obj = JSON.parse(j);
    if (obj && typeof obj.dirty !== "boolean") obj.dirty = false;
    return obj;
  } catch { return null; }
}
function saveToCache(taskId,data){
  try {
    if (typeof data.dirty === "undefined") data.dirty = isTaskDirty(taskId);
    localStorage.setItem(getCacheKey(taskId), JSON.stringify(data));
  } catch {}
}
function saveSelectedTaskId(taskId){ try { localStorage.setItem(SELECTED_KEY(), String(taskId||"")); } catch {} }
function loadSelectedTaskId(){ try { return localStorage.getItem(SELECTED_KEY()) || ""; } catch { return ""; } }

async function safeText(res){ try { return await res.text(); } catch { return ""; } }
function safeJson(text){ try { const cleaned=text.replace(/^[)\]\}'\s]+/,""); return JSON.parse(cleaned); } catch { return null; } }

function handleSessionExpired(){ alert('セッションがタイムアウトしました。再度ログインしてください。'); clearSession(); redirectToLogin(); }
