# エージェント向け引き継ぎガイド

この文書は本システムの保守・改修を担当する開発者（エージェント）向けの引き継ぎ資料です。ファイル構造、依存関係、注意すべき関数、環境切り替え手順、将来拡張のアイデアを記載します。修正の前には必ず本ドキュメントと TECH_SPEC.md を参照してください。

## ファイルと画面の対応関係
| 画面                           | 関連ファイル                                                                             | 主な役割                                        |
| ---------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------- |
| `index.html`                 | `style.css`, `config.js`, インライン JS                                                 | セッション検証、プリロード、トップメニュー表示                     |
| `login.html`                 | `config.js`, インライン JS                                                              | SALT 取得→パスワードハッシュ計算→ログイン要求                  |
| `register.html`              | `config.js`, インライン JS                                                              | 新規ユーザーの SALT 生成と初期パスワード設定                   |
| `change_password.html`       | `style.css`, `config.js`, `change_password.js`                                     | パスワード変更フォーム（サーバー実装が無く現在はエラー）                |
| `main.html`                  | `style.css`, `config.js`, `comm_payload.js`, `sheet_io.js`, `app_state.js`, `runner.js`, `task_panel.js`, `task_selection.js`, `editor_controls.js`, `main.js`, Pyodide/CDN | 課題一覧表示、コード実行・保存・提出、学習支援 UI の土台                  |
| `app_state.js`               | `main.html`                                                                         | 共有状態・ローカルスナップショット・セッション永続化・キャッシュ鍵管理     |
| `runner.js`                  | `main.html`, `py_worker.js`                                                        | Pyodide/Worker の制御、実行タイマー、handleStdoutChunk などの実行系コア     |
| `task_panel.js`              | `main.html`                                                                         | 課題一覧の取得・正規化・描画、成績データの反映                          |
| `task_selection.js`          | `main.html`                                                                         | 課題選択時の状態切り替え、保存/提出ロジック、ヒント開封のサイレント保存      |
| `editor_controls.js`         | `main.html`                                                                         | CodeMirror 初期化、操作ボタン、ステータスメッセージ、コーディングアシスト連携 |
| `task_editor.html`           | `style.css`, `config.js`, `task_editor.js`, CodeMirror                             | 教員用課題エディタ。課題ツリー管理と課題保存                      |
| `py_worker.js`               | –                                                                                  | Web Worker で Pyodide を読み込み、プログラム実行・グラフ描画を担当 |
| `google_apps_script/Code.gs` | –                                                                                  | GAS サーバー実装。doGet/doPost、認証、シート操作など          |

## 修正する時に必ず読むべき箇所
1. セッション検証とログイン処理 – index.html/login.html 内のセッション検証は現在 action=ping が機能していません。セッション無効時は早期に clearSession() してログイン画面へ誘導するよう改修する予定です。
2. データ送信の形式 – comm_payload.js のペイロード生成では URL エンコード方式を使用しています。parseFormPost_ が = や & を含む値を誤解析するため、JSON ベースの POST 形式へ移行する際は Code.gs 側の doPost を更新する必要があります。
3. 課題保存・提出ロジック – task_selection.js の saveToServer()/submitToServer()、および task_editor.js の saveTask() は GAS への送信経路です。Code.gs の saveUserCode_/saveTask_ と整合するよう必ず確認してください。
4. Pyodide Worker – py_worker.js は Matplotlib の描画やユーザー入力、実行停止処理を担当します。plt.show のパッチや <<<PLOT>>> マーカーに変更を入れる場合は runner.js の handleStdoutChunk() や runCode()/stopCode() と齟齬が出ないようにしてください。
5. スプレッドシート構造 – 列の順序を変更するとクライアントの正規化処理が失敗するため、既存列名を保持したまま新しい列を追加することを推奨します。

