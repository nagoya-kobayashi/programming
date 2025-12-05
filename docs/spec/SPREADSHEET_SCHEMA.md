# スプレッドシート構造仕様書

本書は「緑高校プログラミング」スプレッドシートの**シート構造と列定義**をまとめたものです。Apps Script (`Code.gs`) やフロントエンド各画面から参照されるデータテーブルのスキーマを一覧し、既存の TECH_SPEC/DATA_FLOW に散在している情報を補完します。

> 注意: 列名や並び順を変更する場合は、必ず `Code.gs` とフロントエンド (`sheet_io.js`, `task_editor.js`, `task_selection.js` など) の実装と本ドキュメントを同時に更新してください。

---

## 1. `task` シート

- 役割: 課題ツリー（フォルダ構成・問題文・ヒント・コード）を保持するマスタテーブル。
- 主な利用箇所:
  - `task_editor.html` / `task_editor.js` … 課題の作成・編集・保存 (`saveTask_`)
  - `main.html` / `task_panel.js` / `task_selection.js` … 課題一覧・問題文の表示
  - 集計系 (`submission_summary`, `user_progress`) の元データ

### 1.1 列定義

`docs/etc/緑高校プログラミング/task.html` より、列は次の順序で定義されています。

| 列名           | 型        | 必須 | 説明 |
| -------------- | --------- | ---- | ---- |
| `TaskId`       | 文字列    | ○    | 課題ID。`T` + UUID など一意な識別子。フォルダにも付与される。Apps Script の `saveTask_` で未指定時自動採番。 |
| `Title`        | 文字列    | ○    | 課題またはフォルダの表示名。課題ツリーや学習画面のタイトルとして使用。 |
| `DescriptionHtml` | HTML文字列 | 課題のみ必須 | 問題文の HTML。本システムでは日本語テキストと `<br>`・`<table>` 等を含む。フォルダ行では空欄。 |
| `HintHtml`     | HTML文字列 | 任意 | ヒント欄の HTML。未設定の場合は学習画面のヒントボタンを非活性または非表示扱い。 |
| `AnswerCode`   | 文字列    | 任意 | 解答例としての Python コード。教員向け画面と採点補助で参照。 |
| `InitialCode`  | 文字列    | 任意 | 生徒画面で最初に表示する初期コード。空欄の場合はテンプレート無し。 |
| `ParentId`     | 文字列    | 任意 | 親フォルダの `TaskId`。最上位フォルダの場合は空欄。ツリー構造の復元に使用。 |
| `IsFolder`     | 真偽値    | ○    | 行がフォルダかどうかのフラグ。`TRUE`=フォルダ、`FALSE`=課題。 |
| `Attribute`    | 文字列    | 任意 | 「基礎/演習/発展/その他」のいずれか。未指定時は TECH_SPEC に記載のルールでフォルダ名から自動判定し、「その他」は採点対象外として扱う。 |

### 1.2 運用上の注意

- 列の追加・削除・順序変更を行うと `getTasks_` やクライアント側の列マッピングが壊れるため、変更時は必ずコードと本仕様書を更新する。
- `Attribute` が「その他」の課題は `submission_summary`/`user_progress` などの集計から除外される（TECH_SPEC/DATA_FLOW 参照）。
- `IsFolder=TRUE` 行では `DescriptionHtml` などのコンテンツ列は空欄にする。

---

## 2. `user` シート

- 役割: ログイン可能なユーザー（生徒・教員）のアカウント情報を保持する。
- 主な利用箇所:
  - `login.html` … SALT 取得 (`getSalt_`) とパスワードハッシュ照合 (`login_`)
  - `register.html` … 初期パスワード設定 (`initPassword_`)

### 2.1 列定義

`docs/etc/緑高校プログラミング/user.html` より、列は次の順序で定義されています。

| 列名      | 型        | 必須 | 説明 |
| --------- | --------- | ---- | ---- |
| `ID`      | 文字列    | ○    | ログインID。例: `s25a01`。URL パラメータ `id` やセッション情報の `userId` と対応。 |
| `Password`| 文字列    | ○    | `salt+password` を SHA-256 したハッシュ値（16進文字列）。ブラウザ側で計算し、Apps Script で照合。 |
| `ClassId` | 文字列    | ○    | クラス記号。例: `A`〜`H` や `X`（教員・特別アカウント）など。 |
| `Number`  | 整数      | ○    | 出席番号。0 や 99 など特別な番号は運用で定義。 |
| `Salt`    | 文字列    | ○    | 3 文字のランダム文字列。`initPassword_` で生成され、ログイン Step1 の `getSalt` で返却される。 |

### 2.2 運用上の注意

- `ID` はスプレッドシートの `<UserId>` シート名や `session` シートの `UserId` と一致させる。
- `Password` と `Salt` はセキュリティ上重要なため、他の列に流用しない。

---

## 3. `session` シート

- 役割: ログインセッションを管理し、ユーザごとの最終アクセス時刻を保持する。
- 主な利用箇所:
  - `login_(e)` / `removeSession_` / `validateSession_`（Apps Script）
  - `index.html` / `main.html` のセッション検証

### 3.1 列定義

`docs/etc/緑高校プログラミング/session.html` より、列は次の順序で定義されています。

