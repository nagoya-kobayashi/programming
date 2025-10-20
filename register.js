// register.js: ユーザー登録画面のスクリプト

window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const idParam = params.get('id') || '';
  const userIdInput = document.getElementById('regUserId');
  userIdInput.value = idParam;
  const form = document.getElementById('registerForm');
  const msgDiv = document.getElementById('registerMessage');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msgDiv.textContent = '';
    const userId = userIdInput.value.trim();
    const pw1 = document.getElementById('regPassword').value;
    const pw2 = document.getElementById('regPassword2').value;
    const classId = document.getElementById('regClassId').value.trim();
    const number = document.getElementById('regNumber').value.trim();
    if (!userId || !pw1 || !classId || !number) {
      msgDiv.textContent = 'すべての項目を入力してください。';
      return;
    }
    if (pw1 !== pw2) {
      msgDiv.textContent = 'パスワードが一致しません。';
      return;
    }
    try {
      const bodyData = {
        action: 'register',
        id: userId,
        password: pw1,
        classId: classId,
        number: number
      };
      // send as application/json for internal server; but for Apps Script we will send urlencoded
      let headers = { 'Content-Type': 'application/json' };
      let body;
      const isGs = (APP_CONFIG.serverBaseUrl || '').includes('script.google.com');
      if (isGs) {
        // send as urlencoded to avoid preflight
        const sp = new URLSearchParams(bodyData);
        headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
        body = sp.toString();
      } else {
        body = JSON.stringify(bodyData);
      }
      const res = await fetch(APP_CONFIG.serverBaseUrl, {
        method: 'POST',
        headers,
        body
      });
      // For Apps Script we might get cors issue; but attempt to parse json if allowed
      let data = null;
      try {
        data = await res.json();
      } catch (e) {}
      if (res.ok && data && data.status === 'ok') {
        // 登録成功
        msgDiv.style.color = 'green';
        msgDiv.textContent = '登録に成功しました。ログインページに戻ります...';
        setTimeout(() => {
          window.location.href = 'login.html';
        }, 2000);
      } else {
        msgDiv.textContent = (data && data.message) || '登録に失敗しました。';
      }
    } catch (err) {
      msgDiv.textContent = '登録に失敗しました。';
    }
  });
});