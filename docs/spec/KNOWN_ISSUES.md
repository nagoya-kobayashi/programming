# KNOWN_ISSUES

## TODO / FIXME / ログ由来の懸念

- アプリ本体のソースには TODO/FIXME は存在せず、`.git/hooks/sendemail-validate.sample` にのみテンプレート TODO が残っている。今後の課題管理は別ドキュメントが必要。
- `console.warn`/`console.error` で検出した通信失敗 (`[index] validateSession err`, `[main] getTasks HTTP ...`) は握り潰され UI 側では `{status:'ok'}` 扱いになる (`index.html` 下部スクリプト)。不具合を把握できないまま進行するリスクがある。

## セッション・認証まわり

- `index.html` は `action=ping` を **POST** (`fetch(server, {method:'POST', body:'action=ping&session=...'})`) しているが、Apps Script 側 (`doPost`) は `ping` をハンドリングしていないため `saveUserCode_` が呼ばれ常に `missing taskId` エラーになる。UI は catch で `{status:'ok'}` を返してしまい、セッション妥当性を検証できていない。
- `Code.gs` の `SESSION_TTL_MINUTES = 0` により、`validateSession_` は実質期限切れチェックを行わない。ユーザーがログアウトしない限り半永久的に有効なセッションレコードが残り続ける。
- `saveTask_(e)` は `session` が空でも保存できる設計 (チェックは `sid` が指定された場合のみ)。URL さえ知っていれば誰でも課題を追加/更新できる。
- `saveUserCode_(e)` も `session` が無い場合に `id` フィールドだけで実行できるため、任意のユーザー ID を指定すれば他人のコードや提出ステータスを書き換えられる。
- `register.html` / `login.html` は SALT とハッシュを GET クエリ (`?salt=...&passwordHash=...`) に乗せて送るため、サーバーログ・ブラウザ履歴・プロキシに認証情報が残る。HTTP 環境では `secHint` で注意喚起しているが実質的に盗聴されうる。
- `change_password.html` / `change_password.js` は `action=changePassword` を想定しているが、Apps Script に該当エンドポイントが存在しないため常にエラーを返す。パスワード変更機能が動作しない。

## GAS ⇔ JS 連携上の危険箇所

- `doPost` のフォールバックが常に `saveUserCode_` になっているため、`index.html` の `ping` など本来 JSON を期待するリクエストが `missing taskId` エラーになる。用途を識別する `action` スイッチが不足しており将来的な API 拡張が困難。
- `parseFormPost_(e)` は `split('=')` で最初の `=` しか考慮していないため、送信コード内に `=` や `&` が含まれると値が欠損する。URL エンコード後も `=` を含む base64 (`data:image/png;base64,...`) を扱うケースでは特に危険。
- `saveTask_` / `saveUserCode_` どちらもトランザクション/ロックを行っておらず、同時書き込み時の競合検知が無い。授業中の集中アクセスでデータの取り違えが発生する恐れがある。
- `getTasks_` はシートのヘッダ行から列インデックスを推定するだけで列名検証をしていない。列削除や順序変更が起きるとクライアントの `normalizeTasks` 側で例外は出ず空文字が入るため、気付かないまま破損したデータが配信される。

## クライアント (学習画面/課題エディタ)

- `main.js` のセッション検証は `index.html` と同じく失敗時に `clearSession()` せず `window.dispatchEvent('session-ready')` を発火してしまうケースがある。無効セッションで API を叩き続けると `401` が返った瞬間にだけログアウトする挙動になる。
- `appendPlotDataUrl()` (`main.js:132-156`) は DOM に `<img>` を追加する一方で `outputBuffer` には `[plot]` というプレースホルダ文字列しか保存しない。このため提出・再読込後には出力履歴から実際の図が復元できない。
- `hintButton` でヒントを開くと `saveSpecificTask()` がサイレントで GAS に POST するが、通信失敗時は catch して `console.warn` を出すだけで UI には知らせない。提示済みフラグがサーバーと食い違う可能性がある。
- Web Worker を利用した割り込み (`SharedArrayBuffer`) はクロスオリジン分離が無いと無効になるが、HTTP 配布環境では `workerCanInterrupt=false` で `stop` ボタンが即 kill (terminate) にフォールバックし、途中で保存もされない。
- `task_editor.js` も `saveTask` 失敗時にステータスを更新するのみで、フォーム入力内容を保持しない。リロードが走ると入力内容が失われる。

## HTTP/HTTPS・iFILTER など環境依存の懸念

- Pyodide/CodeMirror/Matplotlib は `cdn.jsdelivr.net` を参照してロードするため、iFILTER や校内プロキシで CDN が遮断されると学習画面が初期化できない。ローカル配布手段やオフラインキャッシュ戦略が必要。
- `register.html` / `login.html` は HTTP 環境で WebCrypto が使えない場合に純粋 JS 実装へフォールバックしているが、同コードは `TextEncoder` 依存かつブラウザ負荷が高い。古い iFilter 端末ではハッシュ計算に数秒かかりタイムアウトする恐れがある。
- `config.js` の `serverBaseUrl` は完全な HTTPS URL を想定しており、HTTP→HTTPS 混在時はブラウザの Mixed Content 制限でブロックされる。授業 PC が HTTP でしか配布できない場合、すべての fetch が失敗する。

## 文字エンコード・改行・dataURI に関する既知不具合

- `CommPayload.createTaskSavePayload` は `output` 文字列の `\r\n` を `\n` に正規化しているが、GAS 側で `parseFormPost_` が `+`/`%XX` の復元しか行わないため、全角/サロゲートペアを多用したコードを保存すると壊れるケースがある。
- dataURI (`<<<PLOT>>>data:image/png;base64,...`) は実行時には DOM に挿入されるが、保存時の `outputBuffer` に base64 を残していないため、提出データに図が含まれない。採点時に再現できない問題が既知。
- `parseFormPost_` の `split('&')` → `split('=')` 実装は行末の空行を無視しないため、末尾が改行で終わると空キーが追加されて `decodeURIComponent('')` 例外が発生することがある (index の ping など簡易 POST で顕在化)。
