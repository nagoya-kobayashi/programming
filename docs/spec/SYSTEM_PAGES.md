# SYSTEM_PAGES

## `index.html` — トップ画面

- **UI要素**: `#primaryBtn` (メイン遷移ボタン), `#meta` (現在のクラス/番号表示), `#note` (案内メッセージ), `#preloadStatus` (スナップショット取得中のトースト)。
- **主なイベント**:
  - `main()` が `location.search` の `sid` と `localStorage.sessionId` を検証。`validateSession()` は `action=ping` (POST) を送信し、失敗した場合でも `{status:'ok'}` を返して UX を優先。
  - `startPreload()` が `action=getUserSnapshot` を POST し、タスクと `states` を `localStorage["learn.snapshot.<server>"]` に保存。`session-ready` カスタムイベントでトリガー。
- **画面遷移**: セッション有効時は `#primaryBtn` の click で `main.html`、無効時は `login.html` へ。`window.dispatchEvent('session-ready')` で他タブにも伝搬。

## `login.html` — ログイン

- **UI要素**: `#idForm`, `#pwForm`, `#loginId`, `#loginPassword`, `#loginStatusId`, `#loginStatusPw`, `#secHintId`, `#secHintPw`。
- **イベント**:
  - Step1 (`#idForm`) 提交で `GET ?action=getSalt&id=` を実行。成功すると SALT を `cachedSalt` に格納し PW 入力フォームに切り替え。
  - Step2 (`#pwForm`) で SALT+PW を SHA-256 し、`GET ?action=login&id=...&passwordHash=...` を呼び出して `sessionId` を取得。成功後 `localStorage`/`sessionStorage` を初期化し、`index.html` に遷移。
- **遷移**: 上部「戻る」で `index.html` へ。成功時は自動でトップへ戻り、その後 `main.html` へ誘導。

## `register.html` — 新規登録

- **UI要素**: `#gateMsg` (ゲートメッセージ), `#formBlock`, `#regUserId`, `#regClass`, `#regNumber`, `#regPw`, `#regPw2`, `#regSubmit`, `#regMsg`, `#secHint`。
- **イベント**:
  - `init()` が URL の `id` パラメータと `localStorage.sessionId` を検査。`getUserMeta` で未登録を確認後、フォームを開く。
  - `#regSubmit` クリックで SALT を 3 文字ランダム生成し、`initPassword` (GET) に `salt` と `passwordHash` を渡した上で `login` を即時実行し、`index.html` へ遷移。
- **遷移**: 既に `passwordSet` の場合は `login.html?id=` に 0.8 秒後リダイレクト。

## `change_password.html` — パスワード変更

- **UI要素**: `#changePwForm`, `#cpUserId`, `#currentPw`, `#newPw`, `#newPw2`, `#changePwMessage`。
- **イベント**: `change_password.js` がフォーム submit を監視し、`action=changePassword` を `fetch(APP_CONFIG.serverBaseUrl, {method:'POST'})` で送信。Apps Script から JSON が返る想定。
- **遷移**: 下部リンクから `login.html` へ戻る。成功時は 2 秒後に自動リダイレクト。

## `main.html` — 学習画面

- **UI要素**:
  - サイドバー: `#taskList`, `#tasks` (課題リスト), フォルダ用 `.toggle-btn`, `.status-badge`。
  - 問題表示: `#problemTitle`, `#problemText`, `#hintButton`, `#hint`。
  - コード/出力: `#editor` (CodeMirror), `#ghostText` (Assist用透かし), `#outputArea`。
  - コントロール: `#playButton`, `#stopIconButton`, `#runButton`, `#stopButton`, `#saveButton`, `#submitButton`, `#assistToggle`, `#assistLabel`, `#helpButton`, `#statusMessage`, `#logoutButton`。
- **イベントと動作フロー**:
  1. `main()` で `SheetIO.requestTaskList` (`action=getTasks`) を呼び、`tasksData` を構築。`renderTaskTree()` が折り畳み UI を生成し、`SELECTED_KEY()` に保存された最後の課題を自動選択。
  2. `selectTask(taskId)` が
     - 直前の課題コード/出力を `localStorage` キャッシュに保存。
     - 新課題の詳細をローカルキャッシュ or `SheetIO.requestTaskDetail` (GET `taskId`・`session`) から読み込み、`#problemText`/`#hint`/CodeMirror に反映。
     - `#hintButton` click でヒント表示＋ assist 解除、初回時に `hintOpened=true` を `saveSpecificTask` から GAS にサイレント送信。
  3. `setupControls()` が `#playButton`→`runCode()`, `#stopIconButton`→`stopCode()`, `#saveButton`→`saveToServer()`, `#submitButton`→`submitToServer()`/`cancelSubmission()`, `#logoutButton`→セッションクリア、`#assistToggle`→ `updateGhostVisibility()` を設定。
  4. `saveToServer()` は `CommPayload.createTaskSavePayload` で `taskId/code/output/hintOpened/submitted` を作成し、`SheetIO.postTaskSave` で GAS に POST (`/exec` 直 or `saveScript`)。提出時は `taskSubmitted[taskId]=true` としてエディタを `lockEditor()`。
  5. `submitToServer()` → `saveToServer(submittedFlag=true)`。`cancelSubmission()` は `submitted=false` で再保存し UI を解錠。
