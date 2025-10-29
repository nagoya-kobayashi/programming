// Pyodide 実行専用ワーカー
// - メインから {type:'run', code} を受けて実行
// - 入力必要時 {type:'input_request', prompt} をメインへ送信
// - メインから {type:'input_response', value} を受けて続行
// - {type:'stop'} で KeyboardInterrupt を発生させて停止

let pyodide = null;
let interruptBuffer = null;
let running = false;

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  try{
    if (msg.type === 'init') {
      // 初期化受信ログ（HTTP 環境での動作確認用）
      try { postMessage({ type:'log', message:'init received' }); } catch {}
      if (!pyodide) {
        try { postMessage({ type:'log', message:'importScripts start' }); } catch {}
        importScripts('https://cdn.jsdelivr.net/pyodide/v0.22.1/full/pyodide.js');
        pyodide = await loadPyodide();
        try { postMessage({ type:'log', message:'pyodide loaded' }); } catch {}
        pyodide.setStdout({ batched: (s)=> postMessage({ type:'stdout', data: s }) });
        pyodide.setStderr({ batched: (s)=> postMessage({ type:'stderr', data: s }) });
      }
      try{
        if (typeof SharedArrayBuffer !== 'undefined' && pyodide.setInterruptBuffer && !interruptBuffer) {
          interruptBuffer = new Int32Array(new SharedArrayBuffer(4)); // 0:通常 / 2:KeyboardInterrupt
          pyodide.setInterruptBuffer(interruptBuffer);
        }
      }catch{}
      postMessage({ type:'ready', canInterrupt: !!interruptBuffer });
      return;
    }
    if (msg.type === 'stop') {
      try{ if (interruptBuffer) interruptBuffer[0] = 2; }catch{}
      return;
    }
    if (msg.type === 'input_response') {
      const v = String(msg.value ?? '');
      // Python 側のキューへ投入
      await pyodide.runPythonAsync(`__input_queue.put_nowait(${JSON.stringify(v)})`);
      return;
    }
    if (msg.type === 'run') {
      if (!pyodide) { postMessage({ type:'error', message:'Pyodide not ready' }); return; }
      if (running) { postMessage({ type:'error', message:'already running' }); return; }
      running = true;
      try{
        const userCode   = String(msg.code || '');
        const prePatched = !!msg.prePatched;
        // 実際の改行でインデント（\n を使用）
        let body = userCode.split('\n').map(l => '    ' + l).join('\n');
        // 前置換が無い場合のみ Worker 側でも置換（重複置換を避ける）
        if (!prePatched && /(^|[^A-Za-z0-9_])input\s*\(/.test(body)) {
          body = body.replace(/(^|[^A-Za-z0-9_])input\s*\(/g, '$1await __await_input__(');
        }
        const wrapped = `
import js, asyncio
__input_queue = asyncio.Queue()
async def __await_input__(prompt=""):
    p = str(prompt) if prompt is not None else ""
    # メインへ入力要求（表示はメイン）
    # 1) 通常: JS メッセージ
    try:
        js.postMessage({ "type":"input_request", "prompt": p })
    except Exception as _e:
        pass
    # フォールバック: stdout にマーカーを流してメインが検出（改行付きで即フラッシュさせる）
    print("<<<INPUT>>>"+p)
    v = await __input_queue.get()
    return str(v)
async def __user_main():
${body}
await __user_main()
`;
        await pyodide.runPythonAsync(wrapped);
        postMessage({ type:'done' });
      } catch (e) {
        const m = String(e || '');
        if (m.includes('KeyboardInterrupt')) {
          postMessage({ type:'stopped' });
        } else {
          postMessage({ type:'error', message: m });
        }
      } finally {
        try{ if (interruptBuffer) interruptBuffer[0] = 0; }catch{}
        running = false;
      }
      return;
    }
  } catch(e){
    postMessage({ type:'error', message: String(e || 'worker error') });
  }
};
