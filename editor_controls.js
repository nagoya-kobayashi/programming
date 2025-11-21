// editor_controls.js: CodeMirror と UI コントロール

function initEditor() {
  editor = CodeMirror.fromTextArea(document.getElementById("editor"), {
    mode: "python", lineNumbers: true, indentUnit: 4, indentWithTabs: false, smartIndent: true,
    gutters: ["CodeMirror-lint-markers"], lint: { async: true, getAnnotations: pythonLinter }
  });
  editor.on("change", (_instance, changeObj) => {
    syncGhostScroll();
    enableSaveSubmitButtons();
    if (changeObj && changeObj.origin !== "setValue" && currentTaskId && !taskSubmitted[currentTaskId]) {
      markTaskDirty(currentTaskId);
      updateStatusIcon("editing");
      applyResultsToList();
      updateStatusBadges();
    } else {
      updateStatusBadges();
      applyResultsToList();
    }
  });
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
  const cm = editor.getScrollerElement();
  const ghost = document.getElementById("ghostText");
  ghost.scrollTop = cm.scrollTop;
  ghost.scrollLeft = cm.scrollLeft;
}

function updateGhostVisibility() {
  const assistOn = document.getElementById("assistToggle").checked;
  document.getElementById("ghostText").style.display = assistOn ? "block" : "none";
}

function setupControls() {
  document.getElementById("playButton").addEventListener("click", () => {
    // 実行中の保存は行わない（出力が混在した際の保存ズレを防ぐため）
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
    logoutBtn.addEventListener('click', () => {
      clearSession();
      redirectToLogin();
    });
  }

  updatePlayStopButtons();
}

function disableSaveButton(){ document.getElementById("saveButton").disabled = true; }

function enableSaveSubmitButtons(){
  const runBtn = document.getElementById("playButton");
  const stopBtn = document.getElementById("stopIconButton");
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
  div.textContent = msg;
  div.classList.remove('success','error');
  div.classList.add(type==='error'?'error':'success');
  if (statusTimerId) clearTimeout(statusTimerId);
  statusTimerId = setTimeout(()=>{ div.textContent=''; div.classList.remove('success','error'); statusTimerId=null; }, 10000);
}

function enhanceCodingAssistFollow(){
  // 既存アシスト UI を追従させる
  const candidates = [
    '#codingAssist', '.coding-assist', '#assistPanel', '#assistOverlay', '#assist', '[data-role="coding-assist"]'
  ];
  let assistEl = null;
  for (const sel of candidates){
    const el = document.querySelector(sel);
    if (el){ assistEl = el; break; }
  }
  if (!assistEl){ return; } // 見つからない場合は何もしない

  assistEl.classList.add('coding-assist-boost', 'coding-assist-follow');

  let scroller = null;
  try {
    if (editor && typeof editor.getScrollerElement === 'function') {
      scroller = editor.getScrollerElement();
    }
  } catch(_) {}
  if (!scroller){
    scroller = document.querySelector('.cm-editor .cm-scroller, .cm-editor .cm-content') ||
               document.querySelector('.cm-editor') ||
               document.querySelector('.CodeMirror-scroll, .CodeMirror-sizer') ||
               document.getElementById('editor');
  }
  if (!scroller){ return; }

  const sync = () => {
    const st = scroller.scrollTop || 0;
    const sl = scroller.scrollLeft || 0;
    assistEl.style.transform = `translate(${sl}px, ${st}px)`;
  };

  sync();
  scroller.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('resize', sync);
}

async function pythonLinter(text){
  const annotations=[]; if(!text.trim()) return annotations;
  if (!pyodide || typeof pyodide.runPythonAsync !== 'function') return annotations;
  try { await pyodide.runPythonAsync(`compile(${JSON.stringify(text)}, '<input>', 'exec')`); }
  catch(err){
    const msg=err.toString();
    const m=msg.match(/line (\d+)/);
    const line=m?parseInt(m[1],10)-1:0;
    annotations.push({ from: CodeMirror.Pos(line,0), to: CodeMirror.Pos(line,1), message: msg, severity:'error' });
  }
  return annotations;
}

function updatePlayStopButtons(){
  const p=document.getElementById("playButton");
  const s=document.getElementById("stopIconButton");
  if(running){
    if (p) p.hidden=true;
    if (s) s.hidden=false;
  } else {
    if (p) p.hidden=false;
    if (s) s.hidden=true;
  }
}
