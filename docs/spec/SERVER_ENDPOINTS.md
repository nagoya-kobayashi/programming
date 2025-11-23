# SERVER_ENDPOINTS

## エントリポイント (`google_apps_script/Code.gs`)

| Endpoint | HTTP | 役割 |
| --- | --- | --- |
| `doGet` | GET | `action` に応じて `getTasks_` / `getSalt_` / `getUserMeta_` / `initPassword_` / `login_` / `logout_` / `ping` / `validateSessionEndpoint_` / `getSavedTaskForUser_` を返却。未知の `action` は `status:error`。|
| `doPost` | POST | `getTasks_`, `getUserSnapshot_`, `saveTask_` を優先し、それ以外はすべて `saveUserCode_` にフォールバック。|

> NOTE: `ping` は GET のみ対応。フロント (index.html) は POST `action=ping` を送信しているため、Apps Script 側では `saveUserCode_` が呼ばれて `missing taskId` エラーを返している。

### シート一覧 (冒頭コメント・`openSs_` 周辺)

- `user`: `[ID, Password, ClassId, Number, SALT]`
- `session`: `[SessionId, UserId, ClassId, Number, LastActive]`
- `task`: `[TaskId, ParentId, IsFolder, Title, DescriptionHtml, HintHtml, AnswerCode, InitialCode]`
- 各 `<UserId>` シート: `[TaskId, Code, Output, HintOpened, Submitted, SavedAt]`

`openSs_()` は `SPREADSHEET_ID` → ScriptProperties → `getActiveSpreadsheet` の順に解決し、失敗時は例外。

## 認証フロー (getSalt / login / initPassword)

1. `getSalt_(e)` (`Code.gs:224-239`)  
   - 入力: `id` (query)  
   - 処理: `getUserRowById_` で ID 正規化（小文字化・ゼロ幅スペース除去）を行い、`salt` 列を返却。  
   - 出力: `{status:'ok', salt:'...'}` (存在しない場合は `{status:'ok', exists:false}`)。
2. `getUserMeta_(e)` (`240-269`)  
   - 入力: `id`。  
   - 出力: `passwordSet`, `classId`, `number`, `salt` を返す。`register.html` が初期登録判定に利用。
3. `initPassword_(e)` (`270-304`)  
   - 入力: `id`, `salt`, `passwordHash` (すべて GET)。
   - 処理: SALT・Password が空のユーザーのみ更新。`user` シートの該当行に SALT/ハッシュを保存。
4. `login_(e)` (`307-369`)  
   - 入力: `id`, `passwordHash` (推奨) もしくは `password` (平文)。
   - 処理: `user` シートの `Password` と比較し、合致したら `session` シートに `SessionId` を upsert。既存セッションがあれば `LastActive` だけ更新。
   - 出力: `{status:'ok', sessionId, userId, classId, number}`。
5. `logout_(e)` (`371-374`)  
   - 入力: `session`。  
   - 処理: `removeSession_(sessionId)` で `session` シートから該当行を削除。

## セッション発行/検証/削除

- `validateSession_(sessionId)` (`118-152`)
  - `session` シートを走査し、一致行を見つけた場合に `LastActive` を `fmtDate_(now)` で更新して `{sessionId,userId,classId,number}` を返す。
  - `SESSION_TTL_MINUTES` が `>0` のときのみ有効期限チェックを行い、超過していたら行を削除。現在は `0` のため無期限。
- `validateSessionEndpoint_(e)` (`154-159`): GET `session=<id>` を受け取り、`json_({status:'ok', userId, classId, number})` を返すヘルパー。
- `removeSession_(sessionId)` (`161-173`): `session` シートを末尾から走査して一致行を削除。

## 課題エディタ API (`saveTask` / `getTasks`)

- `getTasks_(e)` (`376-389`)
  - HTTP: GET/POST (両対応)。
  - 入出力: 認証無しで `task` シート全体 (`values`) を `{status:'ok', tasks:[[header...], [row...], ...]}` として返却。クライアント (`task_editor.js`, `main.js`) 側でヘッダ名を正規化する。
- `saveTask_(e)` (`391-458`)
  - HTTP: POST (`application/x-www-form-urlencoded`)。`task_editor.js` は `session` を付与するが必須ではない (`sid` 未指定でも保存可能)。
  - 入力フィールド: `TaskId` (任意), `ParentId`, `IsFolder`, `Title`, `DescriptionHtml`, `HintHtml`, `AnswerCode`, `InitialCode`。
  - 処理: 既存 `TaskId` 行を更新、未指定なら `T` + UUID(8文字) を自動採番。  
  - 出力: `{status:'ok', taskId}`。

## 学習データ API (saveTask / getTasks / saveUserCode / getSavedTaskForUser / getUserSnapshot)

- `saveUserCode_(e)` (`605-648`)
  - HTTP: `doPost` のフォールバック (action 不問)。
  - 入力: `session` または `id`、`taskId`, `code`, `output`, `hintOpened`, `submitted`。
  - 認証: `session` が無い場合も `id` で上書き可能な設計。`taskId` が空だと `status:'error'`。
  - 処理: `<UserId>` シートを upsert し `SavedAt` を `fmtDate_(new Date())` に更新。
- `getSavedTaskForUser_(e)` (`460-503`)
  - HTTP: GET。`taskId` 必須、`session` または `id` を要求。
  - 出力: `{status:'ok', data:{code, output, hintOpened, submitted}}`。該当が無い場合は空値を返す。
- `getUserSnapshot_(e)` (`529-603`)
  - HTTP: POST `action=getUserSnapshot`。
  - 処理: `session` を検証し、`task` シート全体と `<UserId>` シートの全行を `states[taskId]={code,output,hintOpened,submitted,savedAt}` にまとめて返却。`tasks` 側にはフォルダ行も含まれる。
- `getTasks_` はフロント学習画面 (`main.js`) からも使用。
- `saveSpecificTask()` (`main.js:101-131` 付近) がヒント開封をサイレント保存する際にも `saveUserCode_` が呼ばれている。

## `application/x-www-form-urlencoded` のパース

- `parseFormPost_(e)` (`102-115`)
  - `e.postData.contents` を `&` で split し、`k=v` 形式を `decodeURIComponent`。`+` をスペースに変換する明示処理 (`replace(/\+/g,' ')`) あり。
  - 現状は同一キーの複数値や `=` を含む値を考慮していないため、長いコードが多段に split されると後半が欠落する恐れがある。
- `SheetIO.postTaskSave` / `task_editor.js` / `index.html` など、GAS と通信するフロントエンドは `Content-Type: application/x-www-form-urlencoded` で送信し、プリフライトを避けている。

## 例外処理と注意点

- `doGet` / `doPost` はそれぞれ `try/catch` で囲み、例外発生時に `{status:'error', message:String(err)}` を返している。
- `openSs_` は `openById`・ScriptProperties・`getActiveSpreadsheet` を順に試み、すべて失敗すると例外。ログ (`console.error`) を出力するが呼び出し側では捕捉していない。
- 認証の無い `saveTask_` / `saveUserCode_` 呼び出しが可能であり、`id` を直指定すれば他人のコードを改ざんできてしまう構造になっている。
- `SESSION_TTL_MINUTES = 0` のため、`validateSession_` は実質無期限セッションを許可。教員側で定期的に `session` シートを手動クリーニングする必要がある。
