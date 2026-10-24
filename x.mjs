// X (Twitter) API v2 client — app-only (bearer token) search of recent posts.
// Reference: https://docs.x.com/x-api/posts/search/quickstart/recent-search
//
// Env:
//   X_BEARER_TOKEN   required; the app-only Bearer token from an app's
//                    "Keys & Tokens" page at console.x.com. Store it plain
//                    (no "Bearer " prefix, no trailing whitespace/newlines).
//                    It is returned URL-encoded (e.g. %2B = +, %3D = =) in some
//                    contexts — the value in .env below is already decoded.
//   X_BASE_URL       optional; default https://api.x.com
//   X_COUNT          posts per request, 1-100 (default 10)
//   X_CACHE_TTL      seconds to reuse an identical query (default 600; 0 disables)

import { loadEnv, ENV_PATHS } from './env.mjs';
await loadEnv();

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const BASE = process.env.X_BASE_URL || 'https://api.x.com';
const COUNT = clamp(Number(process.env.X_COUNT || 10), 1, 100);
const CACHE_TTL = Number(process.env.X_CACHE_TTL ?? 600);

export class XSearchError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.name = 'XSearchError';
    this.status = status;
  }
}

export function requireToken() {
  let tok = (process.env.X_BEARER_TOKEN || '').trim();
  // The console sometimes shows the token URL-encoded (%2B=+, %3D=, %2F=/). A real
  // base64 Bearer token never contains '%', so decode it if it does. This lets the
  // user paste either the decoded or the URL-encoded value.
  if (tok.includes('%')) tok = decodeURIComponent(tok);
  if (!tok) {
    throw new XSearchError(
      `X_BEARER_TOKEN is not set. Add the app-only Bearer token from console.x.com "Keys & Tokens" ` +
        `to ${ENV_PATHS[1]} (see ${ENV_PATHS[1]}.example). web_search (Brave) is still available.`,
      { status: 0 },
    );
  }
  return tok;
}

const cache = new Map();
function cacheGet(k) {
  if (!CACHE_TTL) return null;
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL * 1000) { cache.delete(k); return null; }
  return hit.results;
}
function cacheSet(k, results) {
  if (!CACHE_TTL) return;
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  cache.set(k, { at: Date.now(), results });
}

/**
 * One X "recent" post search. Returns normalized results: { title, url, snippet, age, engine }.
 * The recent endpoint covers the last 7 days and works with an app-only Bearer token.
 */
export async function xSearch({ query, count = COUNT } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new XSearchError('missing query', { status: 0 });
  const token = requireToken();

  const ck = `recent|${clamp(count, 1, 100)}|${q.toLowerCase()}`;
  const cached = cacheGet(ck);
  if (cached) return cached;

  const params = new URLSearchParams({
    query: q,
    max_results: String(clamp(count, 1, 100)),
    // Recent search returns public metrics + author_id; user fields come via expansions.
    'tweet.fields': 'created_at,author_id,public_metrics',
    'expansions': 'author_id',
    'user.fields': 'username',
  });

  const headers = { 'Authorization': `Bearer ${token}` };

  let res, body;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(`${BASE}/2/tweets/search/recent?${params}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429 && attempt === 0) { await Bun.sleep(2000); continue; } // one backoff, then surface it
    if (res.ok) { body = await res.json(); break; }
    throw describeFailure(res.status, await res.text().catch(() => ''));
  }

  const users = new Map((body?.includes?.users || []).map((u) => [u.id, u]));
  const results = (body?.data || []).map((t) => {
    const user = users.get(t.author_id) || {};
    const url = urlFor(t.id, user.username);
    if (!url) return null;
    const text = (t.text || '').replace(/\r/g, '\n').trim();
    if (!text && !t.id) return null;
    return {
      // Title = the post text itself; this is what the agent will cite / summarize.
      title: text.slice(0, 200) || `@${user.username || 'unknown'}`,
      url,
      // Snippet = provenance + engagement (who, when, how people reacted).
      snippet: `[x] @${user.username || 'unknown'} (${t.created_at}) ` +
        `👍${t.public_metrics?.like_count ?? 0} 💬${t.public_metrics?.reply_count ?? 0} ` +
        `↺${t.public_metrics?.retweet_count ?? 0} — ${url}`,
      age: t.created_at || null,
      engine: 'x',
    };
  }).filter(Boolean).slice(0, 100);

  // Empty results are not an error: X answered and found nothing, so the agent should
  // rephrase. (Recent only covers the last 7 days — older posts genuinely won't appear.)
  cacheSet(ck, results);
  return results;
}

function urlFor(id, username) {
  // Canonical public URL for a post.
  if (username) return `https://x.com/${username}/status/${id}`;
  return `https://x.com/i/status/${id}`;
}

function describeFailure(status, body) {
  const detail = String(body || '').slice(0, 200);
  switch (status) {
    case 401:
      return new XSearchError(
        `X API rejected the Bearer token (${status}: ${detail}). This usually means the app is in ` +
        `Development mode, the token is stale, or X's backend enrollment of a fresh app has not finished. ` +
        `web_search (Brave) is still available.`, { status });
    case 403:
      return new XSearchError(
        `X API rejected the app access (${status}: ${detail}). Check that the app is Production and ` +
        `bearer (app-only) auth is enabled; web_search (Brave) is still available.`, { status });
    case 402:
      return new XSearchError(
        `X API billing/quota exhausted (${status}: ${detail}). Add credits in the X developer console; ` +
        `web_search (Brave) is still available.`, { status });
    case 429:
      return new XSearchError(
        `X API rate limited (${status}). web_search (Brave) is still available; retry X later.`, { status });
    case 400:
      return new XSearchError(
        `X API rejected the query syntax (${status}: ${detail}). Rephrase the query or try web_search.`, { status });
    case 404:
      return new XSearchError(
        `X API endpoint not found (${status}: ${detail}). Check X_BASE_URL; try web_search.`, { status });
    default:
      if (status >= 500) return new XSearchError(
        `X API unavailable (${status}: ${detail}). web_search (Brave) is still available.`, { status });
      return new XSearchError(
        `X API error (${status}): ${detail}. web_search (Brave) is still available.`, { status });
  }
}

export const searchSource = () => 'X API v2 (recent search)';

if (import.meta.main) {
  const [q] = process.argv.slice(2);
  const out = await xSearch({ query: q || 'hello', count: 5 });
  console.log(`${out.length} results for: ${q}\n`);
  for (const r of out) console.log(`- [${r.age}] ${r.title}\n  ${r.url}\n`);
}
