# 開発者向け完全仕様書

本書はシステムのフロントエンドとバックエンドを開発・保守するための詳細な設計資料です。画面構成、主要な JavaScript 関数、データ保存の仕組み、認証方式、スプレッドシート構造、環境依存の制約などを網羅しています。スプレッドシートの列定義・並び順の一覧は `SPREADSHEET_SCHEMA.md` も併読してください。ここに記載された情報を改変せずに利用し、改善時は影響範囲を十分に確認してください。

## 画面定義
### index.html（トップ画面）
- 目的: セッションの有効性を確認し、学習画面 (main.html) もしくはログイン画面 (login.html) への遷移を制御します。課題のスナップショットを先読みし、ローカルキャッシュに保存します。
- 主な要素: 遷移ボタン #primaryBtn、現在のクラス/番号表示 #meta、案内メッセージ #note、スナップショット取得中のトースト #preloadStatus。
- 状態サマリ: ログイン済みで課題一覧と snapshot を取得した時点で、「プログラミングをはじめる」ボタン直下にクリア済/採点済/提出済/未提出ごとの折りたたみ一覧を表示します。状態名の左に学習画面と同じアイコン（クリア済はスター、それ以外は状態色の●）、右に件数を付け、展開するとフォルダ構成を含む課題フルパス名と「この課題からはじめる」ボタンを列挙します（選択状態をローカルストレージに保存して main.html に遷移）。
- 属性別クリア率: snapshot を基に、「基礎」「演習」「発展」ごとにクリア済み(★)と未クリア(☆)の数を横並びで表示します。★は学習画面と同じカラー（基礎=緑、演習=青、発展=赤）で塗り分け、課題が存在しない属性は「課題なし」と表示します。
- 初期化フロー (main()): URL の sid パラメータと localStorage.sessionId を検証し、GAS に action=ping を送信します。成功/失敗にかかわらず {status:'ok'} 扱いとし、ボタンの表示を切り替えます。続いて startPreload() により action=getUserSnapshot を POST し、取得した tasks と学習状態を localStorage["learn.snapshot.<server>"] に保存します。
- 遷移: セッション有効時に #primaryBtn のクリックで main.html へ、無効時は login.html へ遷移します。window.dispatchEvent('session-ready') により他タブへも通知します。

### login.html（二段階ログイン）
- 目的: ユーザー ID とパスワードを用いてセッションを発行します。ID 送信時に SALT を取得し、クライアント側でハッシュを計算することでパスワードを平文送信しません。
- 主な要素: ID 入力フォーム #idForm とパスワード入力フォーム #pwForm、入力フィールド #loginId と #loginPassword、状態表示 #loginStatusId と #loginStatusPw、セキュリティ警告 #secHintId/#secHintPw。
- イベント:
 - Step1（ID フォーム）送信時に GET ?action=getSalt&id=<id> を送信し、成功すると SALT を cachedSalt に保持し PW フォームを開きます。
 - Step2（PW フォーム）送信時に cachedSalt + password を SHA‑256 したハッシュを GET ?action=login&id=<id>&passwordHash=<hash> で送信し、レスポンスの sessionId 等を localStorage と sessionStorage に格納してトップ画面にリダイレクトします。
- 戻るリンク: 画面上部の戻るボタンで index.html へ。ログイン成功後は自動でトップ画面へ戻ります。

### register.html（新規登録）
- 目的: 未登録ユーザーの初期パスワードを設定し、自動的にログインするための画面です。
- 主な要素: ゲートメッセージ #gateMsg、フォームブロック #formBlock、ユーザー ID 入力 #regUserId、クラス #regClass、番号 #regNumber、パスワード入力 #regPw と確認用 #regPw2、送信ボタン #regSubmit、メッセージ表示 #regMsg、セキュリティ警告 #secHint。
- 処理: URL の id パラメータと localStorage.sessionId を検証して未登録の場合のみフォームを表示します。送信時は 3 文字の SALT をランダム生成し、GET ?action=initPassword&id=<id>&salt=<salt>&passwordHash=<hash> で初期パスワードを登録した後、自動的に action=login を実行し index.html に遷移します。