- **課題エディタ/学習支援**: `#assistToggle` ON で `#ghostText` に `task.answer` を透かし表示。`hintOpened` になると Assist のロックが解除される。

### 課題エディタと学習画面の連携フロー

- `task_editor.html` で `saveTask` した結果は `task` シートに保存され、`main.html` の `getTasks` でも同じ構造で取得される。
- `task_editor.js` は `window.__TASKS` を更新しつつ `loadTaskList()` を再実行して最新状態を反映。学習画面は `index.html` の `getUserSnapshot` プリロードを通じて更新を事前に読み込み、通信失敗時はローカルキャッシュを利用。

### プログラム実行フロー (Pyodide → Matplotlib → dataURI)

1. `runCode()` (`main.js:1365-1476`) が現在のコードを取得し、`input()`/`time.sleep()` を非同期パッチ (`__await_input__`/`__sleep__`) したソース文字列を準備。`ensurePyWorker()` で `py_worker.js` をロードし、`postMessage({type:'run', token, code, needsMatplotlib})` を送信。
2. `py_worker.js` (`lines 1-170`) が初期化時に Pyodide をロードし、`matplotlib.use('Agg')` でノンインタラクティブに設定。`plt.show` を `__plt_show_patch__` に差し替え、`plt.savefig` の PNG を `base64` で `print("<<<PLOT>>>data:image/png;base64,...")` する。
3. Worker は stdout/stderr/input/plot を `postMessage` (`type:'stdout'|'stderr'|'input_request'|'plot'`) でメインスレッドへ送出。`main.js` の `handleStdoutChunk` が `<<<PLOT>>>` を検知して `appendPlotDataUrl()` で `<img>` (dataURI) を `#outputArea` に挿入し、`outputBuffer` には `[plot]` マーカーを記録する。
4. 入力要求 (`input_request`) は `showInlineInput()` でインラインテキストボックスを表示し、回答を Worker に返す。`stopCode()`／実行タイマー (`EXEC_TIMEOUT_MS`) で割り込みをかけると Worker へ `{type:'stop'}` を送信し `KeyboardInterrupt` を誘発する。

## `task_editor.html` — 課題エディタ

- **UI要素**: 左ペイン `#taskTree` と操作ボタン (`#btnNewTask`, `#btnNewFolder`, `#btnCopy`, `#btnReload`)、中央フォーム (`#taskId`, `#taskTitle`, `#taskParentId`, `#taskDesc`, `#taskHint`, `#saveTaskButton`, `#taskStatusMsg`)、右ペインの CodeMirror (`#answerEditor`, `#initialEditor`)。
- **イベント/フロー**:
  1. `init()` で CodeMirror を初期化し、`#btnNewTask`/`#btnNewFolder`/`#btnCopy`/`#btnReload`/`#saveTaskButton` のイベントを登録。`localStorage` に保存したフォルダ折り畳み状態 (`taskEditor.collapsed.<server>`) を読み込む。
  2. `loadTaskList()` が `POST action=getTasks` を直接 fetch。レスポンス (`values` or オブジェクト配列) を `normalizeTasks()` で `TaskId/Title/...` 形式に揃えて `window.__TASKS` に保持し、`renderTaskTree()` がフォルダつきのリストを描画。
  3. ツリークリックで `setActiveTask()` → `populateTaskForm()` が input/textarea/CodeMirror へ反映。フォルダ項目はクリックで折り畳みトグルに使う。
  4. `saveTask()` は `URLSearchParams` を組み立てて `POST action=saveTask`。レスポンスの `taskId` を UI と `window.__TASKS` に反映し、直後に `loadTaskList()` を再実行。
  5. `copySelectedTask()` は現在選択された課題から `TaskId` 以外を複製し、`Utilities.getUuid` で新 ID を作った上で `saveTask()` と同じフローを踏む。
- **ステータス表示**: `setStatus()` が `#taskStatusMsg` に成功/エラーを表示。匿名アクセス時は `#anonBadge` を表示し、セッション ID が無い場合でも UI 自体は操作可能。

## 画面遷移まとめ

- トップ (`index.html`) → ログイン (`login.html`) → 学習 (`main.html`) が基本導線。
- トップ → 学習 (`main.html`) はセッション検証成功時のみボタン有効。
- ログイン画面から登録 (`register.html?id=...`) へのリンクは無し。登録ページはクラス配布 URL (ID 付きリンク) からアクセスする想定。
- 右上の HELＰや課題エディタは直接 URL へアクセスする前提。`logoutButton` でセッションを削除すると `login.html` に戻る。
