// config.js: サーバーのホスト名とスクリプトパスを設定する
// この環境は http://midori-st-sv/web/programming/ 配下に配置される想定です。
// serverBaseUrl はスクリプトまでのベースURLです。

window.APP_CONFIG = {
  // Web アプリのベース URL。Google Apps Script を Web App として公開した URL をここに設定します。
  // 例: "https://script.google.com/macros/s/AKfycb.../exec"
  serverBaseUrl: "https://script.google.com/macros/s/AKfycbwFuqIjuIHEbqqZwWAqJv3Xrn1sx-1uh1E-mUfhkEnB_PFsH67_rSPqu6-EXusCgJFP/exec", //本番環境
  //serverBaseUrl: "https://script.google.com/macros/s/AKfycbxYGWqbcRGgXyNTsNU3YUkR1iK47S4cUzDyV_lD5SVpl37oJR2rWHucAl-Ocgr80e63pQ/exec", //検証環境
  // 保存および提出エンドポイント。Apps Script の場合、ベース URL に追加パスは不要なので空文字列にします。
  saveScript: "",
  submitScript: "",
  // 採点結果の取得は Apps Script 版では未実装のため、空文字列にしておきます。
  resultsPath: ""
};