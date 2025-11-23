# ARCHITECTURE

## Repository layout

```
.
├── index.html              # トップ画面。セッション確認とスナップショット先読み。
├── login.html              # 二段階ログイン (ID → SALT → ハッシュ化PW)。
├── register.html           # 新規初期パスワード設定。SALT生成と自動ログイン。
├── change_password.html    # 既存ユーザーのパスワード変更フォーム。
├── main.html               # 学習画面 (課題一覧 + エディタ + 実行/提出)。
├── task_editor.html        # 教員向け課題エディタ UI。
├── style.css               # 共有スタイル (全画面で読み込み)。
├── config.js               # `window.APP_CONFIG` (serverBaseUrl/saveScript/submitScript/resultsPath)。
├── login.js                # 旧ログイン実装 (現状は login.html 内に新ロジックを直書き)。
├── register.js             # 旧登録画面用ロジック (現状未参照)。
├── change_password.js      # パスワード変更の fetch 実装。
├── main.js                 # 学習画面ロジック (Pyodide 連携/ローカル状態/提出)。
├── comm_payload.js         # GAS への POST/GET ペイロード生成ヘルパー。
├── sheet_io.js             # GAS との fetch ラッパー (一覧取得/保存/API切り替え)。
├── py_worker.js            # Pyodide 実行用 Web Worker スクリプト。
├── task_editor.js          # 課題エディタの UI/保存処理。
└── google_apps_script/
    └── Code.gs             # Google Apps Script 実装 (doGet/doPost/認証/Sheets操作)。
```

## フロントエンドモジュールと読み込み関係

- `index.html`
  - 読み込み: `style.css`, `config.js`, インラインスクリプト。
  - 役割: URL の `sid` パラメータや localStorage のセッションを検証し、`main.html`・`login.html` への遷移ボタンを切り替える。`getUserSnapshot` を先行実行し `localStorage["learn.snapshot.<server>"]` に課題・進捗キャッシュを保存。
- `login.html`
  - 読み込み: `config.js` とインライン JS。
  - 役割: Step1 の ID 送信で `action=getSalt` を呼び SALT を受領。Step2 で SALT+PW を `crypto.subtle` もしくは純粋 JS SHA-256 でハッシュ化し、`action=login` (GET) を叩いてセッションを発行し、`localStorage`/`sessionStorage` を更新する。
- `register.html`
  - 読み込み: `config.js`, インライン JS。
  - 役割: `action=getUserMeta` で未登録か検査し、3 文字 SALT を端末側で生成。`action=initPassword` で SALT+ハッシュを登録し、即 `action=login` でセッションを取得して index に遷移。
- `change_password.html`
  - 読み込み: `style.css`, `config.js`, `change_password.js`。
  - 役割: 既存ログイン情報を再入力させ、`action=changePassword` を Apps Script に POST (x-www-form-urlencoded)。
- `main.html`
  - 読み込み: `style.css`, `config.js`, `comm_payload.js`, `sheet_io.js`, `main.js`、CDN から Pyodide `v0.22.1`、CodeMirror 5.65.13 本体＋Pythonモード＋lint。
  - 役割: 課題一覧 (`#tasks`) とエディタ (`CodeMirror`)、出力領域、学習支援 UI (`#assistToggle`) をまとめる。`main.js` が Pyodide Worker (`py_worker.js`) を制御し、`CommPayload`/`SheetIO` 経由で GAS API を呼ぶ。
- `task_editor.html`
  - 読み込み: `style.css`, CodeMirror (CDN), `config.js`, `task_editor.js`。
  - 役割: 教員向けに課題ツリー、フォーム、回答/初期コードエディタを表示し、`action=getTasks`/`action=saveTask` を直接 fetch POST で呼び出す。

### 共有ユーティリティ

- `config.js`: `window.APP_CONFIG.serverBaseUrl` を各画面が参照し GAS の WebApp URL を決定。
- `comm_payload.js`: GAS への POST ボディを `application/x-www-form-urlencoded` で生成 (`createTaskListPayload`, `createTaskSavePayload` など) し、Apps Script の CORS プリフライトを回避。
- `sheet_io.js`: `requestTaskList`/`requestTaskDetail`/`postTaskSave`/`fetchResults` を提供し、`CommPayload` ヘルパーと組み合わせて fetch オプションを隠蔽。
- `py_worker.js`: Web Worker 側で Pyodide をロードし、`matplotlib` の `plt.show` を差し替えて PNG dataURI を `postMessage({type:'plot'})`。`input()`/`time.sleep()` も await 化してメインスレッド UI と同期する。

