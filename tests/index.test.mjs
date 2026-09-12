import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRequest } from "../src/index.js";

import { database } from './database.mjs';

const ENV = {
  REPORTS_DB: database(),
  GITHUB_TOKEN: "github-token",
  ALLOWED_REPOSITORIES: "owner/repo, team/another",
  SHARED_SECRET: "shared-secret",
  DROP_ORIGIN: "https://drop.example.test",
  DROP: { fetch: async () => assert.fail("画像が無い報告では画像保存先へ到達してはいけない") },
  REPORT_LIMITER: { limit: async () => ({ success: true }) },
};

function request(body, options = {}) {
  const payload = JSON.stringify({ repository: "owner/repo", ...body });
  const headers = new Headers({
    "Content-Type": "application/json",
    "Content-Length": String(new TextEncoder().encode(payload).length),
    "X-Morn-Token": options.token ?? "shared-secret",
  });
  if (options.contentLength) headers.set("Content-Length", String(options.contentLength));
  return new Request("https://example.test/", { method: "POST", headers, body: payload });
}

test("入力境界で不正な報告を拒否する", async () => {
  const unusedFetch = async () => assert.fail("GitHubへ到達してはいけない");

  const unauthorized = await handleRequest(
    request({ title: "報告", body: "詳細" }, { token: "wrong" }),
    ENV,
    unusedFetch,
  );
  assert.equal(unauthorized.status, 401);

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

test("Cloudflareのレート制限を超えたらGitHubへ到達しない", async () => {
  const env = { ...ENV, REPORT_LIMITER: { limit: async () => ({ success: false }) } };
  const response = await handleRequest(
    request({ title: "報告", body: "詳細" }),
    env,
    async () => assert.fail("GitHubへ到達してはいけない"),
  );
  assert.equal(response.status, 429);
});

test("指定したリポジトリへ起票し、同じ送信先を履歴に保存する", async () => {
  const db = database();
  const env = { ...ENV, REPORTS_DB: db, ALLOWED_REPOSITORIES: ' owner/repo, TEAM/ANOTHER ' };
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

test("リポジトリの省略・不正形式・許可外は外部通信と履歴保存の前に拒否する", async () => {
  const unused = () => assert.fail('拒否した報告を処理してはいけない');
  const env = { ...ENV, REPORTS_DB: { prepare: unused } };
  for (const repository of [undefined, null, 1, {}, '', 'repo', 'owner/repo/extra', '../repo',
    'owner/..', 'owner/.', 'owner/repo?x=1', 'owner/repo#x', 'owner/%2e%2e', 'owner\\repo',
    'owner/repo\nextra', 'owner/' + 'a'.repeat(101), 'a'.repeat(40) + '/repo', 'https://github.com/owner/repo']) {
    const response = await handleRequest(request({ repository, title: '報告', body: '詳細' }), env, unused);
    assert.equal(response.status, 400, `不正なrepository: ${JSON.stringify(repository)}`);
  }
  for (const repository of ['other/repo', 'owner/repo-extra', 'other/another']) {
    const response = await handleRequest(request({ repository, title: '報告', body: '詳細', screenshot_png_base64: 'iVBORw0KGgo=' }), env, unused);
    assert.equal(response.status, 403);
  }
  for (const allowed of [undefined, '', ' , ']) {
    const response = await handleRequest(request({ title: '報告', body: '詳細' }), { ...env, ALLOWED_REPOSITORIES: allowed }, unused);
    assert.equal(response.status, 503);
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
  assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Content-Type, X-Morn-Token');
});