### change_password.html（パスワード変更）
- 目的: 既存ユーザーのパスワードを更新する画面です。ただし Apps Script 側に changePassword エンドポイントが存在しないため、現在はエラーを返します。
- 要素: フォーム #changePwForm、ユーザー ID フィールド #cpUserId、旧パスワード #currentPw、新パスワード #newPw と確認用 #newPw2、メッセージ表示 #changePwMessage。

### main.html（学習画面）
- **課題一覧のステータス**: `task_panel.js` は `submitted` が true の課題を最優先で `[提出済]` 表示にし（色は `statusColors.submitted=#9254de` の紫ドット）、`score` が存在して提出解除済みの場合は `[採点済]` を表示します。`score=100` の課題には `.task-icon.sparkle-star` を付与し、課題属性に応じたカラーの ★（基礎=緑、演習=青、発展=赤、その他は金色）に太めの輪郭とグリント（`::after`）を重ねて満点アイコンを表示します。100 点未満の採点済み課題は `statusColors.graded=#ff8fb7` のピンクドットで視覚的に区別します。さらに、採点済みの課題でもコード編集や実行で `markTaskDirty()` が立つと `[編集中]` を優先表示し、保存成功時には `computeStatusKey()` が自動的に `[スコア点]` へ戻します（`[保存済]` には遷移しない）。再提出時は `hasAnySubmittedRecord()` が優先されるため、採点済みでも `[提出済]` が表示されます。
- **フォルダ単位の進捗表示**: 課題ツリーのフォルダ行は右端に「クリア済/総数」を表示し、採点対象外（Attribute=その他）を除いた配下課題の 100 点達成件数のみをカウントします。未クリアが残る場合はクリア済件数を青で表示し、全件クリア時はクリア済件数を緑色にしつつフォルダ名の左に属性に応じた ★（基礎=緑/演習=青/発展=赤、上位フォルダなど分類外は金色）を重ねます（結果データ読み込み後にリアルタイム更新）。
- 採点対象外: 課題属性が「その他」のものは常に `[採点対象外]` バッジとグレーのドットで表示し、提出ボタンは無効化します。提出済み扱いや満点アイコンには遷移せず、コメントバルーンも非表示になります。
- 目的: 課題一覧の表示、問題の閲覧、コード編集、実行/保存/提出など学習に必要な機能を提供します。
- UI 要素: サイドバー #taskList と #tasks は課題ツリーを表示し、フォルダには .toggle-btn、未提出・提出済み等の状態を示すバッジ .status-badge が付きます。問題表示領域は #problemTitle（タイトル）、#problemText（説明 HTML）、#hintButton と #hint（ヒント表示）。コードエディタは #editor で CodeMirror により構築され、支援用の透かしテキストは #ghostText に描画されます。実行・停止・保存・提出などの制御ボタン #playButton/#stopIconButton/#runButton/#stopButton/#saveButton/#submitButton、学習支援トグル #assistToggle とラベル #assistLabel、ヘルプ #helpButton、状態表示 #statusMessage、ログアウト #logoutButton があります。 またコード領域と実行結果領域の間には角丸のコメントバルーン #commentBubble を配置し、採点コメントや100点時の祝福メッセージ（スコア 100 の場合は固定文「満点クリア、お見事！おめでとう♪」）を吹き出し形式で表示します。バルーン全体をクリックすると折りたたまれて「…」アイコンになり、アイコンを押すと再展開します。バルーン下部には常に淡色のガイド文「クリックで最小化」が表示され、操作方法を明示します。コメントもスコアも無い場合や課題属性が「その他」の場合はコメントバルーンを非表示にします。
- **コードエディタの補助**: CodeMirror の lint オプションは pythonLinter でコンパイルを行い、入力が止まってから約 2 秒後に構文エラーを自動チェックして赤系の下線＋背景で強調表示します。エラーは画面上部から順に「最初に見つかったものだけ」をマーキングし、invalid character/U+XXXX が含まれる場合は該当文字（例: 全角コロン）をピンポイントで強調します。構文エラーでオフセットが次トークンにずれた場合は直前の識別子（例: retarn）を優先表示します。コンパイル通過後は AST を走査して未定義変数を検出し、最初の未定義箇所をエラー扱いにします。全角スペースは薄い枠付きの □ で描画し、半角スペースと視覚的に区別できるようにしています。
- 主要処理フロー:
 1.課題リストの読み込み – ページ読み込み時に SheetIO.requestTaskList (action=getTasks) を呼び出し、取得したタスクリストを tasksData に格納し renderTaskTree() で階層 UI を生成します。最後に選択した課題は SELECTED_KEY() に保存されており、初期表示時に復元されます。
 2.課題選択 – selectTask(taskId) は現在のコード/出力をローカルキャッシュに保存した後、新課題の詳細をキャッシュまたは SheetIO.requestTaskDetail (GET) から取得し、問題文・ヒント・CodeMirror に適用します。初回ヒント表示時は saveSpecificTask() が非同期で GAS にサイレント送信されます。
 3.実行・停止 – runCode() は現在のエディタ内容を取得し、input()／time.sleep() を非同期化したコード文字列を生成します。ensurePyWorker() で py_worker.js を読み込み、postMessage({type:'run', token, code, needsMatplotlib}) を送信します。Worker からの stdout/stderr/input_request/plot メッセージは handleStdoutChunk() などで受信し、<<<PLOT>>> マーカーを検出すると <img> 要素を動的に挿入します。
