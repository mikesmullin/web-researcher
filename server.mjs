// Serves the m-js UI, a small sessions API, and streams agent progress over SSE.
import { research } from './agent.mjs';
import { join } from 'node:path';
import { newSession, saveSession, loadSession, deleteSession, listSessions } from './store.mjs';

const PORT = Number(process.env.PORT || 2340);
const HOST = process.env.HOST || '127.0.0.1'; // loopback only; LAN access goes through the aigw /search/ proxy
const PUBLIC = join(import.meta.dir, 'public');
const PHOSPHOR = join(import.meta.dir, 'node_modules/@phosphor-icons/web/src/regular');
const MJS = join(import.meta.dir, 'node_modules/m-js/dist/m.min.js');
const MODEL = process.env.LLM_MODEL || 'llama-server:default';
const json = (d, status = 200) => Response.json(d, { status });

async function runTurn(req, q, sid) {
  let session = sid ? await loadSession(sid) : null;
  if (sid && !session) return new Response('unknown session', { status: 404 });
  session ||= newSession(q, MODEL);
  const turn = { q, at: new Date().toISOString(), steps: [], report: '', elapsed: 0 };
  const t0 = Date.now();
  const enc = new TextEncoder();
  const ac = new AbortController();
  const stream = new ReadableStream({
    async start(ctl) {
      const send = (event, data) => {
        try { ctl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch {}
      };
      // Record the trail + sources server-side while forwarding events to the browser.
      const emit = (kind, d) => {
        if (kind === 'tool') turn.steps.push({ id: d.id, name: d.name, label: d.args.query || d.args.url, url: d.args.url, meta: '', state: 'run' });
        if (kind === 'result') {
          const st = turn.steps.find((x) => x.id === d.id);
          if (st && !d.ok) Object.assign(st, { state: 'err', meta: `error: ${d.error}` });
          else if (st && d.name === 'web_search') {
            Object.assign(st, { state: 'ok', meta: `${d.out.length} results` });
            for (const r of d.out) if (!session.sources.some((x) => x.url === r.url)) session.sources.push({ url: r.url, title: r.title, read: false });
          } else if (st) {
            Object.assign(st, { state: 'ok', meta: `${d.out.text.length.toLocaleString()} chars`, label: d.out.title || st.label });
            const f = session.sources.find((x) => x.url === st.url);
            if (f) f.read = true; else session.sources.push({ url: st.url, title: d.out.title, read: true });
          }
        }
        send(kind, d);
      };
      send('session', { id: session.id, title: session.title, sources: session.sources });
      try {
        turn.report = await research(q, emit, { signal: ac.signal, history: session.turns });
        turn.elapsed = Math.round((Date.now() - t0) / 1000);
        session.turns.push(turn);
        await saveSession(session);
        send('report', turn.report);
      } catch (e) {
        if (!ac.signal.aborted) {
          turn.error = String(e.message || e); turn.elapsed = Math.round((Date.now() - t0) / 1000);
          session.turns.push(turn); await saveSession(session);
        }
        send('error', String(e.message || e));
      }
      try { ctl.close(); } catch {}
    },
    cancel() { ac.abort(); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } });
}

Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    let m;
    try {
      if (p === '/vendor/m.js') return new Response(Bun.file(MJS));
      if ((m = p.match(/^\/vendor\/phosphor\/(style\.css|Phosphor\.\w+)$/))) return new Response(Bun.file(join(PHOSPHOR, m[1])));
      if (p === '/api/sessions') return json(await listSessions());
      if ((m = p.match(/^\/api\/sessions\/([\w-]+)$/))) {
        if (req.method === 'DELETE') { await deleteSession(m[1]); return json({ ok: true }); }
        const s = await loadSession(m[1]);
        return s ? json(s) : json({ error: 'not found' }, 404);
      }
      if (p === '/api/research') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return new Response('missing q', { status: 400 });
        return runTurn(req, q, url.searchParams.get('session'));
      }
    } catch (e) { return json({ error: String(e.message || e) }, 500); }
    if (p.includes('..')) return new Response('bad path', { status: 400 });
    const file = Bun.file(join(PUBLIC, p === '/' ? 'index.html' : p));
    return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
  },
});
console.log(`Deep Search → http://${HOST}:${PORT}`);
