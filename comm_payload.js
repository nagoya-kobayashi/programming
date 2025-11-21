// comm_payload.js: Google Apps Script/Sheets向け通信データの共通化ユーティリティ。
// 通信先の制約に合わせたペイロードやヘッダーを一箇所に集約し、main.js からの実装ミスを防ぐ。
// 送受信形式を固定化することで、将来的なサーバ更新時にも差分を最小限に抑えられる構造としている。
(function (global) {
  'use strict';

  const APP_CONFIG = global.APP_CONFIG || {};

  // ===== 判定系ユーティリティ =====
  // Google Apps Script への通信かどうかを判定する。
  // 引数: url(string) | 戻り値: boolean（true なら GAS 宛）
  function isGasServer(url) {
    return String(url || '').includes('script.google.com');
  }

  // ベースURLと相対パスを組み合わせたエンドポイントを生成する。
  // 引数: path(string) | 戻り値: string（完全なURL）
  function buildEndpoint(path) {
    const base = APP_CONFIG.serverBaseUrl || '';
    if (isGasServer(base)) {
      return base;
    }
    return base + (path || '');
  }

  // セッションIDまたはID/クラス/番号から通信共通の本人情報を生成する。
  // 引数: context(object) | 戻り値: object（payload の一部として利用）
  function buildIdentityPayload(context = {}) {
    const { sessionId, userId, userClass, userNumber } = context;
    if (sessionId) {
      return { session: sessionId };
    }
    const payload = {};
    if (userId) payload.id = userId;
    if (userClass) payload.classId = userClass;
    if (userNumber) payload.number = userNumber;
    return payload;
  }

  // ===== ペイロード生成 =====
  // 課題一覧取得用のパラメータを生成する。
  // 引数: context(object) | 戻り値: object（action=getTasks 含む）
  function createTaskListPayload(context = {}) {
    return {
      action: 'getTasks',
      ...buildIdentityPayload(context),
      _ts: String(Date.now()),
    };
  }

  // 個別課題詳細の取得パラメータを生成する。
  // 引数: context(object), taskId(string) | 戻り値: object（taskId を含むクエリ）
  function createTaskDetailPayload(context = {}, taskId) {
    return {
      ...buildIdentityPayload(context),
      taskId,
    };
  }

  // 課題保存や提出で利用する送信ペイロードを組み立てる。
  // 引数: context(object), state(object) | 戻り値: object（コードや出力を含む）
  function createTaskSavePayload(context = {}, state = {}) {
    const normalizedOutput = String(state.output || '').replace(/\r\n/g, '\n');
    return {
      ...buildIdentityPayload(context),
      taskId: state.taskId,
      code: String(state.code || ''),
      output: normalizedOutput,
      hintOpened: !!state.hintOpened,
      submitted: !!state.submitted,
    };
  }

  // ===== 送受信補助 =====
  // 渡されたオブジェクトを URLSearchParams と同等のクエリ文字列へ変換する。
  // 引数: payload(object) | 戻り値: string（エンコード済みクエリ）
  function toQueryString(payload = {}) {
    const params = new URLSearchParams();
    Object.entries(payload).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      params.append(key, String(value));
    });
    return params.toString();
  }

  // フォーム送信/JSON送信の方針を決め、fetch の init 情報を生成する。
  // 引数: payload(object), opts(object) | 戻り値: object（{headers, body}）
  function buildRequestInit(payload = {}, opts = {}) {
    const preferForm = opts.preferForm === true;
    const preferJson = opts.preferJson === true;
    const useForm = preferForm || (!preferJson && isGasServer(APP_CONFIG.serverBaseUrl || ''));
    let body;
    let headers;
    if (useForm) {
      body = toQueryString(payload);
      headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    } else {
      body = JSON.stringify(payload);
      headers = { 'Content-Type': 'application/json' };
    }
    return { headers, body };
  }

  global.CommPayload = {
    isGasServer,
    buildEndpoint,
    buildIdentityPayload,
    createTaskListPayload,
    createTaskDetailPayload,
    createTaskSavePayload,
    toQueryString,
    buildRequestInit,
  };
})(window);

