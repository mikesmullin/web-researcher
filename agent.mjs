// Agentic web research: AGL agent + SearXNG search/fetch tools -> cited Markdown report.
import Agent from 'agl-ai';

const SEARX = process.env.SEARXNG_URL || 'http://localhost:8080';
const MODEL = process.env.LLM_MODEL || 'llama-server:default'; // :1234 llama.cpp
const MAX_TOOL_CALLS = Number(process.env.MAX_TOOL_CALLS || 12); // after this, tools tell the model to write the report
const MAX_TURNS = Number(process.env.MAX_TURNS || 24); // hard safety cap (agl aborts past this)

const SYSTEM = `You are a meticulous research agent. Today's date: {{today}}.
Use web_search to find sources and fetch_page to read the most promising ones. Iterate with refined,
distinct queries (call several tools in parallel when independent) and cross-check claims across sources.
When you have enough, STOP calling tools and write the final report in Markdown: a short summary first,
then organised sections (use tables where comparing), noting disagreements between sources.
Cite inline as [1], [2]... and end with a "## Sources" section listing "[n] Title — URL" for each source you used.`;

const UA = { 'User-Agent': 'Mozilla/5.0 (deep-search research agent)' };

export async function webSearch(query, categories = 'general') {
  const qs = new URLSearchParams({ q: query, format: 'json', categories });
  const res = await fetch(`${SEARX}/search?${qs}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`SearXNG ${res.status}`);
  const { results = [] } = await res.json();
  return results.slice(0, 8).map((r) => ({
    title: r.title, url: r.url, snippet: (r.content || '').slice(0, 300), engine: r.engine,
  }));
}

export async function fetchPage(url, limit = 6000) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20_000), redirect: 'follow' });
  const type = res.headers.get('content-type') || '';
  if (!/html|text/.test(type)) return { title: url, text: `Unsupported content type: ${type}` };
  const raw = (await res.text()).slice(0, 1_500_000);
  let title = '', buf = '', skip = 0;
  const rw = new HTMLRewriter()
    .on('title', { text: (t) => { title += t.text; } })
    .on('script,style,nav,footer,header,svg,noscript,form,aside', {
      element(el) { skip++; el.onEndTag(() => { skip--; }); },
    })
    .on('p,div,li,br,h1,h2,h3,h4,tr', { element(el) { buf += '\n'; } })
    .on('body *', { text(t) { if (!skip) buf += t.text; } });
  await rw.transform(new Response(raw)).text();
  const decode = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  const text = decode(buf).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, limit);
  return { title: decode(title).trim() || url, text };
}

/** Run the agent. emit(kind, data) streams progress; returns the final Markdown. */
export async function research(question, emit = () => {}, { signal, history = [] } = {}) {
  const agent = await Agent.factory({
    model: MODEL,
    system_prompt: SYSTEM,
    locals: { today: new Date().toDateString() },
    parallel_tools: true,
    max_turns: MAX_TURNS,
    stream: true,
    on_delta: (text, { channel } = {}) => emit(channel === 'reasoning' ? 'thinking' : 'delta', text),
  });
  signal?.addEventListener('abort', () => agent.abort('client disconnected'));

  let calls = 0;
  const step = (name, args, fn) => async (ctx, a) => {
    if (++calls > MAX_TOOL_CALLS) return 'Research budget exhausted. Do not call any more tools; write the final cited report now from what you have.';
    const id = crypto.randomUUID().slice(0, 8);
    emit('tool', { id, name, args: a });
    try {
      const out = await fn(a);
      emit('result', { id, name, ok: true, out });
      return JSON.stringify(out);
    } catch (e) {
      emit('result', { id, name, ok: false, error: String(e.message || e) });
      return `Error: ${e.message || e}`;
    }
  };

  agent.Tool('web_search', 'Search the web via SearXNG. Returns titles, URLs and snippets.', {
    query: { type: 'string' },
    categories: { type: 'string', description: 'general, news, it, science (default general)' },
  }, ['query'], step('web_search', null, (a) => webSearch(a.query, a.categories || 'general')));

  agent.Tool('fetch_page', 'Download a URL and return its readable text (truncated).', {
    url: { type: 'string' },
  }, ['url'], step('fetch_page', null, (a) => fetchPage(a.url)));

  // Follow-ups: replay the most recent turns as context (reports capped) ahead of the new question.
  const context = history.slice(-3).map((h, i) =>
    `### Earlier question ${i + 1}: ${h.q}\n${(h.report || '').slice(0, 6000)}`).join('\n\n');
  const prompt = context
    ? `This is a follow-up in an ongoing research session.\n\n${context}\n\n---\nFollow-up question: ${question}\n\nUse the earlier findings where relevant, search again for anything missing, and write a self-contained report (own [n] numbering and Sources list).`
    : question;
  const res = await agent.run({ prompt });
  return res?.choices?.[0]?.message?.content || '';
}

if (import.meta.main) {
  const q = process.argv.slice(2).join(' ') || 'What is SearXNG?';
  const report = await research(q, (k, d) => {
    if (k === 'tool') console.error(`→ ${d.name}`, JSON.stringify(d.args));
  });
  console.log(report);
}
