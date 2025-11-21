// sheet_io.js: Google Spreadsheet（Apps Script）とのIOを束ねる通信モジュール。
// fetch の呼び出し方式を一括管理し、main.js ではデータ組み立てだけに専念できるようにする。
// 送信形式の違い（フォーム/JSON）やキャッシュ設定もここで統一している。
(function (global) {
  'use strict';

  const APP_CONFIG = global.APP_CONFIG || {};
  const Comm = global.CommPayload;

  if (!Comm) {
    console.error('[SheetIO] CommPayload が読み込まれていません');
    return;
  }

  // ===== 課題一覧取得 =====
  // Apps Script へ課題一覧を POST で取得する。
  // 引数: payload(object) | 戻り値: Promise<Response> or null
  async function requestTaskList(payload = {}) {
    if (!APP_CONFIG.serverBaseUrl) return null;
    const body = Comm.toQueryString(payload);
    return fetch(APP_CONFIG.serverBaseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      cache: 'no-store',
    });
  }

  // ===== 課題詳細取得 =====
  // taskId 付きのクエリで課題内容を取得する。
  // 引数: queryPayload(object) | 戻り値: Promise<Response> or null
  async function requestTaskDetail(queryPayload = {}) {
    if (!APP_CONFIG.serverBaseUrl) return null;
    const query = Comm.toQueryString(queryPayload);
    return fetch(`${APP_CONFIG.serverBaseUrl}?${query}`);
  }

  // ===== 保存・提出 =====
  // 共通ペイロードを用いて Apps Script へ保存/提出を送信する。
  // 引数: payload(object), path(string) | 戻り値: Promise<Response>
  async function postTaskSave(payload = {}, path) {
    const url = Comm.buildEndpoint(path || APP_CONFIG.saveScript || '/save');
    const { headers, body } = Comm.buildRequestInit(payload);
    return fetch(url, { method: 'POST', headers, body });
  }

  // ===== 採点結果取得 =====
  // 採点結果JSONをGETし、main.js側で解釈できるように返す。
  // 引数: path(string) | 戻り値: Promise<Response> or null
  async function fetchResults(path) {
    if (!path) return null;
    const url = Comm.buildEndpoint(path);
    return fetch(url);
  }

  global.SheetIO = {
    requestTaskList,
    requestTaskDetail,
    postTaskSave,
    fetchResults,
  };
})(window);