## GAS を触る前にテスト環境 ID に切り替える手順
1. テスト用スプレッドシートを用意 – 本番と同一構造のスプレッドシートをコピーし、テスト用 SPREADSHEET_ID として控えておきます。
2. Code.gs の切り替え – google_apps_script/Code.gs 先頭の SPREADSHEET_ID と SESSION_TTL_MINUTES をテスト用の値に書き換え、Apps Script エディタで保存後に新しい Web アプリとしてデプロイします。デプロイ URL を取得してください。
3. config.js の更新 – フロントエンドの config.js (ビルド済みの場合は public/config.js) の serverBaseUrl をテスト用 WebApp の URL に変更します。saveScript・submitScript・resultsPath を使って別 WebApp を呼び分けることもできます。
4. キャッシュクリア – ブラウザの localStorage に保存されている learn.snapshot.<server> やセッション情報はサーバー名に紐づいており、環境切り替え時に干渉しません。念のため学習画面でログアウトし、キャッシュをクリアしてください。
5. 動作確認 – 課題一覧の取得や課題保存がテストシートに反映されることを確認した上で開発を進めます。変更が本番環境に影響しないことを常に確認してください。

## HTML/JS/CSS の依存関係
- スタイル – style.css はすべての画面で共通のスタイルを提供します。レイアウト変更時は他の画面への影響を考慮してください。
- 設定ファイル – config.js は serverBaseUrl や GAS スクリプトのパスを定義します。複数環境に対応する場合はここを環境変数化することが推奨されます。
- ユーティリティ – comm_payload.js は GAS へのペイロード生成、sheet_io.js は課題・進捗データの API 呼び出しをラップします。依存度が高く、修正時は両者をセットで見直す必要があります。
- CodeMirror – main.html と task_editor.html では CDN から CodeMirror を読み込みます。バージョンアップ時はモードやアドオンの互換性を検証してください。
- Pyodide – Python 実行環境として Pyodide v0.22.1 を使用しています。CDN からの読み込みが必須であり、バージョン変更は py_worker.js と main.js 両方に影響します。

## 破壊しやすい関数と注意ポイント
| 関数/場所                                   | 注意事項                                                                |
| --------------------------------------- | ------------------------------------------------------------------- |
| `parseFormPost_` (Code.gs)              | 値に `=` や `&` を含む場合に誤解析するため、フォーム形式を変更する場合は必ず同時に修正する。                 |
| `saveTask_` / `saveUserCode_` (Code.gs) | 認証チェックが甘く、排他制御も無いためアクセス制限とトランザクション処理を検討する。                          |
| `runCode` と `stopCode` (runner.js)     | Worker と UI の同期を管理する重要な部分。修正時は入力要求・プロット出力・中断処理を総合的にテストする必要がある。      |
| `appendPlotDataUrl` (runner.js)         | 出力履歴に dataURI を保存していないため、修正時に既存のデータ形式との互換を確保する必要がある。                |
| `task_editor.js` の `saveTask`           | 保存失敗時にフォーム内容が失われる問題があり、修正時は入力の保持とエラーハンドリングを改善する必要がある。               |
| `config.js`                             | `serverBaseUrl` の変更は全ての API 呼び出しに影響する。テスト環境や本番環境の切り替え時にミスがないよう注意する。 |

## 将来拡張予定と改善案
- 認証・セッション – ping エンドポイントの修正や SESSION_TTL_MINUTES の適切な設定により、無効セッションを早期検知し記録肥大を防止します。また SALT とハッシュを POST で送信しログに残さない方式に変更します。
- API 拡張性 – doPost でも action パラメータを解析し、用途ごとのハンドラを分岐させます。ペイロードは JSON 形式に統一し、parseFormPost_ の問題を解決します。
- 排他制御とトランザクション – 課題保存やユーザーコード保存にロックを導入し、同時書き込みによるデータ競合を防ぎます。GAS の LockService を利用することを検討してください。
- グラフデータの保存 – appendPlotDataUrl() を改修して dataURI を output に含めることで、提出後に図を再現できるようにします。保存容量が増えるため、サイズ制限とエンコード方法を検討します。
- オフライン対応 – iFILTER 等で CDN が使えない環境向けに、Pyodide や CodeMirror をローカルにバンドルした配布パッケージを用意する計画があります。
- ユーザー体験向上 – ヒント開封・保存失敗時の通知や、課題エディタの入力保持機能を追加し、学習を妨げないように改善します。
- 課題管理の強化 – スプレッドシートに新しい列を追加する際にはバージョニング機構を導入し、クライアント側で列名を検証するよう改善します。
このガイドを参考に安全かつ効率的に開発を進め、教育現場での利用価値向上に寄与してください。