4.保存・提出 – saveToServer() は CommPayload.createTaskSavePayload により taskId/code/output/hintOpened/submitted を組み立て SheetIO.postTaskSave で GAS に POST します。要求ごとに送信対象の taskId を確定させてから非同期処理を行い、完了時は当初の課題のみローカルキャッシュ・snapshot・バッジを更新します（途中で別課題に移動してもリンクしません）。submitToServer() は submitted フラグを true にして同じ処理を行い、現在も同じ課題を表示している場合のみエディタをロックします。cancelSubmission() は submitted=false で再保存し、同一課題を表示中であればロックを解除します。完了メッセージは必要に応じて「提出しました（課題タイトル）」のように対象課題名を付与します。加えて、editor_controls.js・runner.js などで markTaskDirty()/setTaskDirty() を呼び出し、コード編集や実行でローカルとサーバーの内容が乖離した瞬間にステータスを「編集中」として表示し、saveToServer() 成功時は採点済みのスコアがあれば即座に `[スコア点]` 表示へ戻し（`[保存済]` には遷移しない）、submitToServer() 成功時のみ `[提出済]` に遷移します。
- 提出済み課題のロック – task_panel.js から復元された `taskSubmitted` が true の課題を選択すると `refreshEditorLockState()` が `lockEditor()` を強制し、CodeMirror を readOnly に設定して実行ボタン・保存ボタンも無効化します。提出取消（`cancelSubmission()`）で `taskSubmitted=false` になった時だけ `unlockEditor()` され、再編集が可能になります。
 5.その他 – #assistToggle をオンにすると透かし (ghostText) に解答コードが表示されます。ヒントを開いた状態でのみ支援機能がアンロックされます。

