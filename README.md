# Deep Search

Agentic web research prototype: ask a question, an agent searches the web (SearXNG), reads sources and
writes one cited Markdown report. Runs fully local.

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

Every session is saved as one Markdown file in `./db/` (gitignored) and listed in the sidebar:
YAML frontmatter holds the metadata (id, title, timestamps, model, counts, questions), the body holds each
turn (question, research trail, report), and a **Citations** appendix lists every source (read vs. only found).
Sessions are deep-linkable (`#<id>`), reload-safe, and can be deleted from the sidebar.

## Parts

- `agent.mjs` — [agl-ai](https://github.com/mikesmullin/agl) agent (`llama-server:default` on :1234) + `web_search` / `fetch_page` tools
- `server.mjs` — Bun server; streams progress over SSE (`/api/research?q=&session=`) + sessions API
- `store.mjs` — session persistence (Markdown + YAML frontmatter in `db/`)
- `public/` — dark, responsive [m-js](https://github.com/mikesmullin/m-js) UI (`app.mjs`, `md.mjs`, `style.css`)

## Run

    cp settings.yml.example core-config/settings.yml
    sed -i "s/CHANGE_ME/$(openssl rand -hex 32)/" core-config/settings.yml
    podman-compose up -d                 # SearXNG on :8080
    bun link agl-ai m-js                 # local fs libs (bun link in each repo first)
    bun server.mjs                       # UI on :8000
    bun agent.mjs "your question"        # or CLI

Env: `SEARXNG_URL`, `LLM_MODEL` (default `llama-server:default`), `MAX_TOOL_CALLS`, `MAX_TURNS`, `DB_DIR`, `PORT`.
