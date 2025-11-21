// main.js: 画面初期化エントリーポイント

window.addEventListener("DOMContentLoaded", () => { init(); });

async function init() {
  sessionId = localStorage.getItem('sessionId') || sessionStorage.getItem('sessionId') || '';
  userId    = localStorage.getItem('userId')    || sessionStorage.getItem('userId')    || '';
  userClass = localStorage.getItem('classId')   || sessionStorage.getItem('classId')   || '';
  userNumber= localStorage.getItem('number')    || sessionStorage.getItem('number')    || '';

  if (!sessionId) { redirectToLogin(); return; }

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
      persistSession(sessionId, userId, userClass, userNumber);
    }
  }

  const studentInfoDiv = document.getElementById("studentInfo");
  studentInfoDiv.textContent = `クラス:${userClass || "?"}　出席番号:${userNumber || "?"}`;

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

  initEditor();
  setupControls();

  const pyodidePromise = loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.22.1/full/" });

  await loadResults();

  pyodide = await pyodidePromise;

  if (typeof SharedArrayBuffer !== 'undefined') {
    interruptBuffer = new Int32Array(new SharedArrayBuffer(4));
    if (pyodide.setInterruptBuffer) pyodide.setInterruptBuffer(interruptBuffer);
  }

  const savedSelected = loadSelectedTaskId();
  if (savedSelected) {
    const found = tasksData.find(t => !t.isFolder && t.id === savedSelected);
    if (found) {
      selectTask(found.id);
      return;
    }
  }
  showNoSelectionState();
  try { enhanceCodingAssistFollow(); } catch(e){ console.warn('assist follow init failed', e); }
}