### grading.html（採点画面）
- 目的: 提出済みのコードを一覧し、スコアやコメントを付けて保存する採点用画面。`Submitted` が true のデータが存在することを前提とし、未提出のみの場合は閲覧専用になる。
- UI: ヘッダーで「クラス指定（class モード）」と「ユーザー指定（user モード）」を切り替え、classId には `ALL` も指定可能。入力欄は #classInput/#userInput、読み込みボタンは #loadButton、提出済みのみを表示するチェックは #submittedOnlyToggle（設定を `grading.<server>.submittedOnly` に保存）、提出済み全員へ 100 点を入れる一括ボタンが #bulkFullButton、保存ボタンは #saveButton。
- 一括採点の自動エラー判定: #bulkFullButton は提出済み行に対して Pyodide で構文チェック＋AST による未定義変数チェックを実行し、エラーがある行はスコアを 0 に、コメントを「提出されたプログラムは実行するとエラーになります。内容を修正し、最後まで正しく実行できたら、再度、提出をしてください。」に自動設定する。エラーが無い場合のみ 100 点を自動入力する。
- エラー行の強調表示: 一括採点でエラーと判定された提出のコードブロックは、学習画面と同様にエラー箇所のみを赤系ハイライトして表示する。
- コード表示の補助: 採点画面でも提出コード内の全角スペースを薄い枠付きの □ で表示し、半角スペースと区別できるようにする。
- 課題ツリー: 左サイドバー #taskTree に tasks をフォルダ優先→タイトル→order の順でソートして表示。提出済み件数を `.task-count` で表示し、クリックで selectTask() を発火する。折りたたみ状態は session ごとに保持する。
- 採点対象外: 課題属性が「その他」の課題は action=getClassSubmissions の段階で除外され、ツリーや採点表に表示されない。古いキャッシュから復元する場合も normalizeTasks で「その他」属性の課題をフィルタする。
- 採点カード: 右側に選択課題の #taskSummary と #gradingTable を表示。各 `.student-card` は番号・ユーザーID・提出状態バッジ（pending/提出済/採点済/未提出）、提出コード、出力を表示する。出力に "[plot]" を含む場合は grading.js で Pyodide と matplotlib を同期ロードし、提出コードをそのまま実行して得たグラフを横幅 50% のサムネイルで埋め込む（入力待ちや割り込みは考慮せず単純実行）。
- 編集と保存: score/comment は提出済みや採点済み行で直接編集でき、未提出行は tab 移動できないよう `tabIndex=-1` を設定しつつクリック入力は可能。変更すると card の `data-editing=true` になり dirty として保存対象になる。保存時は dirty 行のみを検証し、score が空/非数/0–100 外ならエラー。未提出行は payload に `force:true` を付けて saveScores に POST し、GAS 側で `<UserId>` シートの Submitted を FALSE にしつつ Score/Comment/SavedAt を更新する。保存結果は submissions/localGrades に反映され、score=100 は学習画面の `.sparkle-star` 表示に繋がる。
- フィルタとキャッシュ: `submittedOnly` チェックで未提出行を隠し、設定は localStorage に保持。`action=getClassSubmissions` (POST) で tasks、students[{userId,number,classId}]、submissions[userId][taskId]={code,output,hintOpened,submitted,score,comment,savedAt} を取得。レスポンスを `grading.<server>.cache.<ClassId>` に tasks/students/submissions/localGrades/fetchedAt として保存し、`lastLoadedAt` を付けて差分取得する。ユーザー検索時に判明した classId は `grading.<server>.userClass.<UserId>` に記憶する。
- 成績反映: 保存された `score`/`comment` は getUserSnapshot_ で snapshot や resultsPath に取り込まれ、task_panel.js の loadResults() が `[採点済]` バッジや score=100 時の `.sparkle-star`、100 点未満時のピンクドットを表示する。`submitted=true` の課題は `[提出済]` 表示が最優先となり、task_selection.js は取得した comment を #commentBubble に描画し、コメントなしで score=100 の場合は固定祝福メッセージを表示する。

### task_editor.html（課題エディタ）
- 目的: 教員が課題ツリーを閲覧・作成・編集し、スプレッドシート上の task テーブルに保存するための画面です。
- UI 要素: 左ペインのツリー #taskTree と操作ボタン (#btnNewTask、#btnNewFolder、#btnCopy、#btnReload)、中央フォーム (#taskId、#taskTitle、#taskParentId、課題属性セレクト #taskAttribute、#taskDesc、#taskHint、#saveTaskButton、#taskStatusMsg)、右ペインの CodeMirror (#answerEditor、#initialEditor)。
- 主要処理: init() で CodeMirror を初期化し、各種ボタンのイベントを登録します。loadTaskList() は POST action=getTasks を実行してタスクリストを正規化し、window.__TASKS に保存した上で renderTaskTree() を呼び出します。タスク選択時に setActiveTask() を呼び、フォームに値を反映します。saveTask() は URLSearchParams を組み立てて POST action=saveTask を送信し、戻り値の taskId を反映し直ちに loadTaskList() を再実行します。コピー機能は現在選択されたタスクを複製し、新しい TaskId を生成して保存します。
- 属性設定: Attribute は「基礎/演習/発展/その他」を保持し、未選択の場合は task シート保存時に第2階層フォルダ名が (1)基礎/(2)演習/(3)発展 に一致するかで自動判定されます。一致しない場合は「その他」となり、課題は採点対象外として扱われます。フォルダ作成モードでは属性セレクトは無効化されます。

## JavaScript 関数の詳細
この節では主要な関数の振る舞い、引数、戻り値、例外を記述します。実装の一部は非同期 (Promise) を返します。関数名はファイル内の定義順に列挙しています。

