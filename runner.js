// runner.js: Pyodide 実行／Worker 管理

const IS_FILE_ORIGIN = (location.protocol === 'file:');
// stdout に流す入力要求マーカー（フォールバック用）
// 実行識別子（前回実行からの遅延メッセージを捨てるためのトークン）
let currentRunToken = 0;
window.__activeRunToken = 0; // 入力UI側でも参照
const INPUT_MARK = '<<<INPUT>>>';
const PLOT_MARK  = '<<<PLOT>>>';   // 画像データURIをstdout経由で受け取るマーカー
const SLEEP_MARK = '<<<SLEEP>>>';  // time.sleep の開始/終了をstdout経由で通知
// 画像送信用（Worker経由では postMessage、フォールバックでは直接呼び出し）
let awaitingInputUI = false; // 二重UI防止
const INPUT_CANCEL = '__INPUT_CANCELLED__'; // 入力UIキャンセル時の番兵
let __pendingInput = null; // {resolve,reject} を保持（停止時に確実に解消）
// --- 追加: コードが matplotlib を使うかの軽量判定 ---
function needsMatplotlib(code){
  const s = String(code || '');
  // 代表的な書き方を幅広く捕捉（誤検知を極力避けつつ軽量）
  return /(^|\n)\s*(from\s+matplotlib\b|import\s+matplotlib(\.pyplot)?\b)/.test(s)
         || /\bpyplot\s*\./.test(s);
}
// メインスレッド実行時用：JS側で入力UIを出し、その結果をPromiseで返す関数をPythonからawaitする
// （Worker実行時は使われず、従来の postMessage / stdout マーカーで動作）
window.__input_async = function(promptText){
  // 連打防止：既に入力待ちならその完了を待つ
  if (awaitingInputUI) {
    return new Promise((resolve) => {
      const chk = setInterval(() => {
        if (!awaitingInputUI) {
          clearInterval(chk);
          resolve(window.__input_async(promptText));
        }
      }, 10);
    });
  }
  awaitingInputUI = true;
  pauseExecTimer(); // 入力待ちはタイマー停止
  return new Promise((resolve) => {
    showInlineInput(String(promptText || '')).then((val) => {
      resumeExecTimer();
      awaitingInputUI = false;
      resolve(String(val ?? ''));
    });
  });
};


// stdout 正規化: 改行を保証し、CRLF→LF 変換＆リテラル "\\n" → 実改行も復元
function appendStdoutNormalized(text){
  let t = String(text);
  t = t.replace(/\r\n/g, "\n");
  t = t.replace(/\\n/g, "\n");
  if (!t.endsWith("\n")) t += "\n";
  appendOutput(t);
}
// 画像（data URL）を実行結果に追加
function appendPlotDataUrl(dataUrl){
  // 実装上の正式IDは #output。旧互換で #outputArea もフォールバックとして許容。
  const a = document.getElementById("output") || document.getElementById("outputArea");
  const img = document.createElement('img');
  img.src = String(dataUrl);
  img.alt = 'plot';
  // 見え方を安定させる（<pre>内でも崩れない）
  img.style.display = 'block';
  img.style.maxWidth = '100%';
  img.style.marginTop = '6px';
  img.decoding = 'async';
  a.appendChild(img);
  outputBuffer += `[plot]\n`;
  try { a.scrollTop = a.scrollHeight; } catch(_) {}
}

