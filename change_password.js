// change_password.js: パスワード変更画面の処理

window.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('changePwForm');
  const msgDiv = document.getElementById('changePwMessage');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msgDiv.style.color = 'red';
    msgDiv.textContent = '';
    const id = document.getElementById('cpUserId').value.trim();
    const currentPw = document.getElementById('currentPw').value;
    const newPw = document.getElementById('newPw').value;
    const newPw2 = document.getElementById('newPw2').value;
    if (!id || !currentPw || !newPw) {
      msgDiv.textContent = 'すべての項目を入力してください。';
      return;
    }
    if (newPw !== newPw2) {
      msgDiv.textContent = '新しいパスワードが一致しません。';
      return;
    }
    // 送信データを作成
    const bodyData = {
      action: 'changePassword',
      id: id,
      oldPassword: currentPw,
      newPassword: newPw
    };
    const isGs = (APP_CONFIG.serverBaseUrl || '').includes('script.google.com');
    let headers;
    let body;
    if (isGs) {
      // URL エンコード形式で送信（プリフライト回避）
      const params = new URLSearchParams();
      Object.keys(bodyData).forEach(key => params.append(key, bodyData[key]));
      headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      body = params.toString();
    } else {
      headers = { 'Content-Type': 'application/json' };
      body = JSON.stringify(bodyData);
    }
    try {
      const res = await fetch(APP_CONFIG.serverBaseUrl, {
        method: 'POST',
        headers,
        body
      });
      // Apps Script では CORS 設定により JSON が読めない可能性があるため、text() で取得してから解析する
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      if (res.ok && data && data.status === 'ok') {
        msgDiv.style.color = 'green';
        msgDiv.textContent = 'パスワードを変更しました。ログインページへ戻ります。';
        setTimeout(() => {
          window.location.href = 'login.html';
        }, 2000);
      } else {
        msgDiv.textContent = (data && data.message) || 'パスワード変更に失敗しました。';
      }
    } catch (err) {
      msgDiv.textContent = 'パスワード変更に失敗しました。';
    }
  });
});