### config.js
- window.APP_CONFIG – オブジェクトであり、serverBaseUrl（GAS WebApp のベース URL）、saveScript・submitScript・resultsPath（別シートを利用する場合に上書きするエンドポイント）を保持します。初期値はビルド時に挿入されるため環境により異なります。

### comm_payload.js
- createTaskListPayload(context) – 課題一覧取得用のオブジェクトを生成します。`{action:'getTasks', session|id/classId/number, _ts}` を返し、呼び出し側で URLSearchParams 化します。
- createTaskDetailPayload(context, taskId) – session/id を含むクエリパラメータオブジェクトを生成します。
- createTaskSavePayload(context, state) – コード保存・提出用のオブジェクトを生成します。`output` の改行を `\n` に正規化し、hintOpened/submitted を boolean 化します。
- toQueryString(payload) / buildRequestInit(payload, opts) – URLSearchParams への変換や、GAS 宛では application/x-www-form-urlencoded を優先する fetch init を組み立てます（JSON 送信も opts で選択可）。

### sheet_io.js
- requestTaskList(payload) – CommPayload.toQueryString でエンコードし、serverBaseUrl へ POST（application/x-www-form-urlencoded）するだけの薄い fetch ラッパー。戻り値は Response。
- requestTaskDetail(queryPayload) – serverBaseUrl に GET クエリでアクセスし、課題詳細 (getSavedTaskForUser_) を取得する Response を返す。
- postTaskSave(payload, path) – CommPayload.buildRequestInit で form/json を選択し、saveScript もしくは serverBaseUrl へ POST する。
- fetchResults(path) – resultsPath など任意 URL を GET するシンプルなラッパー。戻り値は Response。

### main 系モジュール
- main.js – セッション検証・スナップショット読み込み・Pyodide 初期化・各モジュール呼び出しを司るエントリーポイントです。
- app_state.js – persistSession()/clearSession()、loadSnapshot()/saveLocalState() など共有状態とローカルキャッシュを扱います。学習状態のキー (`learn.snapshot.<server>`) もここで定義されています。
- runner.js – runCode()/stopCode()/handleStdoutChunk()/showInlineInput() など Pyodide 実行と Worker 制御のコア処理をまとめています。EXEC_TIMEOUT_MS によるタイムアウト、入力キャンセル、plot 挿入もこのファイルです。
- task_panel.js – normalizeTasks()/applyTasksData()/renderTaskTree()/loadResults() で課題一覧と成績バッジを描画し、折りたたみ状態を維持します。
- task_selection.js – selectTask()/saveToServer()/submitToServer()/cancelSubmission()/applyInitialCodeIfBlank() など、課題選択と保存・提出ロジックを担当します。ヒント開封時のサイレント保存もここです。
- editor_controls.js – initEditor()/setupControls()/updateGhostVisibility()/showStatusMessage()/pythonLinter()/updatePlayStopButtons() を保持し、CodeMirror と UI イベントを初期化します。pythonLinter は Pyodide で compile し、invalid character/U+XXXX を特定して該当文字のみ強調、invalid syntax で位置がずれる場合は直前の識別子を優先表示します。compile 通過後も AST を走査して未定義変数を検出し、最初の未定義箇所をエラーとして返します。エラー箇所は上から 1 件目のみをハイライトします。

### py_worker.js
- onmessage ハンドラ – メインスレッドから {type:'run', token, code, needsMatplotlib} が届くと Pyodide をロードし、必要に応じて matplotlib.use('Agg') と plt.show をラップして PNG dataURI を print("<<<PLOT>>>data:image/png;base64,...") で出力します。
- postMessage – 実行中は stdout/stderr/input_request/plot イベントをメインスレッドへ送信します。input_request ではメインスレッドがユーザー入力を取得し、応答を再び Worker に送ります。stop メッセージを受け取ると KeyboardInterrupt を発生させます。

### task_editor.js
- init() – 画面読み込み時に CodeMirror エディタを初期化し、ツリー表示の折りたたみ状態を localStorage['taskEditor.collapsed.<server>'] から復元します。
- loadTaskList() – POST action=getTasks を実行して取得したタスクリストを normalizeTasks() で TaskId/Title/… 形式に正規化し、window.__TASKS に保存した上で renderTaskTree() を呼び出します。
- setActiveTask(taskId) – 選択したタスクの詳細をフォームとエディタに反映します。フォルダ行の場合は折りたたみトグルとして扱います。
- saveTask() – URLSearchParams を組み立てて POST action=saveTask を送信し、{status:'ok', taskId} の戻り値を受け取ります。成功後は loadTaskList() で最新状態を取得します。エラー時は setStatus() で UI に表示するのみでフォーム内容は保持しません。
- copySelectedTask() – 選択されたタスクの内容を複製し、Utilities.getUuid で新しい ID を生成して saveTask() に渡します。

