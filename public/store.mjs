// Session persistence in the browser: one Markdown document per session in localStorage
// (key `ds:s:<id>`). YAML frontmatter = metadata; body = turns (question, trail, report)
// + a citation-list appendix. Nothing about a user's history is stored on the server.
const PREFIX = 'ds:s:';
const ID_RE = /^[\w-]+$/;
const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

export function newId(question) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const slug = one(question).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `${stamp}-${slug || 'search'}`;
}

// --- minimal YAML for the flat frontmatter (scalars + list of strings) ---
const scalar = (v) => (typeof v === 'number' ? String(v) : JSON.stringify(String(v)));
const yamlDump = (meta) => Object.entries(meta).map(([k, v]) => (Array.isArray(v)
  ? `${k}:${v.length ? '\n' + v.map((x) => `  - ${scalar(x)}`).join('\n') : ' []'}`
  : `${k}: ${scalar(v)}`)).join('\n');
const val = (s) => { try { return JSON.parse(s); } catch { return s.trim(); } };
function yamlLoad(text) {
  const o = {};
  let list = null;
  for (const line of text.split('\n')) {
    let m;
    if (list && (m = line.match(/^\s+- (.*)$/))) { o[list].push(val(m[1])); continue; }
    if ((m = line.match(/^(\w+):\s*(.*)$/))) {
      list = null;
      if (m[2] === '' || m[2] === '[]') { o[m[1]] = []; list = m[2] === '' ? m[1] : null; } else o[m[1]] = val(m[2]);
    }
  }
  return o;
}

export function toMarkdown(s) {
  const meta = {
    id: s.id, title: s.title, created: s.created, updated: s.updated, model: s.model || '',
    turns: s.turns.length, steps: s.turns.reduce((n, t) => n + t.steps.length, 0),
    sources: s.sources.length, sources_read: s.sources.filter((x) => x.read).length,
    questions: s.turns.map((t) => one(t.q)),
  };
  const body = s.turns.map((t, i) => {
    const trail = t.steps.map((st) => (st.name === 'web_search'
      ? `- 🔎 search: ${one(st.label)} — ${one(st.meta)}`
      : `- 📄 read: ${one(st.label)} — ${one(st.meta)} <${st.url || ''}>`)).join('\n');
    return [
      `<!-- turn ${i + 1} | ${t.at} | ${t.elapsed ?? 0}s -->`,
      `## Q: ${one(t.q)}`, '',
      `<details><summary>Research trail (${t.steps.length} steps)</summary>`, '', trail, '', '</details>', '',
      t.error ? `> ⚠️ ${one(t.error)}` : t.report.trim(), '',
      '<!-- /turn -->',
    ].join('\n');
  }).join('\n\n');
  const line = (x) => `- [${one(x.title).replace(/[[\]]/g, '')}](${x.url}) — ${host(x.url)} · ${x.read ? 'read' : 'found'}`;
  const read = s.sources.filter((x) => x.read).map(line).join('\n') || '_none_';
  const found = s.sources.filter((x) => !x.read).map(line).join('\n');
  const cites = `${read}${found ? `\n\n### Also found (not read)\n\n${found}` : ''}`;
  return `---\n${yamlDump(meta)}\n---\n\n${body}\n\n<!-- citations -->\n## Citations\n\n${cites}\n`;
}

export function fromMarkdown(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error('no frontmatter');
  const meta = yamlLoad(m[1]);
  const turns = [];
  for (const t of md.matchAll(/<!-- turn \d+ \| (.*?) \| (\d+)s -->\n([\s\S]*?)\n<!-- \/turn -->/g)) {
    const [, at, elapsed, block] = t;
    const q = block.match(/^## Q: (.*)$/m)?.[1] ?? '';
    const trail = block.match(/<details>[\s\S]*?<\/summary>\n\n([\s\S]*?)\n*<\/details>/)?.[1] ?? '';
    const steps = [...trail.matchAll(/^- (?:🔎 search|📄 read): (.*) — (.*?)(?: <(.*)>)?$/gm)].map((x, i) => {
      const isRead = x[0].startsWith('- 📄');
      return { id: `${turns.length}-${i}`, name: isRead ? 'fetch_page' : 'web_search', label: x[1], meta: x[2], url: x[3] || undefined,
        state: /^error|failed/i.test(x[2]) ? 'err' : 'ok' };
    });
    const after = block.slice(block.indexOf('</details>') + 10).trim();
    const err = after.match(/^> ⚠️ (.*)$/);
    turns.push({ q, at, elapsed: Number(elapsed), steps, report: err ? '' : after, error: err?.[1] });
  }
  const sources = [...md.slice(md.indexOf('<!-- citations -->')).matchAll(/^- \[(.*)\]\((\S+)\) — .* · (read|found)$/gm)]
    .map((x) => ({ title: x[1], url: x[2], read: x[3] === 'read' }));
  return { id: meta.id, title: meta.title, created: meta.created, updated: meta.updated, model: meta.model, turns, sources };
}

// --- localStorage CRUD (every access guarded: storage can be blocked or full) ---
export function saveSession(s) {
  if (!ID_RE.test(s.id)) throw new Error('bad session id');
  s.updated = new Date().toISOString();
  try { localStorage.setItem(PREFIX + s.id, toMarkdown(s)); return true; }
  catch (e) { console.warn('could not save session (storage full or blocked):', e); return false; }
}

export function loadSession(id) {
  try {
    const md = localStorage.getItem(PREFIX + id);
    return md ? fromMarkdown(md) : null;
  } catch { return null; }
}

export function deleteSession(id) { try { localStorage.removeItem(PREFIX + id); } catch { /* ignore */ } }

export function listSessions() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      try {
        const head = localStorage.getItem(k).match(/^---\n([\s\S]*?)\n---\n/)?.[1];
        const m = yamlLoad(head);
        out.push({ id: m.id, title: m.title, created: m.created, updated: m.updated, turns: m.turns, sources: m.sources });
      } catch { /* skip unreadable entry */ }
    }
  } catch { /* storage blocked */ }
  return out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}
