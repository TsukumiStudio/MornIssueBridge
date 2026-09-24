import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRequest } from "../src/index.js";

import { database } from './database.mjs';

const ENV = {
  REPORTS_DB: database(),
  GITHUB_TOKEN: "github-token",
  DROP_ORIGIN: "https://drop.example.test",
  DROP: { fetch: async () => assert.fail("画像が無い報告では画像保存先へ到達してはいけない") },
  REPORT_LIMITER: { limit: async () => ({ success: true }) },
};

function request(body, options = {}) {
  const payload = JSON.stringify({ repository: "owner/repo", ...body });
  const headers = new Headers({
    "Content-Type": "application/json",
    "Content-Length": String(new TextEncoder().encode(payload).length),
  });
  if (options.contentLength) headers.set("Content-Length", String(options.contentLength));
  return new Request("https://example.test/", { method: "POST", headers, body: payload });
}

test("入力境界で不正な報告を拒否する", async () => {
  const unusedFetch = async () => assert.fail("GitHubへ到達してはいけない");

  const oversized = await handleRequest(
    request({ title: "報告", body: "詳細" }, { contentLength: 4 * 1024 * 1024 }),
    ENV,
    unusedFetch,
  );
  assert.equal(oversized.status, 413);

  const empty = await handleRequest(request({ title: "報告", body: "" }), ENV, unusedFetch);
  assert.equal(empty.status, 400);

  const badLabels = await handleRequest(
    request({ title: "報告", body: "詳細", labels: ["bug", 1] }),
    ENV,
    unusedFetch,
  );
  assert.equal(badLabels.status, 400);

  const notPng = await handleRequest(
    request({ title: "報告", body: "詳細", screenshot_png_base64: btoa("not png") }),
    ENV,
    unusedFetch,
  );
  assert.equal(notPng.status, 400);
});

test("画像を置き場へ上げてIssueを作る", async () => {
  const env = {
    ...ENV,
    DROP: {
      fetch: async (url, init) => {
        assert.equal(url, "https://drop.example.test");
        assert.equal(init.method, "POST");
        assert.equal(init.headers["Content-Type"], "image/png");
        assert.deepEqual([...init.body.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        return Response.json({ url: "https://drop.example.test/shot.png" }, { status: 201 });
      },
    },
  };
  const github = async (url, init) => {
    assert.equal(url, "https://api.github.com/repos/owner/repo/issues");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), {
      title: "報告",
      body: "![報告時の画面](https://drop.example.test/shot.png)\n\n詳細",
      labels: ["bug", "app-report"],
    });
    return Response.json({ html_url: "https://github.com/owner/repo/issues/9", number: 9 }, { status: 201 });
  };

  const response = await handleRequest(request({
    title: "報告",
    body: "詳細",
    labels: ["bug", "app-report"],
    screenshot_png_base64: "iVBORw0KGgo=",
  }), env, github);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    html_url: "https://github.com/owner/repo/issues/9",
    number: 9,
  });
});

test("画像の保存に失敗しても本文だけでIssueを作る", async () => {
  const env = {
    ...ENV,
    DROP: { fetch: async () => new Response("failed", { status: 500 }) },
  };
  const github = async (_url, init) => {
    assert.match(JSON.parse(init.body).body, /^（画面の保存に失敗しました）/);
    return Response.json({ html_url: "https://github.com/owner/repo/issues/10", number: 10 }, { status: 201 });
  };
  const response = await handleRequest(request({
    title: "報告",
    body: "詳細",
    screenshot_png_base64: "iVBORw0KGgo=",
  }), env, github);
  assert.equal(response.status, 201);
});

test("詳細と画像はMornDropへ置き、Issueには要点とリンクだけを載せる", async () => {
  for (const withImage of [true, false]) {
    const db = database();
    const summary = "## 何が起きたか\n\n購入すると止まる";
    const report = "# 報告\n\n" + summary + "\n\n## 環境\n\n| OS | macOS |\n\n## 直前の出来事\n\n- 購入";
    const uploads = [];
    const env = { ...ENV, REPORTS_DB: db, DROP: { fetch: async (url, init) => {
      assert.equal(url, ENV.DROP_ORIGIN);
      assert.equal(init.method, "POST");
      uploads.push(init);
      if (init.headers["Content-Type"] === "image/png") {
        assert.ok(withImage);
        return Response.json({ url: `${url}/shot.png` }, { status: 201 });
      }
      assert.equal(init.headers["Content-Type"], "text/markdown; charset=utf-8");
      assert.equal(init.body, withImage ? `![報告時の画面](${url}/shot.png)\n\n${report}` : report);
      return Response.json({ url: `${url}/report.md` }, { status: 201 });
    } } };
    const response = await handleRequest(request({
      title: "報告", body: summary, report_markdown: report,
      ...(withImage ? { screenshot_png_base64: "iVBORw0KGgo=" } : {}),
    }), env, async (_url, init) => {
      assert.equal(uploads.length, withImage ? 2 : 1, "詳細を保存する前に起票している");
      assert.deepEqual(JSON.parse(init.body), {
        title: "報告", body: `${summary}\n\n[詳細レポート](${ENV.DROP_ORIGIN}/report.md)`, labels: [],
      });
      return Response.json({ html_url: "https://github.com/owner/repo/issues/9", number: 9 }, { status: 201 });
    });
    assert.equal(response.status, 201);
    const rows = (await db.prepare("SELECT body, status FROM reports").bind().all()).results;
    assert.equal(rows[0].body, report, "詳細を履歴から失っている");
    assert.equal(rows[0].status, "created");
  }
});