## Pyodide と Matplotlib の処理フロー
プログラム実行はメインスレッドから Web Worker 経由で Pyodide に委任されます。下記は runCode() と py_worker.js のやり取りの概要です:
 1.runCode() はエディタから取得したコードを非同期関数に変換し、ensurePyWorker() で Worker が存在しなければロードします。postMessage で {type:'run', token, code, needsMatplotlib} を送信します。
 2.Worker は初回メッセージ時に Pyodide を読み込み、matplotlib.use('Agg') を設定し plt.show をパッチします。exec でコードを実行し、標準出力・エラーは stdout/stderr として逐次 postMessage します。
 3.Matplotlib の描画では plt.savefig の PNG を base64 へ変換し、print("<<<PLOT>>>data:image/png;base64,...") として出力します。メインスレッドの handleStdoutChunk() がこのマーカーを検出し <img> 要素を追加します。
 4.ユーザー入力が必要な場合、Worker は input_request を送信し、メイン側でダイアログを表示して値を取得し Worker へ返します。
 5.stopCode() を呼び出すと stop メッセージを送り、Worker 側で KeyboardInterrupt を発生させます。SharedArrayBuffer が無効な環境では Worker が強制終了されます。

## LocalStorage と GAS の同期方法
クライアントは学習状態をブラウザ内にキャッシュしつつ、必要に応じて GAS へ同期します。
- セッション情報の保持 – index.html の setSession は localStorage と sessionStorage に sessionId、userId、classId、number を保存します。ログイン成功時や新規登録時に初期化されます。persistSession() はこれらを保持し、clearSession() は削除します。
- 課題一覧と進捗キャッシュ – startPreload() で取得した tasks と <UserId> シートの全行は learn.snapshot.<server> キーに JSON で保存されます。app_state.js の loadSnapshot()/saveLocalState() がこれを読み込み、main.js が初期表示へ適用します。また task_panel.js は snapshot.states の submitted/code を参照して .status-badge と task-icon を初回描画時から提出済み/編集中の状態色に更新します。
- 折りたたみ状態の保持 – 課題ツリーの折りたたみ状態は localStorage['taskList.collapsed.<server>'] に、課題エディタのツリー状態は taskEditor.collapsed.<server> に保存されます。
- 課題別キャッシュ – saveToCache() と loadFromCache() は cache_<sessionId>_<taskId> キーにコード・出力・提出状態・ヒント開閉を保存・復元します。直近に選択した課題 ID は saveSelectedTaskId() で保持され、再読み込み時に復元されます。
- GAS への同期 – saveToServer()/submitToServer() は comm_payload.js で生成したフォームエンコード文字列を SheetIO.postTaskSave() 経由で GAS に送信します。通信エラー時はキャッシュのみ更新されるため、再試行が必要です。

## セッション管理の仕様（ID生成・有効期限）
- セッション生成 – login.html で passwordHash の送信に成功すると、Apps Script の login_(e) が session シートに行を upsert し、UUID 形式の SessionId を生成します。既に同じユーザーのセッションが存在する場合は LastActive だけ更新します。
- 有効期限 – Apps Script の validateSession_(sessionId) は SESSION_TTL_MINUTES を参照して LastActive からの経過時間をチェックし、期限超過時はレコードを削除します。しかし現行設定では 0（無期限）となっており、手動で削除するまで有効です。
- セッション検証 – フロントエンドは action=ping や validateSessionEndpoint を叩いてセッション検証を行う設計ですが、POST 送信された ping は saveUserCode_ にフォールバックするため常に missing taskId エラーを返します。このため UI はセッションの無効化に気付かず、API 呼び出し時にのみ 401 エラーが発生します。
- ログアウト – logout_(e) が呼ばれると removeSession_(sessionId) で session シートの行を削除し、クライアント側の clearSession() でストレージを初期化します。