// file:// で外部 worker を読めない環境向け：インラインWorkerのソース生成（正規表現置換は使わない）
function buildInlineWorkerSource(){
  return [
    "// inline py_worker (blob)",
    "let pyodide=null; let interruptBuffer=null; let running=false; let curToken=0;",
    "self.onmessage=async(ev)=>{",
    "  const msg=ev.data||{};",
    "  try{",
    "    if(msg.type==='init'){",
    "      if(!pyodide){",
    "        importScripts('https://cdn.jsdelivr.net/pyodide/v0.22.1/full/pyodide.js');",
    "        pyodide=await loadPyodide();",
    "        pyodide.setStdout({batched:(s)=>postMessage({type:'stdout',token:curToken,data:s})});",
    "        pyodide.setStderr({batched:(s)=>postMessage({type:'stderr',token:curToken,data:s})});",
    "      }",
    "      try{",
    "        if(typeof SharedArrayBuffer!=='undefined' && pyodide.setInterruptBuffer && !interruptBuffer){",
    "          interruptBuffer=new Int32Array(new SharedArrayBuffer(4));",
    "          pyodide.setInterruptBuffer(interruptBuffer);",
    "        }",
    "      }catch(e){}",
    "      postMessage({type:'log', message:'pyodide ready (inline worker)'});",
    "      postMessage({type:'ready', canInterrupt: !!interruptBuffer});",
    "      return;",
    "    }",
    "    if(msg.type==='stop'){ try{ if(interruptBuffer) interruptBuffer[0]=2; }catch(e){} return; }",
    "    if(msg.type==='input_response'){",
    "      const v=String(msg.value ?? '');",
    "      // v を安全に Python 文字列リテラル化してキューへ投入",
    "      await pyodide.runPythonAsync('import asyncio\\n__input_queue.put_nowait(' + JSON.stringify(v) + ')');",
    "      return;",
    "    }",
    "    if(msg.type==='run'){",
    "      curToken = msg.token || 0;",
    "      self.curToken = curToken;", // ★ Python 側から js.curToken で参照させる
    "      if(!pyodide){ postMessage({type:'error',message:'Pyodide not ready'}); return; }",
    "      if(running){ postMessage({type:'error',message:'already running'}); return; }",
    "      running=true;",
    "      try{",
    "        const userCode=String(msg.code||'');",
    "        if (msg.needsMatplotlib) { try{ await pyodide.loadPackage(['matplotlib']); }catch(_){ } }", // ★ 必要時のみ
    "        const body=userCode.split('\\n').map(l=>'    '+l).join('\\n');",
    "        const patched=body.replace(/(^|[^A-Za-z0-9_])input\\s*\\(/g,'$1await __await_input__(');",
    "        const wrapped = ",
    "          [",
    "            'import js, asyncio',",
    "            \"# ---- pyplot をPNGでメインへ送る仕組み ----\",",
    "            'try:',",
    "            '    import matplotlib; matplotlib.use(\"module://matplotlib_pyodide\", force=True)',",
    "            '    from matplotlib import pyplot as plt',",
    "            '    plt.ioff()',",
    "            '    import io, base64',",
    "            '    def __flush_plots__():',",
    "            '        try:',",
    "            '            fids = list(plt.get_fignums())',",
    "            '            for fid in fids:',",
    "            '                fig = plt.figure(fid)',",
    "            '                try:',",
    "            '                    fig.canvas.draw()',",
    "            '                    buf = io.BytesIO()',",
    "            '                    fig.savefig(buf, format=\"png\", bbox_inches=\"tight\")',",
    "            '                    buf.seek(0)',",
    "            '                    b64 = base64.b64encode(buf.getvalue()).decode(\"ascii\")',",
    "            '                    js.postMessage({\"type\":\"plot\",\"token\":js.curToken,\"data\":\"data:image/png;base64,\"+b64})',",
    "            '                finally:',",
    "            '                    plt.close(fig)',",
    "            '        except Exception as _e:',",
    "            '            pass',",
    "            '    def __plt_show_patch__(*args, **kwargs):',",
    "            '        __flush_plots__()',",
    "            '    try:',",
    "            '        plt.show = __plt_show_patch__',",
    "            '    except:',",
    "            '        pass',",
    "            'except Exception as _e:',",
    "            '    pass',",
    "            '__input_queue = asyncio.Queue()',",
    "            'async def __await_input__(prompt=\"\"):',",
    "            '    p = str(prompt) if prompt is not None else \"\"',",
    "            '    try:',",
    "            '        js.postMessage({\"type\":\"input_request\",\"token\":js.curToken,\"prompt\":p})',",
    "            '    except Exception as _e:',",
    "            '        pass',",
    "            '    print(\"<<<INPUT>>>\"+p)',",
    "            '    v = await __input_queue.get()',",
    "            '    return str(v)',",
    "            'async def __user_main():'",
    "          ].join('\\n')",
    "          + '\\n' + patched + '\\n' + [",
    "            'await __user_main()',",
    "            'try:',",
    "            '    __flush_plots__()',",
    "            '    plt.close(\"all\")',",
    "            'except:',",
    "            '    pass'",
    "          ].join('\\n');",    "        await pyodide.runPythonAsync(wrapped);",
    "        postMessage({type:'done',token:curToken});",
    "      }catch(e){",
    "        const m=String(e||'');",
    "        if(m.includes('KeyboardInterrupt')) postMessage({type:'stopped',token:curToken});",
    "        else postMessage({type:'error',token:curToken,message:m});",
    "      }finally{",
    "        try{ if(interruptBuffer) interruptBuffer[0]=0; }catch(e){}",
    "        running=false;",
    "      }",
    "      return;",
    "    }",
    "  }catch(e){ postMessage({type:'error',message:String(e||'worker error')}); }",
    "};"
  ].join("\\n");
}

