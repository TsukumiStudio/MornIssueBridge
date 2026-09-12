# MornIssueBridge

HTTPで受け取った報告を、指定されたGitHubリポジトリのIssueとして作成するCloudflare Workerです。

[環境構築](#環境構築) · [送信方法](#送信方法) · [ライセンス](#ライセンス)

## 環境構築

Node.js 22.13以降、Cloudflareアカウント、投稿先への書き込み権限を持つGitHubトークンが必要です。

```sh
git clone https://github.com/TsukumiStudio/MornIssueBridge.git
cd MornIssueBridge
npm ci
npx wrangler d1 create morn-issue-reports
```

作成されたD1の `database_id` を `wrangler.jsonc` の `d1_databases` に追加します。
GitHubのfine-grained PATでは、投稿先のリポジトリを選び、`Issues: Read and write` を与えます。
ラベルを付ける場合は、トークン所有者にも対象リポジトリで必要な権限を与えます。

GitHubトークンは対話入力で登録します。

```sh
npx wrangler secret put GITHUB_TOKEN
npx wrangler d1 migrations apply morn-issue-reports --remote
npm run types
npm run check
npm run deploy
```

レート制限は送信元IPごとに適用し、既定の設定は60秒あたり5回です。

管理画面は `/admin` です。アクセス制限が必要な場合は、[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)で任意に設定します。
未設定の場合、投稿APIと送信履歴は公開されます。独自ドメインを保護する場合は、制限を迂回できる `workers.dev` 側の公開も無効にします。

画像を添える場合は、`wrangler.jsonc` に保存用Workerの `DROP` service bindingを追加し、`vars.DROP_ORIGIN` に画像の公開originを設定します。

```json
"services": [{ "binding": "DROP", "service": "your-image-storage-worker" }]
```

保存用Workerは `POST` でPNGの生バイト（`Content-Type: image/png`）を受け取り、2xxと `{"url":"https://images.example.com/shot.png"}` を返します。
URLは `DROP_ORIGIN + "/"` で始まる必要があります。originの末尾には `/` を付けません。

## 送信方法

デプロイしたWorkerの `POST /` へ、`Content-Type: application/json` を付けて送ります。
`repository` に送信先を指定します。投稿APIは認証なしで受け付けます。

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
| `repository` | はい | `owner/repo` 形式。GitHubトークンがIssueを作成できるリポジトリ |
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
| `413` / `415` | 要求サイズ超過 / Content-Typeが不正 |
| `429` | 送信頻度の制限超過 |
| `502` | GitHubへの起票に失敗 |
| `503` | サーバー設定の不足、または履歴の保存失敗 |

画像の保存に失敗した場合も、その旨を本文に添えてIssueを作成します。
通信切断時はGitHub側で作成済みの場合があるため、再送する前に `/admin` の送信履歴とGitHubを確認してください。

## ライセンス

[The Unlicense](LICENSE)を適用しています。
