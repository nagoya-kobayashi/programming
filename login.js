// client/login.js
// 仕様：ID → SALT取得 → PW入力 → (SALT+PW)をSHA-256でハッシュ化して送信 → セッション発行
// 既存構造を維持しつつ、最小変更で二段階化。

window.addEventListener('DOMContentLoaded', () => {
  const stepId = document.getElementById('stepId');
  const stepPw = document.getElementById('stepPw');
  const idForm = document.getElementById('idForm');
  const pwForm = document.getElementById('pwForm');
  const idInput = document.getElementById('loginId');
  const pwInput = document.getElementById('loginPassword');
  const idMsg = document.getElementById('loginStatusId');
  const pwMsg = document.getElementById('loginStatusPw');

  const APP = window.APP_CONFIG || {};
  const server = APP.serverBaseUrl || '';

  // URLの ?id= を初期IDに反映
  const initId = new URLSearchParams(location.search).get('id') || '';
  if (initId) { idInput.value = initId; }

  let cachedSalt = '';

  function show(el, on){ if (!el) return; el.style.display = on ? '' : 'none'; }
  function setMsg(el, msg, err=false){ if (!el) return; el.textContent = msg || ''; el.style.color = err ? '#d93025' : '#188038'; }

  async function sha256Hex(text){
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
    const arr = Array.from(new Uint8Array(buf));
    return arr.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function fetchJson(url){
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  }

  // Step1: ID送信→SALT取得
  idForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = (idInput.value || '').trim();
    if (!id){ setMsg(idMsg, 'IDを入力してください', true); return; }
    if (!server){ setMsg(idMsg, 'サーバURL未設定です(config.js)', true); return; }
    setMsg(idMsg, 'SALT取得中...');
    try{
      const url = server + '?action=getSalt&id=' + encodeURIComponent(id);
      const data = await fetchJson(url);
      if (data && data.status === 'ok' && data.salt){
        cachedSalt = data.salt;
        setMsg(idMsg, 'SALTを取得しました。パスワードを入力してください。');
        show(stepId, false);
        show(stepPw, true);
        pwInput.focus();
      }else{
        setMsg(idMsg, (data && data.message) || 'IDが無効です。', true);
      }
    }catch(err){
      setMsg(idMsg, '通信に失敗しました。', true);
    }
  });

  // Step2: PW送信→ハッシュ比較→セッション発行
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = (idInput.value || '').trim();
    const pw = (pwInput.value || '');
    if (!id || !cachedSalt){ setMsg(pwMsg, 'IDを入力してSALTを取得してください。', true); return; }
    if (!pw){ setMsg(pwMsg, 'パスワードを入力してください。', true); return; }
    try{
      setMsg(pwMsg, 'ログイン中...');
      const hash = await sha256Hex(cachedSalt + pw);
      // 既存の action=login を拡張：passwordHash を渡した場合はハッシュ比較、OKならセッション発行
      const url = server + '?action=login&id=' + encodeURIComponent(id) + '&passwordHash=' + encodeURIComponent(hash);
      const data = await fetchJson(url);
      if (data && data.status === 'ok' && data.sessionId){
        try { localStorage.clear(); } catch {}
        try {
          localStorage.setItem('sessionId', data.sessionId);
          localStorage.setItem('userId', data.userId || id);
          localStorage.setItem('classId', data.classId || '');
          localStorage.setItem('number', data.number || '');
          sessionStorage.setItem('sessionId', data.sessionId);
          sessionStorage.setItem('userId', data.userId || id);
          sessionStorage.setItem('classId', data.classId || '');
          sessionStorage.setItem('number', data.number || '');
        } catch {}
        location.href = 'main.html';
      }else{
        setMsg(pwMsg, (data && data.message) || 'IDまたはパスワードが正しくありません。', true);
      }
    }catch(err){
      setMsg(pwMsg, '通信に失敗しました。', true);
    }
  });

  // 初期表示（2段階UI）
  show(stepId, true);
  show(stepPw, false);
});