## SALT 認証の仕組み
- ユーザーごとの SALT は user シートに保存され、登録時 (initPassword_) に 3 文字のランダム文字列が生成されます。
- ログイン時は Step1 で getSalt を呼び SALT を取得し、Step2 で SALT + password を SHA‑256 でハッシュ化して送信します。Apps Script は保存済みのハッシュと比較して一致するとセッション ID を発行します。
- SALT は静的に保存されるため、パスワード変更機能が実装されるまではユーザー毎に固定です。SALT とハッシュを GET クエリとして送信するため、サーバーのアクセスログやブラウザ履歴に残る可能性があり、HTTPS 環境で利用することが推奨されます。

## スプレッドシート構造
Apps Script (Code.gs) では Google スプレッドシートをデータベースとして利用します。各シートの列名と役割は次のとおりです。
| シート名       | 主な列                                                                                                   | 役割                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `user`     | `ID`, `Password`, `ClassId`, `Number`, `SALT`                                                         | 登録ユーザーの認証情報。`getUserRowById_` が ID 正規化を行い、`initPassword_` が SALT とハッシュ値を保存します。                 |
| `session`  | `SessionId`, `UserId`, `ClassId`, `Number`, `LastActive`                                              | 発行されたセッションの管理。`validateSession_` は `LastActive` を更新し、有効期限チェックを行います。                            |
| `task`     | `TaskId`, `ParentId`, `IsFolder`, `Title`, `Attribute`, `DescriptionHtml`, `HintHtml`, `AnswerCode`, `InitialCode` | 課題のメタデータ。`Attribute` は「基礎/演習/発展/その他」を保持し、未指定時は第2階層フォルダ名が (1)基礎/(2)演習/(3)発展 に一致するかで自動判定、一致しない場合は「その他」となります。`saveTask_` は既存行を更新し、`TaskId` 未指定の場合は `T` + UUID を自動採番します。                            |
| `<UserId>` | `TaskId`, `Code`, `Output`, `HintOpened`, `Submitted`, `SavedAt`, `Score`, `Comment`                  | ユーザーごとの進捗データ。`saveUserCode_` が行を upsert。採点ページは `Score`/`Comment` を更新しつつ `Submitted` を解除し、`getSavedTaskForUser_` と `getUserSnapshot_` が読み出します。 |

## エラー処理と再試行ロジック
- Apps Script の doGet/doPost はそれぞれ try/catch で囲まれており、例外発生時に {status:'error', message:String(err)} を返します。しかしフロントエンド側では一部のエラーを握りつぶして {status:'ok'} と扱っている箇所があります（例: index.html の action=ping）。開発者は API エラーを検知したら UI に適切なフィードバックを表示するよう修正すべきです。
- parseFormPost_ は e.postData.contents を & で分割し、最初の = でキーと値を切り分ける単純な実装であり、値に = や & を含む場合に欠落が発生します。大きなコードや base64 データ URI を送信する際は注意が必要で、将来的には JSON 形式への移行が望まれます。
- saveTask_ と saveUserCode_ は同時書き込み時の競合検知やロック処理を行わないため、授業中の集中アクセスでデータが取り違えられるリスクがあります。定期的なバックアップや排他制御の導入を検討してください。

## CORS / iFILTER / HTTP 配置での制約
- フロントエンドと GAS は同一ドメイン上に配置することが前提であり、application/x-www-form-urlencoded で送信することでプリフライトリクエストを回避しています。別オリジンに配置する場合は適切な CORS 設定が必要です。
- 学校内ネットワークの iFILTER などが cdn.jsdelivr.net へのアクセスを遮断すると Pyodide や CodeMirror が読み込めず、学習画面が表示されません。ローカルにライブラリをホストするか、事前にファイアウォール設定を確認してください。
- HTTP 配布環境では WebCrypto の使用制限や Mixed Content 制約が発生するため、可能な限り HTTPS で配布してください。JS が WebCrypto の代替として純粋な SHA-256 実装を提供しますが処理時間が長くなるため注意が必要です。

