import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admin, renderDashboard } from '../src/admin.js';
import { handleRequest } from '../src/index.js';
import { database } from './database.mjs';

test('管理画面はAccess設定なしで表示でき、HTTPメソッドとDB障害を処理します', async () => {
  const env = { REPORTS_DB: database() };
  const response = await handleRequest(new Request('https://example.test/admin'), env,
    () => assert.fail('履歴の表示でGitHubへ通信してはいけません'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.match(await response.text(), /送信履歴/);
  assert.equal((await admin(new Request('https://example.test/admin', { method: 'POST' }), env)).status, 405);
  assert.equal((await admin(new Request('https://example.test/admin'), {})).status, 503);
  const broken = { prepare() { throw Error('database unavailable'); } };
  assert.equal((await admin(new Request('https://example.test/admin'), { REPORTS_DB: broken })).status, 503);
});

test('投稿成功・失敗を保存し、DB障害時の重複投稿を防ぐ', async () => {
  const db = database();
  const e = { REPORTS_DB: db, GITHUB_TOKEN: 'test', REPORT_LIMITER: { limit: async () => ({ success: true }) } };
  const post = (extra = {}) => new Request('https://example.test/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '<script>alert(1)</script>', body: '詳細です', reporter_id: 'player-123', reporter_name: 'テストさん', repository: 'owner/repo', ...extra }) });
  const github = async (url) => {
    assert.equal(url, 'https://api.github.com/repos/owner/repo/issues');
    const rows = (await db.prepare('SELECT * FROM reports').bind().all()).results;
    assert.ok(rows.some(r => r.status === 'received'));
    return Response.json({ html_url: 'https://github.com/owner/repo/issues/1', number: 1 }, { status: 201 });
  };
  assert.equal((await handleRequest(post(), e, github)).status, 201);
  assert.equal((await handleRequest(post({ reporter_id: undefined, reporter_name: undefined }), e, async () => new Response('failed', { status: 500 }))).status, 502);
  const rows = (await db.prepare('SELECT * FROM reports ORDER BY received_at').bind().all()).results;
  assert.equal(rows[0].project, 'owner/repo');
  assert.equal(rows[0].reporter_id, 'player-123');
  assert.equal(rows[0].reporter_name, 'テストさん');
  assert.equal(rows[0].status, 'created');
  assert.equal(rows[1].status, 'failed');
  assert.equal(rows[1].reporter_id, '');
  assert.equal(rows[0].body, '詳細です');
  assert.ok(Number.isFinite(Date.parse(rows[0].received_at)));
  const noCall = async () => assert.fail('GitHubに到達してはいけない');
  assert.equal((await handleRequest(post({ reporter_id: {} }), e, noCall)).status, 400);
  assert.equal((await handleRequest(post(), { ...e, REPORTS_DB: undefined }, noCall)).status, 503);
  const broken = { prepare() { return { bind() { return { run: async () => { throw Error('database unavailable'); } }; } }; } };
  assert.equal((await handleRequest(post(), { ...e, REPORTS_DB: broken }, noCall)).status, 503);
  const failUpdate = { prepare(sql) { return sql.startsWith('UPDATE') ? broken.prepare(sql) : db.prepare(sql); } };
  assert.equal((await handleRequest(post(), { ...e, REPORTS_DB: failUpdate }, github)).status, 201);
  assert.ok((await db.prepare("SELECT * FROM reports WHERE status='received'").bind().all()).results.length === 1);
});

test('日本時間・検索・ページ送り・本文表示・HTMLエスケープ', async () => {
  const db = database();
  for (let i = 0; i < 51; i++) await db.prepare('INSERT INTO reports (id, received_at, project, reporter_id, reporter_name, title, body, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(String(i).padStart(3, '0'), '2026-09-08T02:15:00.000Z', 'owner/repo', 'player-123', '名前', '<script>x</script>', i === 0 ? '特別な本文' : '詳細本文', 'created').run();
  const html = await renderDashboard(new URL('https://example.test/admin'), db);
  assert.match(html, /2026\/09\/08 11:15:00/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /次の50件/);
  assert.match(html, /50件を表示/);
  assert.match(html, /player-123/);
  const search = await renderDashboard(new URL('https://example.test/admin?q=特別な本文'), db);
  assert.match(search, /1件を表示/);
  assert.match(search, /特別な本文/);
  const second = await renderDashboard(new URL('https://example.test/admin?before=2026-09-08T02:15:00.000Z&id=001'), db);
  assert.match(second, /1件を表示/);
  const empty = await renderDashboard(new URL('https://example.test/admin?q=%27%20OR%201%3D1--'), db);
  assert.match(empty, /0件を表示/);
});
