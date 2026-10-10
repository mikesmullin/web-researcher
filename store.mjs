// Session persistence: one Markdown file per research session in ./db/
// YAML frontmatter = metadata; body = turns (question, trail, report) + a citation-list appendix.
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const DIR = process.env.DB_DIR || join(import.meta.dir, 'db');
const ID_RE = /^[\w-]+$/;
const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const pathOf = (id) => {
  if (!ID_RE.test(id)) throw new Error('bad session id');
  return join(DIR, `${id}.md`);
};

export function newSession(question, model) {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const slug = one(question).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return {
    id: `${stamp}-${slug || 'search'}`, title: one(question).slice(0, 100),
    created: now.toISOString(), updated: now.toISOString(), model, turns: [], sources: [],
  };
}

export function toMarkdown(s) {
  const meta = {
    id: s.id, title: s.title, created: s.created, updated: s.updated, model: s.model,
    turns: s.turns.length, steps: s.turns.reduce((n, t) => n + t.steps.length, 0),
    sources: s.sources.length, sources_read: s.sources.filter((x) => x.read).length,
    questions: s.turns.map((t) => one(t.q)),
  };
  const body = s.turns.map((t, i) => {
    const trail = t.steps.map((st) => st.name === 'web_search'
      ? `- 🔎 search: ${one(st.label)} — ${one(st.meta)}`
      : `- 📄 read: ${one(st.label)} — ${one(st.meta)} <${st.url || ''}>`).join('\n');
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
  return `---\n${Bun.YAML.stringify(meta, null, 2)}\n---\n\n${body}\n\n<!-- citations -->\n## Citations\n\n${cites}\n`;
}

export function fromMarkdown(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error('no frontmatter');
  const meta = Bun.YAML.parse(m[1]);
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

export async function saveSession(s) {
  s.updated = new Date().toISOString();
  await mkdir(DIR, { recursive: true });
  await Bun.write(pathOf(s.id), toMarkdown(s));
  return s;
}

export async function loadSession(id) {
  const f = Bun.file(pathOf(id));
  return (await f.exists()) ? fromMarkdown(await f.text()) : null;
}

export async function deleteSession(id) { await rm(pathOf(id), { force: true }); }

export async function listSessions() {
  await mkdir(DIR, { recursive: true });
  const out = [];
  for (const f of await readdir(DIR)) {
    if (!f.endsWith('.md')) continue;
    try {
      const head = (await Bun.file(join(DIR, f)).text()).match(/^---\n([\s\S]*?)\n---\n/)?.[1];
      const m = Bun.YAML.parse(head);
      out.push({ id: m.id, title: m.title, created: m.created, updated: m.updated, turns: m.turns, sources: m.sources });
    } catch { /* skip unreadable file */ }
  }
  return out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}
