# データフロー図・通信仕様

本書では、クライアントと Google Apps Script (GAS)、Pyodide ワーカー間でデータがどのように流れるかを時系列で説明します。ASCII 形式のシーケンス図とフロー図を用いて通信仕様を明確にします。

## index.html のデータ流れ
トップ画面はセッション確認と課題プリロードを担当します。
1. ページ読み込み – index.html は localStorage.sessionId と URL の sid パラメータを読み出します。両者が一致しない場合はログインを要求します。
2. セッション検証 – fetch(serverBaseUrl, {method:'POST', body:'action=ping&session=<id>'}) を送信しますが、GAS 側に ping ハンドラが無いため saveUserCode_ にフォールバックし、missing taskId エラーが返されます。フロントは catch で {status:'ok'} と扱います。
3. 課題と進捗のプリロード – startPreload() で POST action=getUserSnapshot を送信し、Apps Script の getUserSnapshot_ が task シート全体と <UserId> シートの進捗データを返します。states は code/output/hintOpened/submitted/savedAt に加えて採点結果の `score`/`comment` を含め、クライアントは JSON を learn.snapshot.<server> に保存します。
4. 採点対象外の扱い – task シートには Attribute 列が含まれ、クライアントは Attribute が「その他」の課題をログイン画面の状態サマリから除外します（学習画面では `[採点対象外]` としてのみ表示）。
4. 画面遷移 – セッションが有効であれば main.html へのボタンを有効にし、クリックで遷移します。無効の場合は login.html へ誘導します。

## プログラム実行（Pyodide → Matplotlib → GAS 保存）の流れ
学習画面でコードを実行する際のフローは以下の通りです。
1. ユーザーの操作 – 生徒は runButton をクリックし、runner.js の runCode() が呼び出されます。現在のコードと課題 ID を取得します。
2. Pyodide Worker への送信 – ensurePyWorker() で Web Worker (py_worker.js) を生成し、postMessage({type:'run', token, code, needsMatplotlib}) を送信します。token は実行識別子です。
3. Pyodide 内部処理 – Worker は Pyodide をロードし、コードを exec します。plt.show() が呼ばれた場合は PNG base64 へ変換し print("<<<PLOT>>>data:image/png;base64,...") として stdout に混ぜます。実行中は stdout、stderr、input_request をメインスレッドに送信します。
4. 出力の受信と表示 – メインスレッドの handleStdoutChunk() が <<<PLOT>>> マーカーを検出し <img> 要素を挿入します。その他の出力は #outputArea に追記されます。
5. 保存と提出 – 実行結果に満足したら saveToServer() でコードと出力を saveUserCode_ へ送信し、スプレッドシートの <UserId> シートに保存します。提出時は submitted=true をセットします。

## 課題エディタ保存フロー（JS → GAS → シート）
教員用の課題エディタで課題を保存する流れは次の通りです。
1. 編集内容の入力 – task_editor.html でフォルダや課題を選択し、タイトル・説明・ヒント・解答例・初期コードを入力します。
2. POST パラメータの生成 – task_editor.js の saveTask() は URLSearchParams を利用し TaskId, ParentId, IsFolder, Title, DescriptionHtml, HintHtml, AnswerCode, InitialCode, session（任意）をフォームエンコードします。
3. GAS への送信 – fetch(serverBaseUrl, {method:'POST', body: params}) を呼び出し、doPost の saveTask_ が実行されます。TaskId が未指定の場合は T + UUID が自動採番されます。
4. スプレッドシート更新 – Apps Script は task シートの該当行を更新または追加し、{status:'ok', taskId} を返します。フロントエンドは戻り値の ID を更新し、ツリーを再読み込みします。

## ログイン処理の時系列
二段階認証によるログインの流れを示します。
1. ID 送信 – ユーザーは login.html で ID を入力し、#idForm を送信します。ブラウザは GET ?action=getSalt&id=<id> を呼び出します。Apps Script の getSalt_(e) は ID 正規化を行い、SALT または exists:false を返します。
2. パスワード入力 – SALT が存在する場合、PW 入力フォームが表示されます。ユーザーが入力したパスワードに SALT を付加し、SHA-256 でハッシュ化します。
3. ログインリクエスト – GET ?action=login&id=<id>&passwordHash=<hash> を呼び出します。login_(e) は user シートのハッシュと照合し、一致すれば session シートに行を upsert し sessionId,userId,classId,number を返します。
4. セッション保存と遷移 – フロントエンドはレスポンスを localStorage/sessionStorage に保存し、トップ画面に遷移します。

## 非同期処理のシーケンス図
以下に、主な通信シーケンスをテキスト図で示します。→ はリクエスト、← はレスポンスを表します。簡略のためエラー処理やサーバー内部処理は省略しています。
## 採点シーケンス
採点向けの通信フローをまとめて示します。

