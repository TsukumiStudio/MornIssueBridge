import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';
import { admin, renderDashboard } from '../src/admin.js';
import { handleRequest } from '../src/index.js';
import { database } from './database.mjs';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'test', alg: 'RS256' }] });
const ADMIN_EMAIL = 'admin@example.test';
const env = { ADMIN_EMAIL, ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com', ACCESS_AUD: 'admin-test', REPORTS_DB: database() };
async function signed(overrides = {}) {
  return new SignJWT({ email: ADMIN_EMAIL, sub: 'user', iss: 'https://test.cloudflareaccess.com', aud: 'admin-test', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+60, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(privateKey);
}
function request(token) { return new Request('https://example.test/admin', { headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {} }); }

test('管理画面は署名・発行元・宛先・有効期限・メールを全て照合する', async () => {
  assert.equal((await admin(request(await signed()), env, keys)).status, 200);
  for (const claims of [{ email: 'other@example.com' }, { aud: 'other' }, { iss: 'https://evil.test' }, { exp: 1 }, { nbf: 9999999999 }, { exp: undefined }]) {
    assert.equal((await admin(request(await signed(claims)), env, keys)).status, 403);
  }
  assert.equal((await admin(request(await signed()), { ...env, ADMIN_EMAIL: '' }, keys)).status, 403);
  assert.equal((await admin(request(await signed({ email: 'new@example.test' })), { ...env, ADMIN_EMAIL: 'new@example.test' }, keys)).status, 200);
  const token = await signed();
  const parts = token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ email: ADMIN_EMAIL })).toString('base64url');
  assert.equal((await admin(request(parts.join('.')), env, keys)).status, 403);
  assert.equal((await admin(request(), env, keys)).status, 403);
  assert.equal((await admin(request(token), { ...env, ACCESS_AUD: '' }, keys)).status, 403);
  const spoofed = new Request('https://example.test/admin', { headers: { 'Cf-Access-Authenticated-User-Email': ADMIN_EMAIL } });
  assert.equal((await admin(spoofed, env, keys)).status, 403);
  const response = await admin(request(token), env, keys);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.match(await response.text(), /admin@example\.test/);
});

test('投稿成功・失敗を保存し、DB障害時の重複投稿を防ぐ', async () => {
  const db = database();
  const e = { REPORTS_DB: db, GITHUB_TOKEN: 'test', SHARED_SECRET: 'test', ALLOWED_REPOSITORIES: 'owner/repo', REPORT_LIMITER: { limit: async () => ({ success: true }) } };
  const post = (extra = {}) => new Request('https://example.test/', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Morn-Token': 'test' }, body: JSON.stringify({ title: '<script>alert(1)</script>', body: '詳細です', reporter_id: 'player-123', reporter_name: 'テストさん', repository: 'owner/repo', ...extra }) });
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