## 本番用・テスト用の GAS スプレッドシートID切り替え方法
開発と運用を切り分けるため、本番用とテスト用で別のスプレッドシートを使用することを推奨します。切り替えは以下の手順で行います。
- GAS 側の設定 – Code.gs の最上部にある SPREADSHEET_ID および SESSION_TTL_MINUTES をテスト用シートの ID に書き換え、保存後に新しい WebApp としてデプロイします。デプロイ URL を控えておきます。
- フロントエンドの更新 – public/config.js の serverBaseUrl をテスト用 WebApp の URL に変更します。必要に応じて saveScript や submitScript を個別に分離することもできます。
- 環境ごとの切り替え – 開発時はテスト用 URL を読み込み、本番リリース時に本番用 URL に戻します。index.html の learn.snapshot.<server> キーはサーバー名を含むため、異なる環境同士でキャッシュが干渉しません。
以上の手順を踏むことで、テストデータが本番の授業に混在するリスクを避けつつ安全に開発できます。

## summary.html / submission_summary シート
- 目的: 課題一覧を1行ずつ、クラスごとに「クリア済/採点済/提出済/未提出」の件数を横断表示する集計画面。事前に生成した submission_summary シートを高速に読み込みます。
- データソース: Apps Script の getSubmissionSummary（キャッシュ読み込み）と buildSubmissionSummary（再集計）を利用。シートは TaskId/Title/Path に続けて <Class> クリア済 <Class> 採点済 <Class> 提出済 <Class> 未提出 を4列1組で並べ、1行目に GeneratedAt を保持します。
- 判定ルール: submitted=true を最優先、次に score=100 をクリア、score が数値なら採点済み、それ以外は未提出としてカウントします。
- UI: フィルタ入力、クラス列の表示/非表示トグル、集計シートを読み込む/再集計して更新 ボタン、横スクロール可能なテーブルで件数を表示します。
- 採点対象外: Attribute が「その他」の課題は再集計・キャッシュ読み込みともに除外し、件数にも反映しません。クライアント側でも path から推測した属性でフィルタします。

## progress.html / user_progress シート
- 目的: ユーザを行、課題を列に並べたスコア表をスプレッドシートに生成し、その内容を HTML で横断表示する。100 点は属性色の ★、採点済み 100 未満は数値、未採点は空欄で示す。
- データソース: Apps Script の buildUserProgress（再集計）/getUserProgress（既存シート読み込み）が user_progress シートを生成・取得する。列は UserId/ClassId/Number に続き、属性ごとに「クリア件数/総件数」「スコア合計/満点」を2列ずつ、全課題の同指標を2列、その後に課題列（TaskId）が並ぶ。1 行目は GeneratedAt/TaskCount のメタ、2 行目はヘッダ、3 行目は課題列の Attribute、4 行目は課題 Path を保持する。
- 並び順: 課題列は Attribute の順（基礎→演習→発展→その他）でまとめ、同属性内は Path→Title→TaskId の順で昇順ソートする。属性サマリ列も同じ順序で固定。
- 判定と集計: score=100 をクリア件数に加算し、score が数値ならスコア合計に加算する。満点合計は課題数×100 を使用。Attribute が未指定でも基礎/演習/発展/その他のいずれかに正規化した上で計算する。
- UI: クラス/ユーザのフィルタとタスク検索、user_progress シートの再集計ボタン、シート読み込みボタンを備える。ユーザ情報と属性別/全体サマリ列は position:sticky で固定し、ヘッダ行もスクロール固定する。タスク列ヘッダには属性バッジと Path を表示する。
- 並び替え: ユーザID/件数/スコアの昇順・降順を切り替えるボタンを持ち、アクティブなキーと昇降をボタンラベルで表示する。ソート対象は表示中（フィルタ・属性トグル後）のタスクのみで再集計した件数・スコア。

## index.html（トップ画面）の追加表示
- ユーザ進捗サマリ: その他を除外したうえで、ログイン中ユーザの「クリア件数/総数」「スコア合計/満点」を課題状態ボックスの上部に表示する。
- ハイスコア（上位20名）: user_progress シートを action=getUserProgress でキャッシュ読み込みし、再集計は実行しない。属性「その他」を除外し、スコア合計降順で上位20件を表示する。ヘッダは「順位/クラス/クリア件数/スコア合計/基礎/演習/発展」。基礎・演習・発展列にはその属性の課題スコアを連結して表示し、100 点は属性色の ★、数値スコアはそのまま、未提出・未採点・0 点は空文字。列は圧縮表示で横スクロール可。