function getWorkerUrl(){
  if (!IS_FILE_ORIGIN) return 'py_worker.js'; // HTTP/HTTPS では従来通り外部ファイル
  try{
    const src = buildInlineWorkerSource();
  // Edge/Chrome の file:// では MIME を text/javascript にした方が安定
  const blob = new Blob([src], { type: 'text/javascript' });
    const url  = URL.createObjectURL(blob);
    console.log('[Main] inline worker fallback (file://) enabled');
    return url;
  }catch(e){
    console.warn('[Main] inline worker fallback failed', e);
    return 'py_worker.js';
  }
}

// 採点結果

/* ===== 実行タイムアウト（入力待ちはカウントしない） ===== */
// 10秒で自動停止（必要に応じて変更可）。0で無効化。
const EXEC_TIMEOUT_MS = 10000;
let __execTimeoutId = null;
let __timeoutTriggered = false;
let __remainingMs = 0;
let __segmentStartMs = 0;
function _clearExecTimer(){ try{ clearTimeout(__execTimeoutId); }catch{} __execTimeoutId=null; }
function _triggerTimeout(){
  __timeoutTriggered = true;
  try {
    // Worker 実行時は stop メッセージで KeyboardInterrupt を誘発
    if (pyWorker) {
      pyWorker.postMessage({ type: 'stop' });
    } else if (window.interruptBuffer) {
      window.interruptBuffer[0] = 2;
    }
  } catch(e){ console.warn('[Main] timeout interrupt error', e); }
}
function startExecTimer(){
  __timeoutTriggered = false;
  if (EXEC_TIMEOUT_MS <= 0) return;
  __remainingMs = EXEC_TIMEOUT_MS;
  __segmentStartMs = Date.now();
  _clearExecTimer();
  __execTimeoutId = setTimeout(_triggerTimeout, __remainingMs);
}
function pauseExecTimer(){
  if (EXEC_TIMEOUT_MS <= 0 || __timeoutTriggered) return;
  const now = Date.now();
  const elapsed = Math.max(0, now - __segmentStartMs);
  __remainingMs = Math.max(0, __remainingMs - elapsed);
  _clearExecTimer();
}
function resumeExecTimer(){
  if (EXEC_TIMEOUT_MS <= 0 || __timeoutTriggered) return;
  if (__remainingMs <= 0) { _triggerTimeout(); return; }
  __segmentStartMs = Date.now();
  _clearExecTimer();
  __execTimeoutId = setTimeout(_triggerTimeout, __remainingMs);
}
// ===== Worker を強制終了して状態を初期化（同時実行や連打での不安定化対策） =====
function hardKillWorker(reason){
  // 以降の遅延メッセージを無効化
  currentRunToken = (currentRunToken + 1) | 0;
  window.__activeRunToken = currentRunToken;
  try{ if (__stopFallbackTimer){ clearTimeout(__stopFallbackTimer); __stopFallbackTimer=null; } }catch{}
  // ぶら下がっている入力待ちを必ずキャンセル解決して次回の input を有効化
  try{ cancelPendingInputUI('hardKill:'+ (reason||'')); }catch{}
  if (pyWorker){
    try{ pyWorker.terminate(); }catch(_){}
    pyWorker = null;
    workerReady = false;
  }
  awaitingInputUI = false;
  // メインスレッド実行中なら割り込み
  try{ if (interruptBuffer) interruptBuffer[0] = 2; }catch{}
  cleanupAfterRun();
  console.warn('[Main] hardKillWorker:', reason || '(no reason)');
}
/* ===== Pyodide 実行を Web Worker に委譲 ===== */
function ensurePyWorker(){
  if (pyWorker && workerReady) return workerInitPromise;
  workerInitPromise = new Promise((resolve, reject) => {
    try{
      // file:// の場合は Blob URL ワーカーへフォールバック
      pyWorker = new Worker(getWorkerUrl());
      // Worker 側の実行エラーを可視化
      pyWorker.onerror = (e) => {
        console.error('[Worker error]', e.message, e.filename, e.lineno, e.colno);
      };
      pyWorker.onmessage = async (ev) => {
        const msg = ev.data || {};
        switch(msg.type){
          case 'ready':
            workerReady = true;
            workerCanInterrupt = !!msg.canInterrupt;
            if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
            resolve();
            break;
          case 'log':
            console.log('[Worker]', msg.message);
            break;
          case 'stdout': {
            if (msg.token === currentRunToken) { await handleStdoutChunk(String(msg.data || '')); }
            break;
          }          case 'stderr':
            if (msg.token === currentRunToken) { appendStdoutNormalized(String(msg.data || '')); }
            break;
          case 'input_request': { // 入力待ちはタイマー停止→入力→再開
            if (msg.token === currentRunToken && !awaitingInputUI) {
              awaitingInputUI = true;
              pauseExecTimer();
              const val = await showInlineInput(String(msg.prompt || ''));
              resumeExecTimer();
              pyWorker.postMessage({ type: 'input_response', value: val });
              awaitingInputUI = false;
            }
            break;
          }
          case 'plot': {
            // 受信可視化＆古い実行からの迷い込みを明示
            const ok = (msg.token === currentRunToken);
            console.log('[Worker] plot received', { token: msg.token, current: currentRunToken, accept: ok });
            if (!ok) {
              console.log('[Worker] plot dropped (stale)');
              break;
            }
            appendPlotDataUrl(String(msg.data || ''));
            break;
          }
          case 'plot-debug': {
            // 描画デバッグ（flushの開始/終了/例外）
            console.log('[Worker] plot-debug', msg);
            break;
          }
          case 'stopped':
            if (msg.token !== currentRunToken) break;
            try{ cancelPendingInputUI('worker-stopped'); }catch{}
            if (__timeoutTriggered) {
              appendOutput(`時間超過（${Math.round(EXEC_TIMEOUT_MS/1000)}秒）で実行を停止しました。\n`);
            } else {
              appendOutput("実行を中断しました（KeyboardInterrupt）。\n");
            }
            cleanupAfterRun();
            break;
          case 'done':
            if (msg.token !== currentRunToken) break;
            cleanupAfterRun();
            break;
          case 'error':
            if (msg.token === currentRunToken) { appendOutput(String(msg.message || '実行エラー') + '\n'); }
            cleanupAfterRun();
            break;
        }
      };
      // Worker の ready を待つが、来なければフォールバック
      var readyTimer = setTimeout(() => {
        if (!workerReady) {
          console.warn('[Main] worker init timeout → fallback to main-thread execution');
          try { pyWorker.terminate(); } catch {}
          pyWorker = null; // 明示的に無効化
          reject(new Error('worker-timeout'));
        }
      }, 15000); // ★ 5秒→15秒。学内ネット回線での初回読込遅延に耐える
      pyWorker.postMessage({ type: 'init' });
    }catch(e){ reject(e); }
  });
  return workerInitPromise;
}

