// Pyodide 実行専用ワーカー
// - メインから {type:'run', code} を受けて実行
// - 入力必要時 {type:'input_request', prompt} をメインへ送信
// - メインから {type:'input_response', value} を受けて続行
// - {type:'stop'} で KeyboardInterrupt を発生させて停止

let pyodide=null; let interruptBuffer=null; let running=false; let curToken=0;
const WORKER_VER = 'v20251110-mpl8';

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  try{
    if (msg.type === 'init') {
      if (!pyodide) {
        importScripts('https://cdn.jsdelivr.net/pyodide/v0.22.1/full/pyodide.js');
        pyodide = await loadPyodide();
        pyodide.setStdout({ batched: (s) => postMessage({ type:'stdout', token:curToken, data:s }) });
        pyodide.setStderr({ batched: (s) => postMessage({ type:'stderr', token:curToken, data:s }) });
      }
      try{
         if (typeof SharedArrayBuffer !== 'undefined' && pyodide.setInterruptBuffer && !interruptBuffer) {
           interruptBuffer = new Int32Array(new SharedArrayBuffer(4));
           pyodide.setInterruptBuffer(interruptBuffer);
         }
      } catch {}
      postMessage({ type:'log', message:'worker '+WORKER_VER+' ready' });
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
      curToken = msg.token || 0;
      // ★ Python から js.curToken で参照できるように公開
      self.curToken = curToken;
      if (!pyodide) { postMessage({ type:'error', message:'Pyodide not ready' }); return; }
      if (running) { postMessage({ type:'error', message:'already running' }); return; }
      running = true;
      try{
        // ★ 必要な時だけ matplotlib をロード（初回のみ重い）
        if (msg.needsMatplotlib) {
          await pyodide.loadPackage(['matplotlib']).catch(()=>{});
        }
        const userCode   = String(msg.code || '');
        const prePatched = !!msg.prePatched;
        // 実際の改行でインデント（\n を使用）
        let body = userCode.split('\n').map(l => '    ' + l).join('\n');
        // 前置換が無い場合のみ Worker 側でも置換（重複置換を避ける）
        if (!prePatched) {
          // input()
          if (/(^|[^A-Za-z0-9_])input\s*\(/.test(body)) {
            body = body.replace(/(^|[^A-Za-z0-9_])input\s*\(/g, '$1await __await_input__(');
          }
          // time.sleep()
          if (/\btime\s*\.\s*sleep\s*\(/.test(body)) {
            body = body.replace(/\btime\s*\.\s*sleep\s*\(/g, 'await __sleep__(');
          }
          // from time import sleep → sleep(
          if (/^\s*from\s+time\s+import\s+sleep\b/m.test(userCode) && /(^|[^A-Za-z0-9_])sleep\s*\(/.test(body)) {
            body = body.replace(/(^|[^A-Za-z0-9_])sleep\s*\(/g, '$1await __sleep__(');
          }
        }
        const wrapped =
          [
            'import js, asyncio',
            '# ---- pyplot をPNGとしてstdoutに書き出す（Worker/メイン共通） ----',
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
            '                    print("<<<PLOT>>>"+ "data:image/png;base64," + b64)',
            '                finally:',
            '                    plt.close(fig)',
            '        except Exception as _e:',
            '            pass',
            '    def __plt_show_patch__(*args, **kwargs):',
            '        __flush_plots__()',
            '    plt.show = __plt_show_patch__',
            'except Exception as _e:',
            '    pass',
            '',
            '# ---- time.sleep を非ブロッキングにする（実行タイマーを一時停止/再開） ----',
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
            '',
            '__input_queue = asyncio.Queue()',
            'async def __await_input__(prompt=""):',
            '    p = str(prompt) if prompt is not None else ""',
            '    try:',
            '        js.postMessage({"type":"input_request","token":js.curToken,"prompt":p})',
            '    except Exception as _e:',
            '        pass',
            '    print("<<<INPUT>>>"+p)',
            '    v = await __input_queue.get()',
            '    return str(v)',
            'async def __user_main():'
          ].join('\n')
          + '\n'
          + body
          + '\n'
          + [
            'await __user_main()',
            'try:',
            '    __flush_plots__()',
            '    plt.close("all")',
            'except:',
            '    pass'
          ].join('\n');
        await pyodide.runPythonAsync(wrapped);
        postMessage({ type: 'done', token: curToken });
      } catch (e) {
        const m = String(e || '');
        if (m.includes('KeyboardInterrupt')) postMessage({ type: 'stopped', token:curToken });
        else postMessage({ type:'error', token:curToken, message:m });
      } finally {
        try{ if (interruptBuffer) interruptBuffer[0] = 0; }catch{}
        running = false;
      }
      return;
    }
  } catch(e){
    postMessage({ type:'error', token:curToken, message:String(e || 'worker error') });
  }
};
