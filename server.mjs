// Serves the m-js UI and streams agent progress over SSE. Stateless: session history lives in
// each user's browser (localStorage); follow-ups send the prior turns along with the question.
import { research } from './agent.mjs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 2340);
const HOST = process.env.HOST || '127.0.0.1'; // loopback only; LAN access goes through the aigw /search/ proxy
const PUBLIC = join(import.meta.dir, 'public');
const PHOSPHOR = join(import.meta.dir, 'node_modules/@phosphor-icons/web/src/regular');
const MJS = join(import.meta.dir, 'node_modules/m-js/dist/m.min.js');
const MODEL = process.env.LLM_MODEL || 'llama-server:default';
const MAX_BODY = 512 * 1024;

function runTurn(q, history) {
  const enc = new TextEncoder();
  const ac = new AbortController();
  const stream = new ReadableStream({
    async start(ctl) {
      const send = (event, data) => {
        try { ctl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch {}
      };
      send('ready', { model: MODEL });
      try { send('report', await research(q, send, { signal: ac.signal, history })); }
      catch (e) { if (!ac.signal.aborted) send('error', String(e.message || e)); }
      try { ctl.close(); } catch {}
    },
    cancel() { ac.abort(); }, // client went away / pressed Stop
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } });
}

Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0,
  maxRequestBodySize: MAX_BODY,
  async fetch(req) {
    const p = new URL(req.url).pathname;
    let m;
    if (p === '/vendor/m.js') return new Response(Bun.file(MJS));
    if ((m = p.match(/^\/vendor\/phosphor\/(style\.css|Phosphor\.\w+)$/))) return new Response(Bun.file(join(PHOSPHOR, m[1])));
    if (p === '/api/research' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch { return new Response('invalid JSON', { status: 400 }); }
      const q = String(body?.q ?? '').trim();
      if (!q) return new Response('missing q', { status: 400 });
      const history = (Array.isArray(body.history) ? body.history : []).slice(-3)
        .map((h) => ({ q: String(h?.q ?? '').slice(0, 2000), report: String(h?.report ?? '').slice(0, 20000) }));
      return runTurn(q, history);
    }
    if (p.includes('..')) return new Response('bad path', { status: 400 });
    const file = Bun.file(join(PUBLIC, p === '/' ? 'index.html' : p));
    return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
  },
});
console.log(`Deep Search → http://${HOST}:${PORT}`);
