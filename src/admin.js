import { createRemoteJWKSet, jwtVerify } from 'jose';

const keySets = new Map();
const headers = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export async function verifyAdmin(request, env, keys) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ADMIN_EMAIL) return false;
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return false;
  try {
    if (!keys) {
      if (!keySets.has(issuer)) keySets.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)));
      keys = keySets.get(issuer);
    }
    const { payload } = await jwtVerify(token, keys, {
      issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'email', 'sub'],
    });
    return payload.email === env.ADMIN_EMAIL;
  } catch {
    return false;
  }
}

export async function admin(request, env, keys) {
  if (!await verifyAdmin(request, env, keys)) return new Response('管理画面へのアクセス権がありません。', { status: 403, headers });
  if (request.method !== 'GET') return new Response('GET のみ利用できます。', { status: 405, headers });
  if (!env.REPORTS_DB) return new Response('履歴データベースが未設定です。', { status: 503, headers });
  try {
    return new Response(await renderDashboard(new URL(request.url), env.REPORTS_DB, env.ADMIN_EMAIL), { headers });
  } catch {
    return new Response('履歴を読み込めませんでした。時間をおいて再読み込みしてください。', { status: 503, headers });
  }
}

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const date = (value) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
const statuses = { received: '受付済み・結果未確定', created: '起票済み', failed: '起票失敗' };

export async function renderDashboard(url, db, adminEmail = '') {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
  const cursor = url.searchParams.get('before') || '';
  const beforeId = url.searchParams.get('id') || '';
  const filters = [], args = [];
  if (q) {
    filters.push("(instr(project, ?) OR instr(reporter_id, ?) OR instr(reporter_name, ?) OR instr(title, ?) OR instr(body, ?))");
    args.push(q, q, q, q, q);
  }
  if (cursor) {
    filters.push('(received_at < ? OR (received_at = ? AND id < ?))');
    args.push(cursor, cursor, beforeId);
  }
  const { results } = await db.prepare(`SELECT * FROM reports ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''} ORDER BY received_at DESC, id DESC LIMIT 51`).bind(...args).all();
  const rows = results.slice(0, 50);
  const next = results.length > 50 ? new URLSearchParams({ q, before: rows.at(-1).received_at, id: rows.at(-1).id }) : null;
  const items = rows.map((r) => {
    const validLink = typeof r.issue_url === 'string' && r.issue_url.startsWith(`https://github.com/${r.project}/issues/`) && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/.test(r.issue_url);
    return `<tr><td class="time">${escape(date(r.received_at))}</td><td><strong>${escape(r.reporter_name || r.reporter_id || '匿名')}</strong>${r.reporter_id && r.reporter_name ? `<small>${escape(r.reporter_id)}</small>` : ''}${r.reporter_id || r.reporter_name ? '<small>送信データの申告値</small>' : ''}</td><td>${escape(r.project)}</td><td class="content"><details><summary>${escape(r.title)}</summary><pre>${escape(r.body)}</pre><small>受付ID: ${escape(r.id)}</small></details></td><td><span class="status ${escape(r.status)}">${escape(statuses[r.status] || '不明')}</span>${validLink ? `<a href="${escape(r.issue_url)}" target="_blank" rel="noopener noreferrer">Issue #${escape(r.issue_number)} ↗</a>` : ''}${r.error ? `<small>${escape(r.error)}</small>` : ''}</td></tr>`;
  }).join('');
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>送信履歴 | MornIssueBridge</title><style>
:root{--edge:32px;--panel:24px;--gap:12px;--section:48px;color-scheme:light;font-family:system-ui,sans-serif;color:#192b3b;background:#f3f6f9}*{box-sizing:border-box}body{margin:0;padding:var(--edge)}main{max-width:1500px;margin:auto}header{display:flex;align-items:center;justify-content:space-between;gap:var(--gap);margin-bottom:var(--section)}h1{font-size:30px;margin:8px 0}p,small{color:#506174}small{display:block;margin-top:8px;font-size:12px;overflow-wrap:anywhere}a{color:#19569d}a:hover{color:#10355e}form{display:flex;gap:var(--gap);align-items:end;margin:var(--panel) 0}label{flex:1}input{display:block;width:100%;margin-top:8px;border:1px solid #9eafbf;border-radius:8px;padding:12px;font:inherit}button,.nav{padding:12px 20px;border-radius:8px;background:#234e78;color:white;border:0;font:inherit;cursor:pointer;text-decoration:none}button:hover,.nav:hover{background:#193957;color:white}a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #a66e00;outline-offset:3px}.table{background:white;border:1px solid #d4dde5;border-radius:12px;overflow:auto}table{width:100%;border-collapse:collapse;min-width:850px;text-align:left}th,td{padding:var(--panel);border-bottom:1px solid #e4eaf0;vertical-align:top}th{background:#eaf0f5;font-size:13px;color:#46586c}td{font-size:14px;overflow-wrap:anywhere}td.time{white-space:nowrap;font-variant-numeric:tabular-nums}.content{width:38%}summary{cursor:pointer;font-weight:600;line-height:1.7}summary:hover{color:#19569d}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.8;background:#f4f7fa;padding:var(--panel);border-radius:8px}.status{display:block;font-weight:600;margin-bottom:8px}.created{color:#17613e}.failed{color:#a52b32}.received{color:#715100}footer{display:flex;justify-content:space-between;gap:var(--gap);margin-top:var(--panel)}.empty{padding:var(--section);text-align:center}.brand{font-weight:700;letter-spacing:.05em;color:#345d83}@media(max-width:640px){:root{--edge:16px;--panel:16px}header,form{align-items:stretch;flex-direction:column}header{margin-bottom:24px}h1{font-size:26px}}
</style><main><header><div><div class="brand">MornIssueBridge</div><h1>送信履歴</h1><p>アプリから届いた報告と、Issue の作成結果。</p></div><div><small>管理者</small>${escape(adminEmail)}<small>日時は日本時間（JST）</small></div></header><form action="/admin" method="get"><label>プロジェクト・送信者・報告内容で検索<input type="search" name="q" value="${escape(q)}" placeholder="検索キーワード"></label><button type="submit">検索</button><a href="/admin">リセット</a></form><div class="table"><table><thead><tr><th>受信日時</th><th>送信者</th><th>プロジェクト</th><th>報告内容（クリックで詳細）</th><th>起票結果</th></tr></thead><tbody>${items}</tbody></table>${rows.length ? '' : `<div class="empty">${q ? '条件に一致する報告はありません。' : 'まだ報告はありません。新しく受信した報告がここに表示されます。'}</div>`}</div><footer><span>${rows.length}件を表示 · 新しい順</span>${next ? `<a class="nav" href="/admin?${escape(next)}">次の50件 →</a>` : ''}</footer></main></html>`;
}
