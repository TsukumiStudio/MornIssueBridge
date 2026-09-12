import { admin } from './admin.js';

const MAX_REQUEST_BYTES = 3 * 1024 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 20_000;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const MAX_LABELS = 10;
const MAX_LABEL_LENGTH = 50;
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

export default {
  async fetch(request, env) {
    return handleRequest(request, env, fetch);
  },
};

/**
 * @param {Request} request
 * @param {Env & { GITHUB_TOKEN?: string }} env
 * @param {typeof fetch} githubFetch
 */
export async function handleRequest(request, env, githubFetch) {
  const path = new URL(request.url).pathname;
  if (path === "/admin" || path.startsWith("/admin/")) return admin(request, env);
  if (path !== "/") {
    return json({ error: "not found" }, 404);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "POST") {
    return json({ error: "POST してください" }, 405);
  }

  try {
    if (!env.GITHUB_TOKEN) {
      throw new HttpError(503, "サーバーの設定が未完了です");
    }
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await env.REPORT_LIMITER.limit({ key: ip });
    if (!success) {
      throw new HttpError(429, "しばらく待ってから送ってください");
    }

    const payload = await readPayload(request);
    if (!env.REPORTS_DB) throw new HttpError(503, "履歴データベースが未設定です");
    const id = crypto.randomUUID();
    try {
      await env.REPORTS_DB.prepare(`INSERT INTO reports
        (id, received_at, project, reporter_id, reporter_name, title, body, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'received')`).bind(
          id, new Date().toISOString(), payload.repository,
          payload.reporter_id, payload.reporter_name, payload.title, payload.body,
        ).run();
    } catch {
      throw new HttpError(503, "報告を保存できませんでした。時間をおいて送信してください");
    }
    let created;
    try {
      created = await createIssue(env, payload, githubFetch);
    } catch (error) {
      await env.REPORTS_DB.prepare("UPDATE reports SET status = 'failed', error = ? WHERE id = ?")
        .bind("GitHubへの起票が失敗しました。通信切断時は作成済みの場合があります。", id).run()
        .catch(() => console.error(JSON.stringify({ message: '履歴の結果更新に失敗', report_id: id })));
      throw error;
    }
    // 起票後のDB障害で失敗を返すと、利用者の再送によりIssueが重複する。
    // 受付済みのまま残し、管理画面では結果未確定として扱う。
    await env.REPORTS_DB.prepare("UPDATE reports SET status = 'created', issue_url = ?, issue_number = ? WHERE id = ?")
      .bind(created.html_url, created.number, id).run()
      .catch(() => console.error(JSON.stringify({ message: '履歴の結果更新に失敗', report_id: id, issue_number: created.number })));
    return json({ html_url: created.html_url, number: created.number }, 201);
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status);
    }
    console.error(JSON.stringify({
      message: "Issue bridge failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return json({ error: "Issue の作成に失敗しました" }, 502);
  }
}

/**
 * @param {Request} request
 * @returns {Promise<{ repository: string, title: string, body: string, labels: string[], reporter_id: string, reporter_name: string, screenshot?: string }>}
 */
async function readPayload(request) {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Content-Type は application/json にしてください");
  }

  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_REQUEST_BYTES)) {
    throw new HttpError(413, "大きすぎます");
  }

  const bytes = await readBytes(request, MAX_REQUEST_BYTES);
  let raw;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "JSON として読めません");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "JSON object を送ってください");
  }

  const repository = typeof raw.repository === "string" ? raw.repository.trim() : "";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(repository)
    || [".", ".."].includes(repository.split("/")[1])) {
    throw new HttpError(400, "repository は owner/repo 形式で指定してください");
  }
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const body = typeof raw.body === "string" ? raw.body : "";
  if (!title || title.length > MAX_TITLE_LENGTH || /[\r\n]/.test(title) || hasUnsafeControl(title)) {
    throw new HttpError(400, "title が不正です");
  }
  if (!body.trim() || body.length > MAX_BODY_LENGTH || hasUnsafeControl(body)) {
    throw new HttpError(400, "body が不正です");
  }

  const rawLabels = raw.labels ?? [];
  if (!Array.isArray(rawLabels) || rawLabels.length > MAX_LABELS) {
    throw new HttpError(400, "labels が不正です");
  }
  const labels = rawLabels.map((label) => typeof label === "string" ? label.trim() : "");
  if (labels.some((label) => !label || label.length > MAX_LABEL_LENGTH || hasUnsafeControl(label))) {
    throw new HttpError(400, "labels が不正です");
  }

  const screenshot = raw.screenshot_png_base64;
  if (screenshot !== undefined && !isPngBase64(screenshot)) {
    throw new HttpError(400, "screenshot_png_base64 が不正です");
  }
  const reporter = {};
  for (const field of ['reporter_id', 'reporter_name']) {
    const value = raw[field] ?? '';
    if (typeof value !== 'string' || value.length > 200 || /[\r\n]/.test(value) || hasUnsafeControl(value)) {
      throw new HttpError(400, `${field} が不正です`);
    }
    reporter[field] = value.trim();
  }
  return { repository, title, body, labels, ...reporter, ...(screenshot === undefined ? {} : { screenshot }) };
}