| 列名        | 型        | 必須 | 説明 |
| ----------- | --------- | ---- | ---- |
| `SessionId` | 文字列    | ○    | UUID 形式のセッションID。ブラウザの `localStorage.sessionId` と対応。 |
| `UserId`    | 文字列    | ○    | ログインユーザのID（`user` シートの `ID` と対応）。 |
| `ClassId`   | 文字列    | ○    | クラス記号。セッションから画面上のクラス表示や集計時のフィルタに利用。 |
| `Number`    | 整数      | ○    | 出席番号。 |
| `LastActive`| 日時文字列| ○    | 最終アクセス日時。`SESSION_TTL_MINUTES` 設定により有効期限チェックに利用。 |

### 3.2 運用上の注意

- 同一ユーザで複数セッションを許可するかは `login_(e)` の実装に依存するが、現行実装では upsert で LastActive のみ更新する運用を想定している。
- TTL 0（無期限）設定時はレコードが増え続けるため、定期的なクリーンアップが必要（BUGS_AND_RISKS.md 参照）。

---

## 4. `<UserId>` シート（生徒ごとの提出・採点結果）

- 役割: 各ユーザごとのコード・出力・採点結果を保持する。シート名は `user` シートの `ID` と同じ。
- 主な利用箇所:
  - `saveUserCode_`（コード保存・提出）
  - `getUserSnapshot_`（index からのプリロード）
  - 採点系 Apps Script (`getClassSubmissions`, `saveScores`) および `grading.html`

### 4.1 列定義（概略）

現時点では `<UserId>` シートの HTML エクスポートは人数分存在し (`s25a01.html` など)、すべてを精査すると量が膨大になるため、DATA_FLOW.md の記述と既存コードから次のように整理します。

- キー列:
  - `TaskId` … 対象課題の ID（`task` シートの `TaskId`）。
  - `SavedAt` … 保存日時。
- 学習状態:
  - `Code` … 提出された Python コード。
  - `Output` … 実行結果テキスト（グラフは現状 [plot] プレースホルダのみ、詳細は BUGS_AND_RISKS.md 参照）。
  - `HintOpened` … ヒントを開いたかどうかの真偽値。
  - `Submitted` … 提出済みフラグ。TRUE で採点対象として扱う。
- 採点結果:
  - `Score` … 数値スコア（0〜100）。100 はクリア扱い。
  - `Comment` … 採点コメント文字列。

> 正確な列順や補助列の有無については、Apps Script `Code.gs`（特に `saveUserCode_`, `getUserSnapshot_`, `getClassSubmissions_`, `saveScores_` 付近）と併せて確認すること。

---

## 5. `submission_summary` シート

- 役割: 課題ごとの提出状況をクラス別 × 状態別に集計したテーブル。`summary.html` から参照される。
- 主な利用箇所:
  - `buildSubmissionSummary_` / `getSubmissionSummary_`（Apps Script）
  - `summary.html` / `summary.js`

### 5.1 列定義

`docs/etc/緑高校プログラミング/submission_summary.html` と TECH_SPEC/DATA_FLOW より、構造は次の通りです。

- 1 行目（メタ情報）
  - `GeneratedAt` … 集計実行日時。
- 2 行目（ヘッダ）
  - `TaskId` / `Title` / `Path` / `SourceTaskId` など課題識別用列。
  - 以降、クラスごとに 4 列セットで「クリア済/採点済/提出済/未提出」件数を並べる。

> 実際の列名はクラス構成（A〜H など）に依存するため、クラス追加時は Apps Script 側の列生成と本仕様書を合わせて更新すること。

---

## 6. `user_progress` シート

- 役割: ユーザを行、課題を列としたスコア表。`progress.html` とトップ画面のハイスコア表示から参照される。
- 主な利用箇所:
  - `buildUserProgress_` / `getUserProgress_`（Apps Script）
  - `progress.html` / `progress.js`
  - `index.html` のハイスコア表示

### 6.1 列定義

`docs/etc/緑高校プログラミング/user_progress.html` と TECH_SPEC/DATA_FLOW の記述に基づき、次の構造を持ちます。

- 1 行目（メタ情報）
  - `GeneratedAt` … シート生成日時。
  - `TaskCount` … 課題列の総数。
- 2 行目（ヘッダ）
  - `UserId` / `ClassId` / `Number`
  - 属性別サマリ列（基礎/演習/発展/その他）:
    - 各属性ごとに「クリア件数/総件数」「スコア合計/満点」の 2 列ペア。
  - 全課題サマリ列:
    - 全課題の「クリア件数/総件数」「スコア合計/満点」の 2 列ペア。
  - 課題列 (`TaskId`):
    - 以降の列は各課題の `TaskId`。列名として ID を持つ。
- 3 行目
  - 各課題列ごとの `Attribute`（基礎/演習/発展/その他）。
- 4 行目
  - 各課題列ごとの `Path`（フォルダ階層を含む表示名）。
- 5 行目以降
  - 各ユーザ行。属性別サマリ・全体サマリ列と、課題ごとのスコア（100=クリア、数値=採点済み、空欄=未提出/未採点）を保持する。

---

## 7. その他シートと今後の拡張

- `oie` / `yuji` など特定ユーザ用のシートやメモ用シート（例: `採点メモ`）は運用依存のため、本書では仕様対象外とする。
- 新しい集計シートや管理用シートを追加する場合は、TECH_SPEC/DATA_FLOW とあわせて本 `SPREADSHEET_SCHEMA.md` にもスキーマを追記すること。

