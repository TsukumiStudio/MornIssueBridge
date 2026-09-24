# MornIssueBridge

JSONで送った報告を、指定したGitHubリポジトリのIssueにするCloudflare Workerです。

[環境構築](#環境構築) · [送信方法](#送信方法) · [ライセンス](#ライセンス)

## 環境構築

Node.js 22.13以降とCloudflareアカウントを用意します。

1. リポジトリを取得し、履歴保存用のD1を作成します。

   ```sh
   git clone https://github.com/TsukumiStudio/MornIssueBridge.git
   cd MornIssueBridge
   npm ci
   npx wrangler d1 create morn-issue-reports
   ```

2. 表示された `database_id` を `wrangler.jsonc` の `d1_databases` に追加します。GitHubのfine-grained PATを作成し、投稿先リポジトリの `Issues: Read and write` を許可します。

3. トークンを登録し、デプロイします。

   ```sh
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler d1 migrations apply morn-issue-reports --remote
   npm run check
   npm run deploy
   ```

<details>
<summary>任意設定：アクセス制限・画像添付</summary>

投稿APIと送信履歴（`/admin`）は、既定では公開されます。制限が必要な場合は[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)で設定します。独自ドメインだけを保護する場合は、`workers.dev` 側の公開も無効にします。

画像を添付する場合は、`wrangler.jsonc` の `vars.DROP_ORIGIN` に画像の公開origin（末尾の `/` なし）を設定し、保存用Workerを追加します。

```json
"services": [{ "binding": "DROP", "service": "your-image-storage-worker" }]
```

保存用WorkerはPNGの生バイトを `POST`（`Content-Type: image/png`）で受け取り、2xxと `{"url":"画像URL"}` を返します。画像URLは `DROP_ORIGIN + "/"` で始まる必要があります。保存に失敗しても、本文だけでIssueを作成します。

詳細レポートを分離する場合は、同じ保存先で `text/markdown` も受け付ける必要があります。MornDropは両方に対応します。下記の `report_markdown` がある報告は画像とMarkdownの保存完了後に起票し、どちらかが失敗したら503で返します。詳細を失ったままIssueを作成しません。

</details>

## 送信方法

デプロイ後のURLと `owner/repo` を置き換えて実行します。必須項目は `repository`・`title`・`body` の3つです。

```sh
curl 'https://YOUR-WORKER.workers.dev/' \
  -H 'Content-Type: application/json' \
  --data '{"repository":"owner/repo","title":"画面が進みません","body":"設定を保存すると画面が止まります。"}'
```

成功すると `201` とIssueのURLを返します。送信履歴は `/admin` で確認できます。

GMornIssueMaker 0.6.0は、`body` に「何が起きたか」だけ、`report_markdown` にタイトル・本文・環境・ゲームの状況・直前の操作を送ります。Bridgeは画像をMornDropへ保存し、そのURLを含むMarkdownレポートもMornDropへ保存します。Issue本文は `body` と `[詳細レポート](MornDropのURL)` だけになります。これによりIssue本文を転載するWebhook通知も短くなります。

`report_markdown` がない既存クライアントは従来の本文・画像添付を維持します。新しいGMornIssueMakerを配布する前に、このBridgeをデプロイしてください。履歴DBには詳細本文を残します。MornDropの通常ファイルは参照が30日途絶えると削除され、詳細レポートも同じ保持期間です。

```json
{"html_url":"https://github.com/owner/repo/issues/123","number":123}
```

<details>
<summary>送信項目・上限・エラー</summary>

| 項目 | 内容 |
| --- | --- |
| `repository`（必須） | `owner/repo` 形式。登録したGitHubトークンがIssueを作成できるリポジトリ |
| `title`（必須） | 空でない題名。200文字以内、改行不可 |
| `body`（必須） | 空でないMarkdown本文。20,000文字以内 |
| `report_markdown` | MornDropへ保存する空でない詳細Markdown。20,000文字以内。指定時は画像もこのレポートへ載せ、Issueには本文と詳細リンクだけを残す |
| `labels` | ラベル名の配列。10個まで、各50文字以内。付与にはGitHub側の権限が必要です |
| `reporter_id` / `reporter_name` | 送信者の自己申告値。各200文字以内、改行不可。省略時は匿名 |
| `screenshot_png_base64` | PNGのbase64文字列。デコード後2 MiB以内、data URLの接頭辞なし |

文字数はUTF-16コード単位で数えます。要求全体は3 MiBまで、送信頻度は既定でIPごとに60秒あたり5回です。

エラーは `{"error":"説明"}` で返します。

| ステータス | 原因 |
| --- | --- |
| `400` | 入力が不正です |
| `413` / `415` | サイズ超過、またはContent-Typeが不正です |
| `429` | 送信頻度の上限を超えています |
| `502` | GitHubへの起票に失敗しました |
| `503` | 設定不足、履歴の保存失敗、または詳細レポート・画像の保存失敗 |

通信切断時はIssueが作成済みの場合があります。再送前に送信履歴とGitHubを確認してください。

</details>

## ライセンス

[The Unlicense](LICENSE)を適用しています。
