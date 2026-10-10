# Deep Search

Agentic web research prototype: ask a question, an agent searches the web (SearXNG), reads sources and
writes one cited Markdown report. Runs fully local.

- `agent.mjs` — [agl-ai](https://github.com/mikesmullin/agl) agent (`llama-server:default` on :1234) + `web_search` / `fetch_page` tools
- `server.mjs` — Bun server; streams progress over SSE (`/api/research?q=`)
- `public/` — dark, responsive [m-js](https://github.com/mikesmullin/m-js) UI (`app.mjs`, `md.mjs`, `style.css`)

## Run

    cp settings.yml.example core-config/settings.yml
    sed -i "s/CHANGE_ME/$(openssl rand -hex 32)/" core-config/settings.yml
    podman-compose up -d                 # SearXNG on :8080
    bun link agl-ai m-js                 # local fs libs (bun link in each repo first)
    bun server.mjs                       # UI on :8000
    bun agent.mjs "your question"        # or CLI

Env: `SEARXNG_URL`, `LLM_MODEL` (default `llama-server:default`), `MAX_TURNS`, `PORT`.
