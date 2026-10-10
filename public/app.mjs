import M from '/vendor/m.js';
import { renderMarkdown, hostOf } from '/md.mjs';

const EXAMPLES = [
  'Compare SearXNG and the Brave Search API for powering AI agents',
  'What changed in the latest Bun release?',
  'State of local LLM inference on Linux: llama.cpp vs vLLM vs Ollama',
  'Best practices for self-hosting a metasearch engine',
];
const HUES = [250, 190, 150, 30, 330, 210, 90, 10];
const hue = (s) => HUES[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];

M.mount('#app', () => ({
  q: '', running: false, done: false, error: '', report: '', draft: '', thinking: '',
  steps: [], sources: [], elapsed: 0, copied: false, showAll: false, examples: EXAMPLES,
  _es: null, _t: null, _t0: 0,

  get started() { return this.running || this.done || !!this.error; },
  get readCount() { return this.sources.filter((s) => s.read).length; },
  get html() { return renderMarkdown(this.report || this.draft); },
  get sortedSources() { const l = [...this.sources].sort((a, b) => b.read - a.read); return this.showAll ? l : l.slice(0, 8); },
  get clock() { const s = this.elapsed; return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; },
  avatar(s) { return { background: `hsl(${hue(hostOf(s.url))} 80% 70%)` }; },
  letter(s) { return (hostOf(s.url)[0] || '?').toUpperCase(); },
  host(s) { return hostOf(s.url); },

  fit(e) { const t = e.target; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 200) + 'px'; },
  onKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.q = e.target.value; this.run(); } },
  pick(x) { this.q = x; this.run(); },

  run() {
    const q = this.q.trim();
    if (!q || this.running) return;
    Object.assign(this, { running: true, done: false, error: '', report: '', draft: '', thinking: '', steps: [], sources: [], elapsed: 0, showAll: false });
    this._t0 = Date.now();
    this._t = setInterval(() => { this.elapsed = Math.round((Date.now() - this._t0) / 1000); }, 1000);
    const es = this._es = new EventSource('/api/research?q=' + encodeURIComponent(q));
    const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data)));
    on('thinking', (t) => { this.thinking = (this.thinking + t).slice(-400); });
    on('delta', (t) => { this.draft += t; });
    on('tool', (d) => {
      this.draft = ''; this.thinking = '';
      this.steps.push({ id: d.id, name: d.name, label: d.args.query || d.args.url, url: d.args.url, state: 'run', meta: '' });
    });
    on('result', (d) => {
      const s = this.steps.find((x) => x.id === d.id);
      if (!s) return;
      s.state = d.ok ? 'ok' : 'err';
      if (!d.ok) { s.meta = d.error; return; }
      if (d.name === 'web_search') {
        s.meta = `${d.out.length} results`;
        for (const r of d.out) if (!this.sources.some((x) => x.url === r.url)) this.sources.push({ url: r.url, title: r.title, read: false });
      } else {
        s.meta = `${d.out.text.length.toLocaleString()} chars`;
        s.label = d.out.title || s.label;
        const f = this.sources.find((x) => x.url === s.url);
        if (f) f.read = true;
        else this.sources.push({ url: s.url, title: d.out.title, read: true });
      }
    });
    on('report', (md) => { this.report = md; this.finish(); this.done = true; });
    on('error', (m) => { this.error = m; this.finish(); });
    es.onerror = () => { if (this.running) { this.error ||= 'Connection lost.'; this.finish(); } };
  },
  finish() { this.running = false; clearInterval(this._t); this._es?.close(); this.draft = ''; this.thinking = ''; },
  stop() { this.finish(); this.error = 'Stopped.'; },
  copy() { navigator.clipboard?.writeText(this.report).then(() => { this.copied = true; setTimeout(() => { this.copied = false; }, 1500); }); },

  template: `
  <div class="wrap">
    <div class="bar">
      <div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="#08090d" stroke-width="3" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l6 6"/></svg></div>
      <span class="brand">Deep Search</span>
      <div class="chips-top"><span class="pill hide-s">SearXNG</span><span class="pill"><i></i>local LLM</span></div>
    </div>

    <div class="hero" :class="{ compact: started }">
      <h1>Ask once. <span>Research everything.</span></h1>
      <p>An agent searches the web, reads the sources and writes one cited report. Private, local, no API fees.</p>
      <form class="composer" @submit.prevent="q = $refs.ta.value; run()">
        <textarea x-ref="ta" rows="1" x-model="q" @input="fit($event)" @keydown="onKey($event)" :disabled="running"
          placeholder="What do you want to know?" aria-label="Research question" autofocus></textarea>
        <button type="button" class="go stop" x-show="running" @click="stop()">■ <span class="lbl">Stop</span></button>
        <button type="submit" class="go" x-show="!running" :disabled="!q.trim()">Research <span class="lbl">→</span></button>
      </form>
      <div class="examples" x-show="!started">
        <button class="ex" x-for="e in examples" :key="e" @click="pick(e)" x-text="e"></button>
      </div>
    </div>

    <div class="grid" x-show="started">
      <main>
        <section class="card fade-in">
          <h3><span x-show="running" class="pulse"></span><span x-text="running ? 'Researching…' : 'Research trail'"></span>
            <span class="n"><span x-text="steps.length"></span> steps · <span x-text="clock"></span></span></h3>
          <div class="step" x-for="s in steps" :key="s.id">
            <div class="ico" :class="{ read: s.name === 'fetch_page' }" x-text="s.name === 'web_search' ? '⌕' : '❏'"></div>
            <div class="t">
              <div class="k" x-text="s.name === 'web_search' ? 'Searching' : 'Reading'"></div>
              <div class="v" x-text="s.label"></div>
              <div class="m" x-show="s.meta" x-text="s.meta"></div>
            </div>
            <div class="st">
              <span class="spin" x-show="s.state === 'run'"></span>
              <span class="ok" x-show="s.state === 'ok'">✓</span>
              <span class="err" x-show="s.state === 'err'">✕</span>
            </div>
          </div>
          <div class="empty" x-show="!steps.length && running">Planning the first search…</div>
          <div class="think" x-show="running && thinking" x-text="thinking"></div>
        </section>

        <section class="card errbox fade-in" x-show="error"><span x-text="error"></span></section>

        <section class="card fade-in" x-show="report || draft">
          <div class="report-head">
            <h3 x-text="report ? 'Report' : 'Drafting…'"></h3>
            <div class="sp" x-show="report">
              <button class="mini" @click="copy()" x-text="copied ? 'Copied ✓' : 'Copy Markdown'"></button>
            </div>
          </div>
          <article class="prose" :class="{ cursor: !report }" x-html="html"></article>
        </section>
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
    <div class="foot">SearXNG · AGL · m.js</div>
  </div>`,
}));
