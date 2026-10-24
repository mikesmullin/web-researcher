# Deep Search

Agentic web research prototype: ask a question, an agent searches the web (Brave Search API) **and
X/Twitter (X API v2 recent posts)**, reads sources and writes one cited Markdown report. The LLM runs
on your machine; search calls go to both APIs.

## How it looks

**1. Ask** — type a question or pick an example. Past searches live in the history sidebar.

![Ask](docs/1-ask.png)

**2. Research** — watch the agent search and read sources live; sources fill in on the right.

![Researching](docs/2-researching.png)

**3. Report** — one cited Markdown report, with tables and clickable `[n]` citations.

![Report](docs/3-report.png)

**4. Follow up** — keep asking in the same session; each turn builds on the earlier findings.

![Follow-up](docs/4-followup.png)

## Search history

History is stored **in each user's browser** (`localStorage`, one Markdown document per session under the key
`ds:s:<id>`), never on the server — so it is private per browser/user and the service is stateless
(follow-ups send the previous turns along with the question). Each document has YAML frontmatter with the
metadata (id, title, timestamps, model, counts, questions), then each turn (question, research trail, report),
then a **Citations** appendix listing every source (read vs. only found).

- Sessions are deep-linkable (`#<id>`), survive reloads, and can be deleted from the sidebar (trash icon).
- `localStorage` is per origin: `localhost:2340`, `host:1234/search/` etc. each have their own history.
- Clearing site data removes it; the **Copy** button exports a whole thread as Markdown.
- If browser storage is full or blocked, the UI says so and the session just won't appear in history.

## Parts

- `agent.mjs` — [agl-ai](https://github.com/mikesmullin/agl) agent (`llama-server:default` on :1234) + `web_search` / `x_search` / `fetch_page` tools
- `brave.mjs` — Brave Search API client: web + news endpoints, freshness, result normalization, error
  → "degrade to the other source" signal, and a small query cache so repeated lookups don't burn quota
- `x.mjs` — X (Twitter) API v2 client: app-only Bearer auth, `/2/tweets/search/recent` (last 7 days,
  `tweet.fields`/`expansions`), result normalization, error → "degrade to the other source" signal, cache
- `env.mjs` — shared `.env` loader so callers outside this repo (e.g. MCP clients) still find the keys
- `server.mjs` — stateless Bun server; `POST /api/research` streams progress over SSE
- `mcp.mjs` — MCP stdio server exposing the researcher as a `search` tool (query → cited Markdown report)
- `public/store.mjs` — session persistence in the browser (Markdown + YAML frontmatter in `localStorage`)
- `public/` — dark, responsive, [Phosphor](https://phosphoricons.com)-iconed [m-js](https://github.com/mikesmullin/m-js) UI (`app.mjs`, `md.mjs`, `style.css`)

## Run

    cp .env.example .env                   # Brave Search API key + X API Bearer token in .env
    bun install                            # Phosphor icons
    bun link agl-ai m-js                   # local fs libs (bun link in each repo first)
    bun server.mjs                         # UI on 127.0.0.1:2340
    bun agent.mjs "your question"          # or CLI

Env (from the environment or `.env`, which Bun loads automatically): `BRAVE_API_KEY` (required),
`X_BEARER_TOKEN` (required for X search; app-only token from console.x.com, stored **decoded**),
`LLM_MODEL` (default `llama-server:default`), `MAX_TOOL_CALLS`, `MAX_TURNS`, `PORT` (2340), `HOST` (127.0.0.1),
and the search knobs `BRAVE_COUNT` (20), `BRAVE_SAFESEARCH` (`moderate`), `BRAVE_COUNTRY`,
`BRAVE_CACHE_TTL` (600s), `BRAVE_BASE_URL`, `X_BASE_URL` (https://api.x.com), `X_COUNT` (10),
`X_CACHE_TTL` (600s).

## Search backends

Search is **two independent sources**:

1. **Brave Search API** (`/res/v1/web/search`, plus `/res/v1/news/search` for `categories: news`).
   Get a key at <https://api-dashboard.search.brave.com>.
2. **X (Twitter) API v2** — app-only Bearer auth, `GET /2/tweets/search/recent` (public posts,
   **last 7 days only**; `max_results` 1–100, `tweet.fields`/`expansions` to include author + metrics).
   Get the Bearer token at <https://console.x.com> → your app → **Keys & Tokens** → "app-only
   authentication → Bearer token". Note: the token often shows up URL-encoded in the console; store
   the decoded value in `X_BEARER_TOKEN`. X apps are created in **Development** mode and can't
   authenticate until moved to **Production** (and fresh Pay-Per-Use apps can need a few minutes of
   backend enrollment) — that's a common cause of 401s.

Both keys live in `.env` (gitignored). `.env` is read from this repo's directory regardless of the
caller's working directory, so MCP clients that launch `bun /path/to/web-researcher/mcp.mjs` from
their own workspace still get the keys (a real environment variable always wins). Every request costs
quota, so identical queries are cached. If one backend fails the agent **degrades to the other** and
only reports "backend unavailable" if both fail. Add more sources by following the same
`brave.mjs` / `x.mjs` pattern and adding an agent `Tool`.

## MCP tool (for agents)

`mcp.mjs` is a zero-dependency MCP stdio server exposing one tool:

- `search({ query })` — runs the agent and returns the final cited report as a single
  Markdown text block. `prompt` is accepted as an alias for `query`.

```json
{ "mcpServers": { "web-researcher": { "command": "bun", "args": ["/path/to/web-researcher/mcp.mjs"] } } }
```

Run it directly with `bun mcp.mjs`. Progress and errors go to stderr; stdout carries only
JSON-RPC. Same research env vars apply (`BRAVE_API_KEY`, `LLM_MODEL`, `MAX_TOOL_CALLS`, `MAX_TURNS`).

## LAN access

The server binds to loopback only. To reach it from your LAN, route a subpath to it from a reverse proxy
(all asset/API URLs are relative, so it works under any prefix, e.g. `https://host:1234/search/` via
aigw).
