// Serves the m-js UI and streams agent progress over SSE.
import { research } from './agent.mjs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 8000);
const PUBLIC = join(import.meta.dir, 'public');
const MJS = join(import.meta.dir, 'node_modules/m-js/dist/m.min.js');

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/vendor/m.js') return new Response(Bun.file(MJS));
    if (url.pathname === '/api/research') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return new Response('missing q', { status: 400 });
      const enc = new TextEncoder();
      const ac = new AbortController();
      const stream = new ReadableStream({
        async start(ctl) {
          const send = (event, data) => {
            try { ctl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch {}
          };
          try { send('report', await research(q, send, { signal: ac.signal })); }
          catch (e) { send('error', String(e.message || e)); }
          try { ctl.close(); } catch {}
        },
        cancel() { ac.abort(); },
      });
      return new Response(stream, { headers: {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no',
      } });
    }
    const file = Bun.file(join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    return (await file.exists()) && !url.pathname.includes('..') ? new Response(file) : new Response('not found', { status: 404 });
  },
});
console.log(`Deep Search → http://localhost:${PORT}`);