/** @param {Request} request @param {number} limit */
async function readBytes(request, limit) {
  if (!request.body) {
    throw new HttpError(400, "本文が空です");
  }
  const reader = request.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new HttpError(413, "大きすぎます");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * @param {Env & { GITHUB_TOKEN: string }} env
 * @param {{ repository: string, title: string, body: string, labels: string[], screenshot?: string }} payload
 * @param {typeof fetch} githubFetch
 */
async function createIssue(env, payload, githubFetch) {
  let body = payload.body;
  if (payload.screenshot) {
    try {
      const imageUrl = await uploadScreenshot(env, payload.screenshot);
      body = `![報告時の画面](${imageUrl})\n\n${body}`;
    } catch (error) {
      console.error(JSON.stringify({
        message: "screenshot upload failed",
        error: error instanceof Error ? error.message : String(error),
      }));
      body = `（画面の保存に失敗しました）\n\n${body}`;
    }
  }
  return githubRequest(
    githubFetch,
    env.GITHUB_TOKEN,
    `/repos/${payload.repository}/issues`,
    "POST",
    { title: payload.title, body, labels: payload.labels },
  );
}

/** @param {Env & { DROP?: Fetcher }} env @param {string} base64 */
async function uploadScreenshot(env, base64) {
  if (!env.DROP || !env.DROP_ORIGIN) throw new Error("画像保存先が未設定です");
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const response = await env.DROP.fetch(env.DROP_ORIGIN, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: bytes,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`画像保存先 ${response.status}: ${text.slice(0, 200)}`);
  }
  const uploaded = JSON.parse(text);
  if (typeof uploaded.url !== "string" || !uploaded.url.startsWith(`${env.DROP_ORIGIN}/`)) {
    throw new Error("画像保存先の応答が不正です");
  }
  return uploaded.url;
}

/**
 * @param {typeof fetch} githubFetch
 * @param {string} token
 * @param {string} path
 * @param {string} method
 * @param {unknown} [body]
 */
async function githubRequest(githubFetch, token, path, method, body) {
  const response = await githubFetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "MornIssueBridge",
      ...JSON_HEADERS,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub ${response.status}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

/** @param {unknown} value */
function isPngBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4) {
    return false;
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  try {
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    return bytes.length <= MAX_SCREENSHOT_BYTES
      && bytes.length >= 8
      && bytes.slice(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index]);
  } catch {
    return false;
  }
}

/** @param {string} value */
function hasUnsafeControl(value) {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** @param {unknown} value @param {number} status */
function json(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}