function cleanupAfterRun(){
  try { _clearExecTimer(); } catch {}
  try { if (interruptBuffer) interruptBuffer[0] = 0; } catch {}
  running=false; updatePlayStopButtons();
  // 実行後の自動保存（既存仕様）
  try {
    if (currentTaskId && !taskSubmitted[currentTaskId]) {
      const codeNow = editor ? editor.getValue() : '';
      const outNow  = outputBuffer;
      saveToCache(currentTaskId, { code: codeNow, output: outNow, hintOpened, submitted: false, dirty: true });
      // 実行後もサーバ保存はしない（ローカルのみ）
      applyResultsToList(); updateStatusBadges();
    }
    if (currentTaskId) saveLocalState(currentTaskId);
  } catch(e){}
}

// stdout を監視して、INPUT と PLOT の両マーカーを“行単位”で処理
async function handleStdoutChunk(s){
  let rest = String(s);
  while (rest.length) {
    const iInput = rest.indexOf(INPUT_MARK);
    const iPlot  = rest.indexOf(PLOT_MARK);
    const iSleep = rest.indexOf(SLEEP_MARK);
    // どのマーカーも無ければ残りを出力して終了
    if (iInput < 0 && iPlot < 0 && iSleep < 0) { appendStdoutNormalized(rest); break; }
    // 次に現れるマーカーを決定
    let kind = null, idx = -1, mark = '';
    const first = [ ['input', iInput, INPUT_MARK], ['plot', iPlot, PLOT_MARK], ['sleep', iSleep, SLEEP_MARK] ]
      .filter(([_,pos]) => pos >= 0)
      .sort((a,b)=>a[1]-b[1])[0];
    kind = first[0]; idx = first[1]; mark = first[2];
    // マーカー前は通常出力
    const before = rest.slice(0, idx);
    if (before) appendStdoutNormalized(before);
    // マーカー行の本文（次の改行手前まで）
    const after = rest.slice(idx + mark.length);
    const nl = after.indexOf("\n");
    const payload = nl >= 0 ? after.slice(0, nl) : after;
    if (kind === 'input') {
      if (!awaitingInputUI) {
        awaitingInputUI = true;
        pauseExecTimer();
        const val = await showInlineInput(String(payload || ''));
        resumeExecTimer();
        if (val !== INPUT_CANCEL) {
          if (pyWorker) pyWorker.postMessage({ type: 'input_response', value: val });
          else { try { await pyodide.runPythonAsync(`__input_queue.put_nowait(${JSON.stringify(String(val))})`); } catch(_){} }
        }
        awaitingInputUI = false;
      }
    } else if (kind === 'plot') {
      // 画像データURIをUIへ反映（出力テキストには残さない）
      appendPlotDataUrl(String(payload || ''));
    } else if (kind === 'sleep') {
      // time.sleep の開始/終了（stdout 経由通知）
      const p = String(payload || '').trim().toLowerCase();
      if (p.startsWith('start')) pauseExecTimer();
      else resumeExecTimer();
    }
    // 残りを続けて処理
    rest = nl >= 0 ? after.slice(nl + 1) : "";
  }
}