## ランタイムスタックと主要ライブラリ

- Pyodide `v0.22.1` (CDN からロード)。`main.js` は `ensurePyWorker` で Worker 版、`ensurePyodideMain` でメインスレッド版をフォールバックとして持つ。
- CodeMirror 5.65.13 (lint・Python モードを使用)。`main.js` と `task_editor.js` が `CodeMirror.fromTextArea` を呼び出し、それぞれ学習エディタと課題編集エディタを構築。
- Matplotlib (Pyodide パッケージ)。Worker 側が `plt.show` を PNG dataURI 出力にラップし、`main.js` の `handleStdoutChunk` が `<<<PLOT>>>` マーカーを検出して `<img>` を動的挿入。
- Web Worker + SharedArrayBuffer: `py_worker.js` は `WORKER_VER` と割り込みバッファを持ち、`stop` 操作で `KeyboardInterrupt` を注入できる。

## クライアントストレージの利用箇所

- `index.html`: `setSession` で `localStorage`/`sessionStorage` に `sessionId/userId/classId/number` を保存。`startPreload` で `learn.snapshot.<server>` キーに課題一覧と最近の states を JSON でキャッシュ。
- `login.html` / `register.html`: ログイン成功時に `localStorage`・`sessionStorage` を初期化して同じキーをセット。
- `main.js`
  - `persistSession`/`clearSession` でセッション情報を保持。
  - `COLLAPSE_KEY()` を使い `localStorage["taskList.collapsed.<server>`]` に課題ツリーの折り畳み状態を保存。
  - `saveToCache`/`loadFromCache` が `cache_<sessionId>_<taskId>` にコード・出力・提出状態・ヒント開閉を保存。
  - `saveSelectedTaskId` で直近の課題選択を保持し、再読込時に復元。
- `task_editor.js`: `taskEditor.collapsed.<server>` にフォルダツリーの折り畳み状態を永続化。

## スプレッドシート構造 (Code.gs)

- `user` シート (`Code.gs`:8-18, 224-275)
  - 列: `ID`, `Password`, `ClassId`, `Number`, `SALT`。
  - `getUserRowById_` が ID 正規化 (小文字/全角スペース削除) で行を検索。
  - `initPassword_` が SALT とハッシュ値を保存。
- `session` シート
  - 列: `SessionId`, `UserId`, `ClassId`, `Number`, `LastActive`。
  - `login_` がレコードを作成/更新し、`validateSession_` が `SESSION_TTL_MINUTES` をもとに期限チェック (現在 0=無期限)＋ `LastActive` 更新。
- `task` シート
  - 列: `TaskId`, `ParentId`, `IsFolder`, `Title`, `DescriptionHtml`, `HintHtml`, `AnswerCode`, `InitialCode`。
  - `getTasks_` はシート全体 (`values`) を返却。`saveTask_` が既存行更新または新規追加。
- `<UserId>` ごとの個別シート
  - 列: `TaskId`, `Code`, `Output`, `HintOpened`, `Submitted`, `SavedAt`。
  - `saveUserCode_` が `taskId` 行を upsert。`getSavedTaskForUser_` と `getUserSnapshot_` が読み出し。

## 認証・セッション管理 (SALT + Session)

1. `login.html` Step1 で `GET ?action=getSalt&id=...` を呼び、user シートから SALT を取得。
2. Step2 で `cachedSalt + password` を SHA-256 にした `passwordHash` を生成し、`GET ?action=login&id=...&passwordHash=...` で送信 (`Code.gs:250-316`)。Apps Script は保存済みハッシュと比較し、成功時に `session` シートへ `SessionId` を upsert。
3. フロントエンドはレスポンスの `sessionId/userId/classId/number` を `localStorage`/`sessionStorage` に記録。`main.js` はこれを `CommPayload.buildIdentityPayload` に渡し、以降の GAS API で `session` もしくは `id/classId/number` を付与。
4. GAS 側の `validateSession_(sessionId)` (`Code.gs:118-152`) が `session` シートを走査して `LastActive` を更新。`SESSION_TTL_MINUTES = 0` のため現状は期限切れ判定を行わず、任意の期間で有効。
5. `logout_(e)` で `removeSession_` を呼び行を削除。クライアントも `clearSession()` でストレージを初期化。

SALT はユーザーごと (登録時の `initPassword_`) に静的保存されるため、パスワード変更でも GET クエリに SALT+ハッシュが露出する設計となっている。
