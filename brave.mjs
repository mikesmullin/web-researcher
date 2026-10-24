// Brave Search API client — this project's sole search source (replaced the SearXNG container).
// Reference: https://api-dashboard.search.brave.com/documentation/references/web-search-api
//
// Env:
//   BRAVE_API_KEY      required; from the environment or .env (Bun loads .env automatically)
//   BRAVE_BASE_URL     optional; default https://api.search.brave.com
//   BRAVE_COUNT        results per request, 1-20 (default 20)
//   BRAVE_COUNTRY      optional 2-letter country code (e.g. US)
//   BRAVE_SAFESEARCH   off | moderate | strict (default moderate)
//   BRAVE_CACHE_TTL    seconds to reuse an identical query (default 600; 0 disables)

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const BASE = process.env.BRAVE_BASE_URL || 'https://api.search.brave.com';
const COUNT = clamp(Number(process.env.BRAVE_COUNT || 20), 1, 20);
const COUNTRY = process.env.BRAVE_COUNTRY || '';
const SAFESEARCH = process.env.BRAVE_SAFESEARCH || 'moderate';
const CACHE_TTL = Number(process.env.BRAVE_CACHE_TTL ?? 600);

// Brave freshness codes.
const FRESHNESS = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };
// The agent's old SearXNG "categories" survive as a thin switch: news goes to Brave's news
// endpoint, everything else is the web index (Brave has no it/science verticals).
const NEWS_CATEGORIES = new Set(['news']);

export class BraveSearchError extends Error {
  /** true = the backend is unusable (quota/rate limit/bad key): the agent must stop, not retry. */
  constructor(message, { fatal = false, status = 0 } = {}) {
    super(message);
    this.name = 'BraveSearchError';
    this.fatal = fatal;
    this.status = status;
  }
}

export function requireKey() {
  const key = process.env.BRAVE_API_KEY;
  if (!key) {
    throw new BraveSearchError(
      'BRAVE_API_KEY is not set. Export it or add it to .env (see .env.example).',
      { fatal: true },
    );
  }
  return key;
}

const STOP = 'STOP: do not call more tools and do not write a findings report. Return a short message telling the user the web-search backend is unavailable and to retry later.';

function describeFailure(status, body) {
  const detail = String(body || '').slice(0, 300);
  // Brave reports bad-key / out-of-quota as 422 with a code in the body, not as 401/402.
  const code = /"code"\s*:\s*"([A-Z_]+)"/.exec(detail)?.[1] || '';
  if (/TOKEN_INVALID|SUBSCRIPTION|QUOTA|USAGE_LIMIT|RATE_LIMIT|PAST_QUOTA/i.test(code + ' ' + detail)) {
    return new BraveSearchError(`Brave Search API refused the request (${status}${code ? ' ' + code : ''}) — the key is invalid or the quota is spent. ${STOP}`, { fatal: true, status });
  }
  switch (status) {
    case 400:
    case 422:
      return new BraveSearchError(`Brave Search API rejected the query (${status}): ${detail}`);
    case 401:
    case 403:
      return new BraveSearchError(`Brave Search API rejected the key (${status}) — check BRAVE_API_KEY. ${STOP}`, { fatal: true, status });
    case 402:
      return new BraveSearchError(`Brave Search API quota/subscription exhausted (402). ${STOP}`, { fatal: true, status });
    case 429:
      return new BraveSearchError(`Brave Search API rate limited (429). ${STOP}`, { fatal: true, status });
    default:
      if (status >= 500) return new BraveSearchError(`Brave Search API unavailable (${status}). ${STOP}`, { fatal: true, status });
      return new BraveSearchError(`Brave Search API error (${status}): ${detail}`, { status });
  }
}

// Identical lookups inside one research run (and across runs) are cached: the agent often
// re-asks the same query, and every Brave request costs quota.
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
 * One Brave search. Returns normalized results: { title, url, snippet, age, engine }.
 * category: 'general' (default) | 'news' | any other label (falls back to the web index).
 * freshness: 'day' | 'week' | 'month' | 'year' | undefined.
 */
export async function braveSearch({ query, category = 'general', freshness, count = COUNT, offset = 0 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new BraveSearchError('missing query');
  const key = requireKey();

  const isNews = NEWS_CATEGORIES.has(String(category).toLowerCase());
  const path = isNews ? '/res/v1/news/search' : '/res/v1/web/search';
  const fresh = FRESHNESS[String(freshness || '').toLowerCase()] || '';
  const ck = `${path}|${fresh}|${offset}|${q.toLowerCase()}`;
  const cached = cacheGet(ck);
  if (cached) return cached;

  const params = new URLSearchParams({
    q,
    count: String(clamp(count, 1, 20)),
    offset: String(Math.max(0, offset)),
    textDecorations: 'false',
    safesearch: SAFESEARCH,
  });
  if (COUNTRY) params.set('country', COUNTRY);
  if (fresh) params.set('freshness', fresh);

  const headers = { 'X-Subscription-Token': key, Accept: 'application/json' };

  let res, body;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(`${BASE}${path}?${params}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429 && attempt === 0) { await Bun.sleep(1200); continue; } // one backoff, then surface it
    if (res.ok) { body = await res.json(); break; }
    throw describeFailure(res.status, await res.text().catch(() => ''));
  }

  // Web: { web: { results } }. News: results at the top level ({ type: "news", results }).
  const src = isNews ? (body?.results ? body : body?.news) : body?.web;
  const results = (src?.results || []).map((r) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: String(r.description || r.snippet || '').slice(0, 400),
    age: r.age || r.page_age || r.age_relative_to_display_date || null,
    engine: isNews ? 'brave news' : 'brave',
  })).filter((r) => r.url);

  // Empty results are not an error: Brave answered and found nothing, so the agent should rephrase.
  cacheSet(ck, results);
  return results;
}

export const searchSource = () => 'Brave Search API';

if (import.meta.main) {
  const [q, ...rest] = process.argv.slice(2);
  const out = await braveSearch({ query: q || 'What is the Brave Search API?', category: rest[0] || 'general', freshness: rest[1] });
  console.log(`${out.length} results for: ${q}\n`);
  for (const r of out) console.log(`- ${r.title}\n  ${r.url}${r.age ? ` (${r.age})` : ''}\n`);
}