// 出力欄に「横入力欄」を出して Enter で解決（既存仕様を関数化）
async function showInlineInput(promptText){
  const outEl = document.getElementById("outputArea") || document.getElementById("output");
  const scrollToBottom = () => { if (outEl) outEl.scrollTop = outEl.scrollHeight; };
  if (promptText) appendOutput(String(promptText)); // 左側にプロンプト表示（改行なし）
  return new Promise((resolve) => {
    const wrap = document.createElement("span");
    wrap.className = "inline-input";
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.placeholder = "";
    wrap.appendChild(input);
    outEl.appendChild(wrap);
    input.focus();
    scrollToBottom();
    const submit = () => {
      const val = input.value ?? "";
      wrap.remove();
      appendOutput(val + "\n"); // 入力値は改行付きで残す
      scrollToBottom();
      resolve(val);
    };
    input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
  });
}

async function runCode() {
  // 既存のワーカーが残っていれば強制終了（Run 連打／前回停止失敗の保険）
  if (pyWorker) { hardKillWorker('run-start-cleanup'); }

  clearOutput(); enableSaveSubmitButtons();
  // Run開始時にも念のため未解決の入力をキャンセル（連打・前回停止直後の保険）
  try{ cancelPendingInputUI('run-start'); }catch{}
  // 実行トークンを更新
  currentRunToken = (currentRunToken + 1) | 0;
  window.__activeRunToken = currentRunToken;
  const myToken = currentRunToken;
  let code = editor ? editor.getValue() : '';
  const indentSize = editor && editor.getOption ? editor.getOption('indentUnit') || 4 : 4;
  code = code.replace(/\t/g, ' '.repeat(indentSize));
  if (!code.trim()) { appendOutput("実行するコードがありません。\n"); return; }
  if (currentTaskId && !taskSubmitted[currentTaskId]) {
    markTaskDirty(currentTaskId);
    updateStatusIcon('editing');
    applyResultsToList();
    updateStatusBadges();
  }
  running = true; updatePlayStopButtons();
  if (interruptBuffer) interruptBuffer[0] = 0; enableSaveSubmitButtons();
  startExecTimer();  // 入力待ちは pause/resume される
  // 先に input() を確実に await へ置換（Worker 側の置換失敗に備える）
  // 1) input() → await __await_input__(
  let patched = code.replace(/(^|[^A-Za-z0-9_])input\s*\(/g, '$1await __await_input__(');
  // 2) time.sleep() → await __sleep__(
  if (/\btime\s*\.\s*sleep\s*\(/.test(patched)) {
    patched = patched.replace(/\btime\s*\.\s*sleep\s*\(/g, 'await __sleep__(');
  }
  // 3) from time import sleep がある場合の素の sleep() も置換
  if (/^\s*from\s+time\s+import\s+sleep\b/m.test(code) && /(^|[^A-Za-z0-9_])sleep\s*\(/.test(patched)) {
    patched = patched.replace(/(^|[^A-Za-z0-9_])sleep\s*\(/g, '$1await __sleep__(');
  }
  const isPrePatched   = (patched !== code);
  const prePatchedCode = patched;
  const useMPL = needsMatplotlib(prePatchedCode);
  // Worker 初期化に失敗したら main-thread 実行へフォールバック
  try {
    await ensurePyWorker();
    // 実行依頼（前置換済みかどうかを通知）
    pyWorker.postMessage({
      type: 'run',
      code: prePatchedCode,
      prePatched: isPrePatched,
      token: myToken,
      needsMatplotlib: useMPL
    });
  } catch (e) {
    console.warn('[Main] worker unavailable, fallback to main-thread run:', e && e.message);
    await runCodeInMainThread(prePatchedCode, myToken, useMPL); // フォールバック時も前置換済みを使う
  }
}

/**
 * Worker が使えない環境(file:// 等)向けフォールバック実行
 * - stdout/stderr をメインで受けて handleStdoutChunk を通す（INPUT_MARK 検出で input UI）
 * - 停止ボタン／10秒タイムアウトは main-thread の interruptBuffer で継続利用
 */
async function runCodeInMainThread(userCode, myToken, useMPL){
  try {
    // Pyodide が未ロードの環境でも自己ロードしてから実行
    await ensurePyodideMain();
    // ★ 必要なときだけ matplotlib を読み込む
    if (useMPL) {
      try { await pyodide.loadPackage(['matplotlib']); } catch(_) {}
    }
    // 出力をフック（print や フォールバック input マーカーを拾う）
    if (pyodide && pyodide.setStdout) {
      pyodide.setStdout({ batched: (s) => { if (myToken === currentRunToken) handleStdoutChunk(String(s)); } });
    }
    if (pyodide && pyodide.setStderr) {
      pyodide.setStderr({ batched: (s) => { if (myToken === currentRunToken) appendStdoutNormalized(String(s)); } });
    }
    // 入力UIもトークンでガード
    const prevInputAsync = window.__input_async;
    window.__input_async = function(promptText){
      if (myToken !== currentRunToken) return Promise.resolve("");
      return prevInputAsync(promptText);
    };
    const body = String(userCode||'').split('\n').map(l => '    ' + l).join('\n');
    const wrapped = [
      'import js, asyncio',
      '# pyplot をPNGで送るパッチ',
      'try:',
      '    import matplotlib',
      '    matplotlib.use("Agg", force=True)',
      '    from matplotlib import pyplot as plt',
      '    from matplotlib.backends.backend_agg import FigureCanvasAgg as FigureCanvas',
      '    plt.ioff()',
      '    import io, base64',
      '    def __flush_plots__():',
      '        try:',
      '            fids = list(plt.get_fignums())',
      '            for fid in fids:',
      '                fig = plt.figure(fid)',
      '                if not getattr(fig, "canvas", None):',
      '                    FigureCanvas(fig)',
      '                try:',
      '                    fig.canvas.draw()',
      '                    buf = io.BytesIO()',
      '                    fig.savefig(buf, format="png", bbox_inches="tight")',
      '                    buf.seek(0)',
      '                    b64 = base64.b64encode(buf.getvalue()).decode("ascii")',
      '                    print("<<<PLOT>>>" + "data:image/png;base64," + b64)',
      '                finally:',
      '                    plt.close(fig)',
      '        except Exception as _e:',
      '            pass',
      '    def __plt_show_patch__(*args, **kwargs):',
      '        __flush_plots__()',
      '    try:',
      '        plt.show = __plt_show_patch__',
      '    except:',
      '        pass',
      'except Exception as _e:',
      '    pass',
      '',
      '# time.sleep を非ブロッキング化（stdout で SLEEP 通知 → JS 側でタイマー制御）',
      'async def __sleep__(sec):',
      '    try:',
      '        s = float(sec)',
      '    except Exception:',
      '        s = 0.0',
      '    try:',
      '        print("<<<SLEEP>>>start")',
      '        await asyncio.sleep(max(0.0, s))',
      '    finally:',
      '        print("<<<SLEEP>>>end")',
      '__input_queue = asyncio.Queue()',
      'async def __await_input__(prompt=""):',
      '    p = str(prompt) if prompt is not None else ""',
      '    # メインスレッドではJSのPromiseをawaitして値を受け取る（再入・競合を防ぐ）',
      '    v = await js.__input_async(p)',
      '    return str(v)',
      'async def __user_main():',
      body,  // 既に前置換済みの文字列をそのまま使う
      // 先にユーザーコードを実行
      'await __user_main()',
      'try:',
      '    __flush_plots__()',
      '    plt.close("all")',
      'except:',
      '    pass',
    ].join('\n');
    await pyodide.runPythonAsync(wrapped);
    // 復元
    window.__input_async = prevInputAsync;    cleanupAfterRun();
  } catch (err) {
    appendOutput(String(err||'実行エラー') + '\n');
    cleanupAfterRun();
  }
}
// メインスレッド用 Pyodide を必要時だけロード
async function ensurePyodideMain(){
  if (pyodide) return;
  let chosenSrc = null;
  // file:// でも動かすために複数候補を順に試す（CDN → ローカル）
  const candidates = [
    'https://cdn.jsdelivr.net/pyodide/v0.22.1/full/pyodide.js',
    './pyodide/pyodide.js',
    './pyodide.js'
  ];
  if (typeof loadPyodide === 'undefined') {
    let lastErr = null;
    for (const src of candidates) {
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = src;
          s.onload = resolve; s.onerror = reject;
          document.head.appendChild(s);
        });
        chosenSrc = src;
        console.log('[Main] ensurePyodideMain: loaded script from', src);
        break;
      } catch (e) {
        lastErr = e;
        console.warn('[Main] ensurePyodideMain: failed loading', src, e);
      }
    }
    if (!chosenSrc) {
      throw new Error('pyodide.js could not be loaded from any source');
    }
  }
  // indexURL を適切に指定（CDN or ローカル）
  let indexURL = 'https://cdn.jsdelivr.net/pyodide/v0.22.1/full/';
  if (chosenSrc && !/^https?:/i.test(chosenSrc)) {
    // ローカル pyodide.js の場所からベースURLを推定
    const a = document.createElement('a'); a.href = chosenSrc;
    const base = a.href.replace(/[^/]+$/, ''); // ファイル名を除いたディレクトリURL
    indexURL = base;
  }
  console.log('[Main] ensurePyodideMain: loadPyodide({ indexURL:', indexURL, '})');
  pyodide = await loadPyodide({ indexURL });
  console.log('[Main] ensurePyodideMain: pyodide ready');
}

function stopCode(){
  try{
    // 停止ボタン押下時点で入力待ちがあればキャンセル解決（UIも閉じる）
    try{ cancelPendingInputUI('stop'); }catch{}
    if (pyWorker) {
      if (workerCanInterrupt) {
        // 共有メモリ割り込みが使える場合は KeyboardInterrupt を送る
        pyWorker.postMessage({ type: 'stop' });
        // 一定時間内に停止通知が来なければ強制終了（取り残し対策）
        try{ if(__stopFallbackTimer) clearTimeout(__stopFallbackTimer); }catch{}
        __stopFallbackTimer = setTimeout(()=>{ hardKillWorker('stop-fallback'); }, 1500);
      } else {
        // 共有メモリが使えない環境ではワーカーを強制終了して即停止
        pyWorker.terminate();
        pyWorker = null;
        workerReady = false;
        appendOutput("実行を中断しました（環境制約によりワーカーを再起動）。\n");
        cleanupAfterRun();
      }
      return;
    }
  }catch{
    if (interruptBuffer){ interruptBuffer[0]=2; appendOutput("\n実行を停止しました。\n"); }
    else appendOutput("\nこの環境では停止機能は利用できません。\n");
  }
}

/* 出力 */
function appendOutput(text){
  const a=document.getElementById("outputArea");
  a.appendChild(document.createTextNode(text));
  outputBuffer += String(text).replace(/\r\n/g,"\n");
  if (currentTaskId && !taskSubmitted[currentTaskId]) {
    markTaskDirty(currentTaskId);
    updateStatusIcon('editing');
    applyResultsToList();
    updateStatusBadges();
  }
}
function clearOutput(){ const a=document.getElementById("outputArea"); a.innerHTML=""; outputBuffer=""; }

/* input() ユーザー入力 */
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
  if (!currentTaskId) { if(!silent) showStatusMessage('提出対象が選択されていません', 'error'); return; }
  if (taskSubmitted[currentTaskId] && submittedFlag!==true){ if(!silent) showStatusMessage('提出済みのため保存はスキップします','success'); return; }
  const code = editor ? editor.getValue() : '';
  const output = outputBuffer.replace(/\r\n/g,"\n");
  if (!sheetIO || !commPayload) { if(!silent) showStatusMessage('通信モジュールが初期化されていません','error'); return; }
  const payload = commPayload.createTaskSavePayload(
    { sessionId, userId, userClass, userNumber },
    { taskId: currentTaskId, code, output, hintOpened, submitted: submittedFlag || taskSubmitted[currentTaskId]===true }
  );
  const useGs = commPayload.isGasServer(APP_CONFIG.serverBaseUrl || '');

  sheetIO.postTaskSave(payload, APP_CONFIG.saveScript || "/save")
    .then(async (res)=>{
      if (useGs){
        if (submittedFlag) taskSubmitted[currentTaskId] = true;
        if (!silent) showStatusMessage(submittedFlag?'提出しました':'保存しました','success');
        saveToCache(currentTaskId, { code, output, hintOpened, submitted: !!taskSubmitted[currentTaskId], dirty: false });
        updateStatusIcon(computeStatusKey(currentTaskId)); applyResultsToList(); updateStatusBadges(); if (currentTaskId) saveLocalState(currentTaskId); return;
      }
      try {
        const data = await res.json();
        const ok = res.ok && data && data.status === 'ok';
        if (ok && submittedFlag) taskSubmitted[currentTaskId] = true;
        if (!silent) showStatusMessage(ok ? (submittedFlag?'提出しました':'保存しました') : (submittedFlag?'提出に失敗しました':'保存に失敗しました'), ok?'success':'error');
        saveToCache(currentTaskId, { code, output, hintOpened, submitted: !!taskSubmitted[currentTaskId], dirty: false });
        updateStatusIcon(computeStatusKey(currentTaskId)); applyResultsToList(); updateStatusBadges(); if (currentTaskId) saveLocalState(currentTaskId);
      } catch (e) {
        if (res.ok){ if (submittedFlag) taskSubmitted[currentTaskId]=true; if(!silent) showStatusMessage(submittedFlag?'提出しました':'保存しました','success');
          saveToCache(currentTaskId, { code, output, hintOpened, submitted: !!taskSubmitted[currentTaskId], dirty: false });
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

function cancelSubmission(){
  if(!currentTaskId) return;
  taskSubmitted[currentTaskId]=false;
  saveToServer(false,false);
  const codeNow = editor ? editor.getValue() : '';
  saveToCache(currentTaskId, { code: codeNow, output: outputBuffer, hintOpened, submitted: false, dirty: true });
  unlockEditor();
  setSubmitButtonState(false);
  updateStatusIcon('saved');
  applyResultsToList();
  updateStatusBadges();
  if (currentTaskId) saveLocalState(currentTaskId);
}

function updateStatusIcon(status){
  if(!currentTaskId) return;
  const key=(status in statusColors)?status:computeStatusKey(currentTaskId);
  const el=document.querySelector(`#taskList li[data-task-id='${currentTaskId}'] .task-icon`);
  if(!el) return;
  const color=statusColors[key] || statusColors.empty;
  const perfect=(typeof isPerfectScore === "function") ? isPerfectScore(currentTaskId) : false;
  if(perfect){
    el.textContent="★";
    el.classList.add("sparkle-star");
    el.classList.remove("dot-icon");
    el.style.background="transparent";
    el.style.color="";
    return;
  }
  el.classList.remove("sparkle-star");
  el.classList.add("dot-icon");
  el.textContent="●";
  el.style.background="transparent";
  el.style.color=color;
}

function lockEditor(){ if(editor) editor.setOption('readOnly',true); document.getElementById('editorWrapper').classList.add('locked'); document.getElementById('playButton').disabled=true; document.getElementById('stopIconButton').disabled=true; document.getElementById('saveButton').disabled=true; }
function unlockEditor(){ if(editor) editor.setOption('readOnly',false); document.getElementById('editorWrapper').classList.remove('locked'); document.getElementById('playButton').disabled=false; document.getElementById('stopIconButton').disabled=false; enableSaveSubmitButtons(); }
function setSubmitButtonState(isSubmitted){ const b=document.getElementById('submitButton'); if(b) b.textContent = isSubmitted ? '提出取消' : '提出'; }

async function loadTaskFromServer(taskId){
  try {
    if (!APP_CONFIG.serverBaseUrl) return null;
    if (!sheetIO || !commPayload) return null;
    const query = commPayload.createTaskDetailPayload({ sessionId, userId, userClass, userNumber }, taskId);
    const res = await sheetIO.requestTaskDetail(query);
    if (!res.ok) { if (res.status===401) { clearSession(); redirectToLogin(); } return null; }
    const json = await res.json();
    if (json && json.status==='ok') return json.data || null;
    if (json && json.status==='error') { clearSession(); redirectToLogin(); }
    return null;
  } catch { return null; }
}
