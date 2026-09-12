# MornIssueBridge

HTTPで受け取った報告を、指定されたGitHubリポジトリのIssueとして作成するCloudflare Workerです。
任意のアプリやスクリプトからJSONで呼び出せます。専用SDKやゲームエンジンは不要です。
GitHubトークンはWorkerだけが持ち、受信内容と起票結果をD1（Cloudflareのデータベース）に保存します。

## リポジトリを指定して投稿するには

デプロイしたWorkerの `POST /` へ、`Content-Type: application/json` と `X-Morn-Token` を付けて送ります。
送信先は毎回 `repository` で指定します。既定の送信先はありません。

```json
{
  "repository": "owner/repo",
  "title": "画面が進まない",
  "body": "設定を保存した後、画面が進まなくなりました。",
  "labels": ["bug"],
  "reporter_id": "user-123",
  "reporter_name": "報告者名"
}
```

| フィールド | 必須 | 内容 |
| --- | --- | --- |
| `repository` | はい | `owner/repo` 形式。サーバーの許可一覧に含まれるリポジトリ |
| `title` | はい | 空でない題名。最大200文字、改行不可 |
| `body` | はい | 空でないMarkdown本文。最大20,000文字 |
| `labels` | いいえ | 最大10個、各50文字以内のラベル名 |
| `reporter_id` / `reporter_name` | いいえ | 各200文字以内、改行不可。省略時は匿名 |
| `screenshot_png_base64` | いいえ | PNGのbase64文字列。デコード後2 MiB以内。data URLの接頭辞は付けません |

文字数はJavaScriptの文字列長（UTF-16コード単位）で数えます。リクエスト全体の上限は3 MiBです。
送信者情報は自己申告値で、認証済みの本人情報ではありません。

成功時は `201` と作成したIssueのURL・番号を返します。

```json
{"html_url":"https://github.com/owner/repo/issues/123","number":123}
```

エラー時は `{"error":"説明"}` を返します。

| HTTPステータス | 意味 |
| --- | --- |
| `400` | 必須項目の不足や不正な入力 |
| `401` | 投稿トークンが不一致 |
| `403` | 許可一覧にないリポジトリ |
| `413` / `415` | 要求サイズ超過 / Content-Typeが不正 |
| `429` | 送信頻度の制限超過 |
| `502` | GitHubへの起票に失敗 |
| `503` | サーバー設定の不足、または履歴の保存失敗 |

## 自分の環境への配置手順

Node.js 22.13以降、Cloudflareアカウント、投稿先への書き込み権限を持つGitHubトークンが必要です。

```sh
git clone https://github.com/TsukumiStudio/MornIssueBridge.git
cd MornIssueBridge
npm ci
npx wrangler d1 create morn-issue-reports
```

作成されたD1の `database_id` を `wrangler.jsonc` の `d1_databases` に追加し、次を設定します。
このリポジトリの設定には、運用者個人のドメイン・メール・データベースIDを含めていません。

| 設定 | 用途 |
| --- | --- |
| `vars.ALLOWED_REPOSITORIES` | 許可する `owner/repo` をカンマ区切りで列挙します。例: `owner/app,team/tool`。大文字・小文字は区別せず、ワイルドカードは使いません。空なら投稿を拒否します |
| `ratelimits[].namespace_id` | 自分のアカウントで他用途と重ならないID |
| `vars.ADMIN_EMAIL` | 管理画面を使う人のメールアドレス |
| `vars.ACCESS_TEAM_DOMAIN` | Cloudflare Accessのチームドメイン（`example.cloudflareaccess.com`） |
| `vars.ACCESS_AUD` | 管理画面用AccessアプリのAudience値 |

GitHubのfine-grained PATには、許可一覧の対象リポジトリだけを選び、`Issues: Read and write` を与えます。
ラベルを付ける場合は、トークン所有者にも対象リポジトリで必要な権限を与えます。
必要な権限は[GitHubのIssue作成API](https://docs.github.com/en/rest/issues/issues#create-an-issue)で確認できます。

秘密値は対話入力で登録します。

```sh
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put SHARED_SECRET
npx wrangler d1 migrations apply morn-issue-reports --remote
npm run types
npm run check
npm run deploy
```

アプリは `SHARED_SECRET` と同じ値を `X-Morn-Token` に渡します。
公開アプリへ埋め込んだ値は取り出せるため、許可リポジトリとGitHubトークンの権限を必要な範囲に絞ります。
レート制限は送信元IPごとに適用し、既定の設定は60秒あたり5回です。

## 画像保存先の追加

本文だけなら画像保存サービスは不要です。画像を添える場合は、保存用Workerを `DROP` service bindingで接続し、
`vars.DROP_ORIGIN` に画像の公開originを設定します。特定の実装には依存しません。

`wrangler.jsonc` への追加例:

```json
"services": [{ "binding": "DROP", "service": "your-image-storage-worker" }]
```

保存用Workerは `DROP_ORIGIN` 宛ての `POST` でPNGの生バイト（`Content-Type: image/png`）を受け取り、
2xxと `{"url":"https://images.example.com/shot.png"}` を返します。
URLは `DROP_ORIGIN + "/"` で始まる必要があり、originの設定には末尾の `/` を付けません。
画像が保存できたら、Issue本文の先頭へ埋め込みます。
保存先が未設定、または画像保存が失敗した場合も、本文にその旨を添えてIssueを作ります。

## 管理画面で送信履歴を確認するには

管理画面はデプロイ先の `/admin` です。
Cloudflare Accessで `/admin` 以下を保護し、`ADMIN_EMAIL` と同じメールだけを許可します。
WorkerもJWTの署名・発行元・Audience・期限・メールを検証します。設定不足時は拒否します。
投稿用の `POST /` にはAccessログインを要求しません。

受信日時（日本時間、秒まで）、送信者、リポジトリ、題名・本文、起票結果、Issueリンクを表示します。
検索はリポジトリ・送信者・題名・本文が対象で、新しい順に50件ずつ表示します。
管理画面の「プロジェクト」欄とDBの `project` 列には、投稿で指定した `repository` を保存します。

D1へ報告を保存してからGitHubへ送信します。DBへの保存に失敗した場合は起票せず、503を返します。
起票に失敗した報告も履歴に残します。通信切断時はGitHub側で作成済みの場合があるため、自動再送しません。
起票後にDBの結果更新だけ失敗した場合は201を返し、履歴は「受付済み・結果未確定」として残します。
サーバーログの受付IDとIssue番号で照合します。

認証・入力検査・リポジトリ許可を通過した報告だけを記録します。
IPアドレスやトークンは履歴に保存しません。履歴の自動削除は行わず、画像は保存用Worker側で管理します。

## ローカルでの検証

```sh
npm ci
npm run types
npm run check
```

`check` はNode.jsのテストとWorkerのビルド確認（`wrangler deploy --dry-run`）を実行します。
GitHubと画像保存先への通信はモックし、実Issueを作りません。
リポジトリの振り分け・許可外の拒否・履歴保存・管理画面の認証と表示を検査します。

`npm run dev` でローカル起動できます。秘密値はGit管理外の `.dev.vars` に置きます。
D1をローカルで使う前に `npx wrangler d1 migrations apply morn-issue-reports --local` を実行します。
管理画面には開発用の認証バイパスを設けていません。

## ライセンス

Unlicense（パブリックドメイン相当）です。
