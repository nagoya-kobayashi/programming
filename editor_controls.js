// editor_controls.js: CodeMirror と UI コントロール

const LINT_IDLE_MS = 2000; // 入力が止まってから構文チェックを走らせる待機時間
const FULL_WIDTH_SPACE = '\u3000';
const fullWidthSpaceOverlay = {
  token(stream) {
    if (stream.peek() === FULL_WIDTH_SPACE) {
      stream.next();
      const pos = typeof stream.pos === 'number' ? stream.pos : 0; // 連続した全角スペースを1文字ずつ別 span にする
      return `fullwidth-space fwspace-${pos}`;
    }
    while (!stream.eol()) {
      const ch = stream.next();
      if (ch === FULL_WIDTH_SPACE) {
        stream.backUp(1);
        break;
      }
    }
    return null;
  }
};

function initEditor() {
  editor = CodeMirror.fromTextArea(document.getElementById("editor"), {
    mode: "python", lineNumbers: true, indentUnit: 4, indentWithTabs: false, smartIndent: true,
    gutters: ["CodeMirror-lint-markers"], lint: { getAnnotations: pythonLinter, delay: LINT_IDLE_MS, lintOnChange: true }
  });
  editor.addOverlay(fullWidthSpaceOverlay);
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
  const blockSubmit = typeof isTaskExcluded === "function" && isTaskExcluded(currentTaskId);
  if (runBtn) runBtn.disabled = false;
  if (stopBtn) stopBtn.disabled = false;
  if (saveBtn) saveBtn.disabled = false;
  if (submitBtn) submitBtn.disabled = !!blockSubmit;
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
  const pyReady = !!(pyodide && typeof pyodide.runPythonAsync === 'function');
  console.debug('[lint] start', { len: text.length, pyodideReady: pyReady });
  if (!pyReady) {
    console.warn('[lint] skipped: pyodide not ready');
    return annotations;
  }
  try {
    pyodide.globals.set('lint_source', text);
    await pyodide.runPythonAsync(`
import json, ast, builtins, keyword
lint_text = str(lint_source)
lines = lint_text.splitlines()
def line_at(n):
    if n <= 0: return ""
    if n <= len(lines):
        return lines[n-1]
    return ""
try:
    compile(lint_text, '<input>', 'exec')
except SyntaxError as e:
    detail = {
        'line': e.lineno or 1,
        'col': e.offset or 1,
        'msg': e.msg,
        'text': e.text or '',
        'code': getattr(e, 'code', None),
        'filename': e.filename or '',
        'kind': 'syntax'
    }
    raise RuntimeError(json.dumps(detail))

tree = ast.parse(lint_text, '<input>', 'exec')
builtins_set = set(dir(builtins))
kwset = set(keyword.kwlist)
undefined = None

def collect_store(target, scope):
    if isinstance(target, ast.Name):
        scope.add(target.id)
    elif isinstance(target, (ast.Tuple, ast.List)):
        for elt in target.elts:
            collect_store(elt, scope)

def walk(node, scope):
    global undefined
    if undefined is not None:
        return
    if isinstance(node, ast.Import):
        for alias in node.names:
            scope.add(alias.asname or alias.name.split(".")[0])
        return
    if isinstance(node, ast.ImportFrom):
        for alias in node.names:
            scope.add(alias.asname or alias.name.split(".")[0])
        return
    if isinstance(node, ast.Assign):
        for t in node.targets:
            collect_store(t, scope)
        walk(node.value, scope)
        return
    if isinstance(node, ast.AugAssign):
        walk(node.value, scope)
        collect_store(node.target, scope)
        return
    if isinstance(node, (ast.For, ast.AsyncFor)):
        walk(node.iter, scope)
        collect_store(node.target, scope)
        for b in node.body: walk(b, scope)
        for b in node.orelse: walk(b, scope)
        return
    if isinstance(node, ast.With):
        for item in node.items:
            if item.optional_vars: collect_store(item.optional_vars, scope)
            walk(item.context_expr, scope)
        for b in node.body: walk(b, scope)
        return
    if isinstance(node, ast.FunctionDef):
        scope.add(node.name)
        new_scope = set(scope)
        for arg in node.args.args + node.args.kwonlyargs:
            new_scope.add(arg.arg)
        if node.args.vararg: new_scope.add(node.args.vararg.arg)
        if node.args.kwarg: new_scope.add(node.args.kwarg.arg)
        for d in node.decorator_list: walk(d, scope)
        for d in node.args.defaults: walk(d, scope)
        for d in node.args.kw_defaults: 
            if d: walk(d, scope)
        for b in node.body: walk(b, new_scope)
        return
    if isinstance(node, ast.AsyncFunctionDef):
        walk(ast.FunctionDef(name=node.name, args=node.args, body=node.body, decorator_list=node.decorator_list, returns=node.returns, type_comment=node.type_comment), scope)
        return
    if isinstance(node, ast.ClassDef):
        scope.add(node.name)
        for b in node.bases: walk(b, scope)
        for kw in node.keywords: walk(kw.value, scope)
        for d in node.decorator_list: walk(d, scope)
        for b in node.body: walk(b, scope)
        return
    if isinstance(node, ast.Name):
        if isinstance(node.ctx, ast.Load):
            if node.id not in scope and node.id not in builtins_set and node.id not in kwset and undefined is None:
                undefined = (node.id, node.lineno or 1, (node.col_offset or 0)+1)
        return
    for child in ast.iter_child_nodes(node):
        walk(child, scope)

walk(tree, set())
if undefined:
    name, ln, col = undefined
    detail = {
        'line': ln,
        'col': col,
        'msg': f"未定義の変数: {name}",
        'text': line_at(ln),
        'kind': 'undefined',
        'name': name
    }
    raise RuntimeError(json.dumps(detail))

`);
    console.debug('[lint] compile ok');
  }
  catch(err){
    let msg = err && err.message ? String(err.message) : err.toString();
    let line = 0;
    let col = 0;
    let badChar = null;
    let serverLineText = '';
    let rawLine = 1;
    let rawCol = 1;
    const parseDetail = (raw) => {
      if (!raw) return null;
      const s = String(raw);
      // 1) 直接 JSON として解釈
      try { return JSON.parse(s); } catch(_) {}
      // 2) RuntimeError: {...} の {...} 抜き出し
      const mRuntime = s.match(/RuntimeError:\s*(\{[\s\S]+\})/);
      if (mRuntime) {
        try { return JSON.parse(mRuntime[1]); } catch(_) {}
      }
      // 3) "line": n を含む最初の JSON ブロックを抜き出し
      const mJson = s.match(/(\{[\s\S]*?"line"\s*:\s*\d+[\s\S]*?\})/);
      if (mJson) {
        try { return JSON.parse(mJson[1]); } catch(_) {}
      }
      return null;
    };
    const detail = parseDetail(msg) || parseDetail(err && err.toString());
    if (detail) {
      msg = detail.msg || msg;
      rawLine = detail.line || 1;
      rawCol = detail.col || 1;
      line = Math.max(0, rawLine - 1);
      col = Math.max(0, rawCol - 1);
      serverLineText = detail.text || '';
    } else {
      const mLine = msg.match(/line (\d+)/i);
      if (mLine) { rawLine = parseInt(mLine[1],10) || 1; line = Math.max(0, rawLine - 1); }
      const mCol = msg.match(/column (\d+)/i);
      if (mCol) { rawCol = parseInt(mCol[1],10) || 1; col = Math.max(0, rawCol - 1); }
    }
    // invalid character の場合はメッセージ内の文字 or U+コードを元に、最初に登場する位置を上から強調する
    const mChar = msg.match(/character '([^']+)'/i);
    const mCode = msg.match(/U\+([0-9A-Fa-f]{4,6})/);
    if (mChar || mCode) {
      badChar = mChar ? mChar[1] : '';
      try { badChar = badChar ? JSON.parse(`"${badChar}"`) : badChar; } catch(_) {}
      if (!badChar && mCode) {
        try { badChar = String.fromCodePoint(parseInt(mCode[1], 16)); } catch(_) {}
      }
      const idx = badChar ? text.indexOf(badChar) : -1;
      if (idx >= 0) {
        const prefix = text.slice(0, idx);
        const prefixLines = prefix.split(/\r?\n/);
        line = Math.max(0, prefixLines.length - 1);
        col = Math.max(0, (prefixLines[prefixLines.length - 1] || '').length);
      }
    }
    const lines = text.split(/\r?\n/);
    const safeLine = Math.max(0, Math.min(line, lines.length - 1));
    const lineTextRaw = lines[safeLine] || '';
    const lineText = serverLineText || lineTextRaw;
    // col は 1-origin なので 0-origin に補正
    let startCh = Math.max(0, Math.min(col, lineText.length ? lineText.length - 1 : 0));
    // サーバー側の text が与えられている場合は offset を優先
    if (serverLineText && col < serverLineText.length) {
      startCh = Math.max(0, col);
    }
    // invalid character がある場合は、その行テキスト内での位置を優先する
    if (badChar) {
      const idxInServer = serverLineText ? serverLineText.indexOf(badChar) : -1;
      const idxInRaw = lineTextRaw ? lineTextRaw.indexOf(badChar) : -1;
      const picked = idxInServer >= 0 ? idxInServer : idxInRaw;
      if (picked >= 0) startCh = picked;
    }
    // invalid decimal literal などで badChar が無い場合、行テキスト内の非 ASCII を拾ってみる
    if (!badChar && /invalid decimal literal/i.test(msg) && lineText) {
      const firstNonAscii = lineText.split('').findIndex(ch => ch.charCodeAt(0) > 127);
      if (firstNonAscii >= 0) {
        badChar = lineText[firstNonAscii];
        startCh = firstNonAscii;
      }
    }
    // invalid syntax で badChar が無く、直前が識別子の場合はその語を強調する（retarn などのスペルミス想定）
    if (!badChar && /invalid syntax/i.test(msg) && startCh > 0) {
      // 現在位置より左にある直前の識別子を優先して強調（retarn などのスペルミス想定）
      const prefixOnly = lineText.slice(0, Math.min(startCh, lineText.length));
      const mPrev = prefixOnly.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
      if (mPrev && typeof mPrev.index === 'number') {
        const word = mPrev[1];
        const wordStart = prefixOnly.lastIndexOf(word);
        if (wordStart >= 0) {
          badChar = word;
          startCh = wordStart;
        }
      }
    }
    const endChRaw = Math.min(lineText.length, startCh + Math.max(1, badChar ? badChar.length : 1));
    const endCh = endChRaw > startCh ? endChRaw : startCh + 1;
    console.warn('[lint] syntax error', {
      msg,
      rawLine,
      rawCol,
      reportedLine: line + 1,
      usedLine: safeLine + 1,
      col: col + 1,
      serverLineText,
      lineTextRaw,
      badChar,
      startCh,
      endCh
    });
    annotations.push({
      from: CodeMirror.Pos(safeLine, startCh),
      to: CodeMirror.Pos(safeLine, endCh),
      message: msg,
      severity:'error'
    });
  } finally {
    try { pyodide.globals.delete('lint_source'); } catch(_) {}
  }
  console.debug('[lint] done', { count: annotations.length });
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