test("詳細レポートの型・空欄・長さ・制御文字を外部通信前に検査する", async () => {
  const unused = async () => assert.fail("不正なレポートを送信してはいけない");
  for (const report_markdown of [null, 1, {}, "", "  ", "a".repeat(20_001), "詳細\u0000"]) {
    const response = await handleRequest(request({ title: "報告", body: "要点", report_markdown }), ENV, unused);
    assert.equal(response.status, 400);
  }
});

test("詳細か画像の保存に失敗したら、詳細抜きのIssueを作らない", async () => {
  const unused = async () => assert.fail("MornDrop保存失敗後に起票してはいけない");
  for (const withImage of [true, false]) {
    for (const failure of ["unconfigured", "500", "invalid-url", "invalid-json"]) {
      const env = { ...ENV, REPORTS_DB: database(), DROP: failure === "unconfigured" ? undefined : {
        fetch: async () => failure === "500" ? new Response("failed", { status: 500 })
          : failure === "invalid-json" ? new Response("not-json")
          : Response.json({ url: "https://other.example.test/report.md" }),
      } };
      const response = await handleRequest(request({ title: "報告", body: "要点", report_markdown: "詳細を残す",
        ...(withImage ? { screenshot_png_base64: "iVBORw0KGgo=" } : {}),
      }), env, unused);
      assert.equal(response.status, 503);
      const rows = (await env.REPORTS_DB.prepare("SELECT body, status FROM reports").bind().all()).results;
      assert.equal(rows[0].status, "failed");
      assert.equal(rows[0].body, "詳細を残す");
    }
  }
});

test("Cloudflareのレート制限を超えたらGitHubへ到達しない", async () => {
  const env = { ...ENV, REPORT_LIMITER: { limit: async () => ({ success: false }) } };
  const response = await handleRequest(
    request({ title: "報告", body: "詳細" }),
    env,
    async () => assert.fail("GitHubへ到達してはいけない"),
  );
  assert.equal(response.status, 429);
});

test("投稿用の認証情報なしで指定先へ起票し、送信先を履歴に保存する", async () => {
  const db = database();
  const env = { ...ENV, REPORTS_DB: db };
  for (const repository of ['owner/repo', 'team/another']) {
    const response = await handleRequest(request({ repository, title: '報告', body: '詳細' }), env,
      async (url) => {
        assert.equal(url, `https://api.github.com/repos/${repository}/issues`);
        return Response.json({ html_url: `https://github.com/${repository}/issues/1`, number: 1 }, { status: 201 });
      });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).html_url, `https://github.com/${repository}/issues/1`);
  }
  const rows = (await db.prepare('SELECT project, status FROM reports ORDER BY project').bind().all()).results;
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { project: 'owner/repo', status: 'created' },
    { project: 'team/another', status: 'created' },
  ]);
});

test("リポジトリの省略・不正形式は外部通信と履歴保存の前に拒否する", async () => {
  const unused = () => assert.fail('拒否した報告を処理してはいけない');
  const env = { ...ENV, REPORTS_DB: { prepare: unused } };
  for (const repository of [undefined, null, 1, {}, '', 'repo', 'owner/repo/extra', '../repo',
    'owner/..', 'owner/.', 'owner/repo?x=1', 'owner/repo#x', 'owner/%2e%2e', 'owner\\repo',
    'owner/repo\nextra', 'owner/' + 'a'.repeat(101), 'a'.repeat(40) + '/repo', 'https://github.com/owner/repo']) {
    const response = await handleRequest(request({ repository, title: '報告', body: '詳細' }), env, unused);
    assert.equal(response.status, 400, `不正なrepository: ${JSON.stringify(repository)}`);
  }
});

test("画像保存先が未設定でも本文を起票でき、CORSで投稿用ヘッダーを許可する", async () => {
  const response = await handleRequest(request({ title: '報告', body: '詳細', screenshot_png_base64: 'iVBORw0KGgo=' }),
    { ...ENV, DROP: undefined, DROP_ORIGIN: '' }, async (_url, init) => {
      assert.match(JSON.parse(init.body).body, /^（画面の保存に失敗しました）/);
      return Response.json({ html_url: 'https://github.com/owner/repo/issues/1', number: 1 }, { status: 201 });
    });
  assert.equal(response.status, 201);
  const preflight = await handleRequest(new Request('https://example.test/', { method: 'OPTIONS' }), ENV,
    () => assert.fail('CORSの確認で外部通信してはいけない'));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
});