採点データ取得:
採点ページ → GAS: POST getClassSubmissions(classId または userId)
GAS → 採点ページ: {status:'ok', classId, students[{userId,number}], submissions[userId][taskId]={code,output,hintOpened,submitted,score,comment}, tasks=[...]}
ローカルキャッシュ:
採点ページ → localStorage: `grading.<server>.cache.<ClassId>` に tasks/students/submissions/fetchedAt を保存し、ユーザID↔クラスの対応も `grading.<server>.userClass.<UserId>` に記録
採点ページ → GAS: `lastLoadedAt`（直近 fetchedAt）付きで getClassSubmissions を再要求
GAS → 採点ページ: `<UserId>` シートで `SavedAt >= lastLoadedAt` な行のみ submissions に含め、レスポンスに最新 fetchedAt を返却

採点保存:
採点ページ → GAS: POST saveScores(entries=[{userId,taskId,score,comment}])
GAS → <UserId> シート: Score/Comment を SavedAt の右側に書き込み Submitted=FALSE
GAS → 採点ページ: {status:'ok', updated:n}

学習画面への反映:
index.html の getUserSnapshot → localStorage.learn.snapshot.<server> に score/comment を含めて保存 → task_panel.js の loadResults() がスナップショットから score を取得 → `[採点済]` バッジ、score=100 なら `.task-icon.sparkle-star`（単色ゴールド＋太めの輪郭と斜めグリント）、100 点未満ならピンク (`#ff8fb7`) の `.dot-icon` を適用し、さらに dirty フラグが立った場合はスコアがあっても `[編集中]` 表示が優先される → `submitted=true` の課題は紫 (`#9254de`) のドットと `[提出済]` を表示し、再提出時は submitted=true となり `[提出済]` が最優先で表示される。task_selection.js は取得した comment を `#commentBubble` に描画し、コメントが無いが score=100 の場合は固定メッセージ「満点クリア、お見事！ここまで積み上げた工夫が光っています。」を表示、バルーンの下部には常時「クリックで最小化」というガイド文を添える。コメントもスコアも無ければバルーンを非表示にする。
***
参加者: ユーザー   ブラウザ(学習画面 JS)   Pyodide Worker   GAS / スプレッドシート

ログインシーケンス:
ユーザー→ブラウザ: ID 送信
ブラウザ→GAS: GET getSalt(id)
GAS→ブラウザ: {status:'ok', salt}
ユーザー→ブラウザ: PW 入力
ブラウザ: salt+password をハッシュ
ブラウザ→GAS: GET login(id,passwordHash)
GAS→ブラウザ: {status:'ok', sessionId,userId,classId,number}
ブラウザ→ブラウザ: session を localStorage に保存

コード実行シーケンス:
ユーザー→ブラウザ: runButton クリック
ブラウザ→Worker: postMessage({type:'run', code, token})
Worker→ブラウザ: stdout/stderr/input_request/plot メッセージ(複数)
ユーザー→ブラウザ: 入力応答 (必要な場合)
ブラウザ→Worker: ユーザー入力
Worker→ブラウザ: 実行終了通知
ブラウザ→GAS: POST saveUserCode(session,taskId,code,output,...)
GAS→スプレッドシート: <UserId> シートを upsert
GAS→ブラウザ: {status:'ok'}

課題取得シーケンス:
ブラウザ→GAS: POST getTasks(session)
GAS→ブラウザ: {status:'ok', tasks=[...]} (task シート全体)
ブラウザ→ブラウザ: tasksData に格納、renderTaskTree()

課題保存シーケンス(教員):
ユーザー→ブラウザ: saveTask ボタン
ブラウザ→GAS: POST saveTask(課題内容,session)
GAS→スプレッドシート: task シートを upsert
GAS→ブラウザ: {status:'ok', taskId}
ブラウザ→ブラウザ: ツリー再読込
この図を参考にして非同期処理と通信の流れを理解し、デバッグや拡張時に役立ててください。

## 集計シートの生成と参照
- 再集計: Apps Script の buildSubmissionSummary_ が task シートと各 <UserId> シートを走査し、提出済み>score=100>数値 score>未提出の優先順位で件数を数え、submission_summary シートに書き出します。先頭行に GeneratedAt を入れ、以降は TaskId/Title/Path とクラス×4状態の列を並べます。
- 参照: summary.html は既存シートを action=getSubmissionSummary で読み込み、必要なときだけ action=buildSubmissionSummary で再集計を依頼します。どちらも application/x-www-form-urlencoded で serverBaseUrl へ POST します。
- キャッシュ方針: 集計はシート生成時にのみ計算し、画面表示時はシート読み込みのみとすることでアクセスごとの待ち時間を削減します。
