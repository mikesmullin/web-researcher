import M from './vendor/m.js';
import { renderMarkdown, hostOf } from './md.mjs';
import { newId, saveSession, loadSession, deleteSession, listSessions } from './store.mjs';

const EXAMPLES = [
  'Compare SearXNG and the Brave Search API for powering AI agents',
  'What changed in the latest Bun release?',
  'State of local LLM inference on Linux: llama.cpp vs vLLM vs Ollama',
  'Best practices for self-hosting a metasearch engine',
];
const HUES = [250, 190, 150, 30, 330, 210, 90, 10];
const hue = (s) => HUES[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
// POST + stream Server-Sent Events (EventSource can't send a body).
async function postSSE(url, body, signal, onEvent) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = block.match(/^event: (.*)$/m)?.[1];
      const data = block.match(/^data: (.*)$/m)?.[1];
      if (ev && data) onEvent(ev, JSON.parse(data));
    }
  }
}
const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

M.mount('#app', () => ({
  q: '', sid: null, sessions: [], turns: [], sources: [], running: false, menu: false,
  copied: false, showAll: false, examples: EXAMPLES, _ac: null, _t: null, _meta: null,

  get started() { return this.turns.length > 0; },
  get cur() { return this.turns[this.turns.length - 1]; },
  get title() { return this.turns[0]?.q || ''; },
  get readCount() { return this.sources.filter((s) => s.read).length; },
  get sortedSources() { const l = [...this.sources].sort((a, b) => b.read - a.read); return this.showAll ? l : l.slice(0, 8); },
  get hasReport() { return this.turns.some((t) => t.report); },
  get allReports() { return this.turns.filter((t) => t.report).map((t) => `> User: ${t.q.replace(/\s*\n\s*/g, ' ')}\n\n${t.report.trim()}`).join('\n\n---\n\n'); },

  html(t) { return renderMarkdown(t.report || t.draft); },
  clock(n) { return n >= 60 ? `${Math.floor(n / 60)}m ${n % 60}s` : `${n}s`; },
  ago,
  avatar(s) { return { background: `hsl(${hue(hostOf(s.url))} 80% 70%)` }; },
  letter(s) { return (hostOf(s.url)[0] || '?').toUpperCase(); },
  host(s) { return hostOf(s.url); },

  init() {
    this.refresh();
    const id = location.hash.slice(1);
    if (id) this.loadSession(id);
  },
  refresh() { this.sessions = listSessions(); },
  loadSession(id) {
    if (this.running) this.stop();
    const s = loadSession(id);
    if (!s) { history.replaceState(null, '', location.pathname); return; }
    this.sid = s.id; this.sources = s.sources; this.q = ''; this.menu = false; this.showAll = false;
    this._meta = { created: s.created, model: s.model };
    this.turns = s.turns.map((t, i) => ({ ...t, id: i, draft: '', thinking: '', running: false, open: false }));
    location.hash = s.id;
    window.scrollTo(0, 0);
  },
  remove(id, e) {
    e.stopPropagation();
    deleteSession(id);
    if (this.sid === id) this.reset();
    this.refresh();
  },
  // Write the current thread to localStorage (stopped/unfinished turns are not persisted).
  persist() {
    const turns = this.turns.filter((t) => t.report || (t.error && t.error !== 'Stopped.')).map((t) => ({
      q: t.q, at: t.at, elapsed: t.elapsed, report: t.report, error: t.error || undefined,
      steps: t.steps.map(({ name, label, meta, url }) => ({ name, label, meta, url })),
    }));
    if (!turns.length) return;
    if (!saveSession({ id: this.sid, title: this.turns[0].q.replace(/\s+/g, ' ').trim().slice(0, 100), created: this._meta.created,
      model: this._meta.model, turns, sources: this.sources })) this.cur.error ||= 'Could not save to browser storage (full or blocked); this session will not be in history.';
    this.refresh();
  },
  reset() {
    if (this.running) this.stop();
    Object.assign(this, { sid: null, turns: [], sources: [], q: '', menu: false, showAll: false, _meta: null });
    history.replaceState(null, '', location.pathname);
  },

  // single input handler: an @input attr would replace x-model's own listener, so sync q here too
  onInput(e) { this.q = e.target.value; this.fit(e); },
  fit(e) { const t = e.target; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 200) + 'px'; },
  onKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.q = e.target.value; this.run(); } },
  submit(e) { this.q = e.target.querySelector('textarea').value; this.run(); },
  pick(x) { this.q = x; this.run(); },

  run() {
    const q = this.q.trim();
    if (!q || this.running) return;
    const prior = this.turns.filter((t) => t.report).slice(-3).map((t) => ({ q: t.q, report: t.report }));
    if (!this.sid) { this.sid = newId(q); this._meta = { created: new Date().toISOString(), model: '' }; location.hash = this.sid; }
    for (const t of this.turns) t.open = false;
    this.turns.push({ id: this.turns.length, q, at: new Date().toISOString(), steps: [], report: '', draft: '', thinking: '', error: '', elapsed: 0, running: true, open: false });
    this.q = ''; this.running = true;
    document.querySelectorAll('.composer textarea').forEach((t) => { t.style.height = ''; });
    const t0 = Date.now();
    this._t = setInterval(() => { this.cur.elapsed = Math.round((Date.now() - t0) / 1000); }, 1000);
    const ac = this._ac = new AbortController();
    const on = {
      ready: (d) => { this._meta.model = d.model; },
      thinking: (t) => { this.cur.thinking = (this.cur.thinking + t).slice(-400); },
      delta: (t) => { this.cur.draft += t; },
      tool: (d) => {
        this.cur.draft = ''; this.cur.thinking = '';
        this.cur.steps.push({ id: d.id, name: d.name, label: d.args.query || d.args.url, url: d.args.url, state: 'run', meta: '' });
      },
      result: (d) => {
        const s = this.cur.steps.find((x) => x.id === d.id);
        if (!s) return;
        s.state = d.ok ? 'ok' : 'err';
        if (!d.ok) { s.meta = `error: ${d.error}`; return; }
        if (d.name === 'web_search') {
          s.meta = `${d.out.length} results`;
          for (const r of d.out) if (!this.sources.some((x) => x.url === r.url)) this.sources.push({ url: r.url, title: r.title, read: false });
        } else {
          s.meta = `${d.out.text.length.toLocaleString()} chars`;
          s.label = d.out.title || s.label;
          const f = this.sources.find((x) => x.url === s.url);
          if (f) f.read = true; else this.sources.push({ url: s.url, title: d.out.title, read: true });
        }
      },
      report: (md) => { this.cur.report = md; this.finish(); this.persist(); },
      error: (m) => { this.cur.error = m; this.finish(); this.persist(); },
    };
    postSSE('api/research', { q, history: prior }, ac.signal, (ev, d) => on[ev]?.(d)).catch((e) => {
      if (ac.signal.aborted || !this.running) return;
      this.cur.error ||= String(e.message || 'Connection lost.'); this.finish(); this.persist();
    });
  },
  finish() {
    this.running = false; clearInterval(this._t); this._ac?.abort();
    if (this.cur) Object.assign(this.cur, { running: false, draft: '', thinking: '' });
  },
  stop() { this.finish(); if (this.cur && !this.cur.report) this.cur.error = 'Stopped.'; },
  async copy() {
    const text = this.allReports;
    try { await navigator.clipboard.writeText(text); }
    catch { // clipboard API blocked (no focus / insecure context): legacy fallback
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    this.copied = true; setTimeout(() => { this.copied = false; }, 1500);
  },

  template: `
  <div class="shell" x-init="init()">
    <div class="scrim" :class="{ on: menu }" @click="menu = false"></div>
    <aside class="nav" :class="{ on: menu }">
      <div class="brandrow">
        <div class="logo"><i class="ph ph-magnifying-glass"></i></div>
        <span class="brand">Deep Search</span>
      </div>
      <button class="newbtn" @click="reset()"><i class="ph ph-plus"></i> New search</button>
      <div class="navlabel">History <span x-text="sessions.length"></span></div>
      <div class="hist">
        <div class="empty pad" x-show="!sessions.length">Your searches will appear here.</div>
        <div class="hitem" x-for="s in sessions" :key="s.id" :class="{ active: s.id === sid }">
          <button class="hmain" @click="loadSession(s.id)">
            <span class="htitle" x-text="s.title"></span>
            <span class="hmeta"><span x-text="ago(s.updated)"></span> · <span x-text="s.turns"></span> <span x-text="s.turns === 1 ? 'turn' : 'turns'"></span> · <span x-text="s.sources"></span> src</span>
          </button>
          <button class="del" title="Delete" aria-label="Delete search" @click="remove(s.id, $event)"><i class="ph ph-trash"></i></button>
        </div>
      </div>
    </aside>

    <div class="main">
      <div class="mbar">
        <button class="burger" aria-label="Menu" @click="menu = true"><i class="ph ph-list"></i></button>
        <span class="brand">Deep Search</span>
        <button class="mini" style="margin-left:auto" @click="reset()"><i class="ph ph-plus"></i> New</button>
      </div>

      <div class="wrap">
        <div class="hero" x-show="!started">
          <h1>Ask once. <span>Research everything.</span></h1>
          <p>An agent searches the web, reads the sources and writes one cited report. Private, local, no API fees.</p>
          <form class="composer" @submit.prevent="submit($event)">
            <textarea rows="1" x-model="q" @input="onInput($event)" @keydown="onKey($event)"
              placeholder="What do you want to know?" aria-label="Research question" autofocus></textarea>
            <button type="submit" class="go" :disabled="!q.trim()"><span class="lbl">Research</span> <i class="ph ph-arrow-right"></i></button>
          </form>
          <div class="examples">
            <button class="ex" x-for="e in examples" :key="e" @click="pick(e)" x-text="e"></button>
          </div>
        </div>

        <div class="grid" x-show="started">
          <main class="thread">
            <div class="turn" x-for="t in turns" :key="t.id">
              <div class="qrow fade-in">
                <span class="qtag" x-text="t.id === 0 ? 'Question' : 'Follow-up'"></span>
                <h2 class="qtext" x-text="t.q"></h2>
              </div>

              <section class="card fade-in">
                <h3 class="clickable" @click="t.open = !t.open">
                  <span x-show="t.running" class="pulse"></span>
                  <span x-text="t.running ? 'Researching…' : 'Research trail'"></span>
                  <span class="n"><span x-text="t.steps.length"></span> steps · <span x-text="clock(t.elapsed)"></span>
                    <i class="ph chev" :class="t.open ? 'ph-caret-down' : 'ph-caret-right'"></i></span>
                </h3>
                <div x-show="t.open">
                  <div class="step" x-for="s in t.steps" :key="s.id">
                    <div class="ico" :class="{ read: s.name === 'fetch_page' }"><i class="ph" :class="s.name === 'web_search' ? 'ph-magnifying-glass' : 'ph-file-text'"></i></div>
                    <div class="t">
                      <div class="k" x-text="s.name === 'web_search' ? 'Searching' : 'Reading'"></div>
                      <div class="v" x-text="s.label"></div>
                      <div class="m" x-show="s.meta" x-text="s.meta"></div>
                    </div>
                    <div class="st">
                      <span class="spin" x-show="s.state === 'run'"></span>
                      <i class="ph ph-check-circle ok" x-show="s.state === 'ok'"></i>
                      <i class="ph ph-x-circle err" x-show="s.state === 'err'"></i>
                    </div>
                  </div>
                  <div class="empty" x-show="!t.steps.length && t.running">Planning the first search…</div>
                  <div class="think" x-show="t.running && t.thinking" x-text="t.thinking"></div>
                </div>
              </section>

              <section class="card errbox fade-in" x-show="t.error"><i class="ph ph-warning"></i> <span x-text="t.error"></span></section>

              <section class="card fade-in" x-show="t.report || t.draft">
                <div class="report-head">
                  <h3 x-text="t.report ? 'Report' : 'Drafting…'"></h3>
                </div>
                <article class="prose" :class="{ cursor: !t.report }" x-html="html(t)"></article>
              </section>
            </div>
            <div class="actions" x-show="hasReport && !running">
              <button class="mini copy" @click="copy()"><i class="ph" :class="copied ? 'ph-check' : 'ph-copy'"></i> <span x-text="copied ? 'Copied' : 'Copy'"></span></button>
            </div>
          </main>

          <aside class="side">
            <section class="card fade-in">
              <h3>Sources <span class="n"><span x-text="readCount"></span> read · <span x-text="sources.length"></span> found</span></h3>
              <div class="empty" x-show="!sources.length">Sources appear as they are found.</div>
              <a class="src" x-for="s in sortedSources" :key="s.url" :href="s.url" target="_blank" rel="noopener">
                <span class="av" :style="avatar(s)" x-text="letter(s)"></span>
                <span><span class="st-title" x-text="s.title"></span>
                  <span class="host"><span x-text="host(s)"></span><span class="badge" x-show="s.read">read</span></span></span>
              </a>
              <button class="mini more" x-show="sources.length > 8" @click="showAll = !showAll"
                x-text="showAll ? 'Show fewer' : 'Show all ' + sources.length"></button>
            </section>
          </aside>
        </div>
      </div>

      <div class="dock" x-show="started"><div class="dockin">
        <form class="composer" @submit.prevent="submit($event)">
          <textarea rows="1" x-model="q" @input="onInput($event)" @keydown="onKey($event)" :disabled="running"
            placeholder="Ask a follow-up…" aria-label="Follow-up question"></textarea>
          <button type="button" class="go stop" x-show="running" @click="stop()"><i class="ph ph-stop"></i> <span class="lbl">Stop</span></button>
          <button type="submit" class="go" x-show="!running" :disabled="!q.trim()"><span class="lbl">Ask</span> <i class="ph ph-arrow-right"></i></button>
        </form>
      </div></div>
    </div>
  </div>`,
}));
