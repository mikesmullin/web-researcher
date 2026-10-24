#!/usr/bin/env bun
// MCP stdio server for Deep Search: exposes the agentic web researcher as a
// single tool call. Reads newline-delimited JSON-RPC 2.0 on stdin, writes it
// on stdout. All logs go to stderr so stdout stays clean protocol.
//
// Tool: `search`
//   input:  { query: string } (`prompt`/`q`/`question` accepted as aliases for `query`)
//   output: single text block = final cited Markdown report (own [n] numbering + Sources list)
//
// Run:  bun mcp.mjs
// MCP client config (e.g. Claude Desktop / mcp.json):
//   { "mcpServers": { "deep-search": { "command": "bun", "args": ["/path/to/web-researcher/mcp.mjs"] } } }
//
// Env (same as agent.mjs/server.mjs): BRAVE_API_KEY, LLM_MODEL, MAX_TOOL_CALLS, MAX_TURNS.
import { research } from './agent.mjs';
import { searchSource } from './brave.mjs';

const NAME = 'web-researcher';
const VERSION = '0.1.0';
// Versions of the MCP spec this server speaks (newest first).
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const LATEST = SUPPORTED[0];

const TOOL = {
  name: 'search',
  description: 'Run agentic web research: searches the web (Brave Search API), reads the most promising sources, and returns one cited Markdown report (summary first, then sections with tables where comparing, inline [n] citations plus a "## Sources" list). Use for any question needing up-to-date or external information.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Research question in plain English, phrased as a natural-language question (e.g. "What are the rate limits of the Brave Search API in 2026?"). '
          + 'This tool is agentic: it decomposes the request, runs several refined searches itself, and reads sources — so a well-formed question works best, while bare keyword strings, quoted phrases, or search operators (site:, filetype:, "-", OR) constrain it and hurt results.',
      },
      prompt: { type: 'string', description: 'Alias for `query`.' },
    },
    required: ['query'],
  },
};

const log = (...a) => console.error(`[${NAME}]`, ...a);
const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id, result) => out({ jsonrpc: '2.0', id, result });
const err = (id, code, message, data) =>
  out({ jsonrpc: '2.0', id: id ?? null, result: undefined, error: { code, message, ...(data !== undefined ? { data } : {}) } });

async function handleCall(params) {
  const name = params?.name;
  if (name !== TOOL.name) throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32602 });
  const args = params?.arguments ?? {};
  const query = String(args.query ?? args.prompt ?? args.q ?? args.question ?? '').trim();
  if (!query) throw Object.assign(new Error('missing required argument: query (or prompt)'), { code: -32602 });
  log(`search: ${query.slice(0, 120)}`);
  const report = await research(query, (kind, d) => {
    if (kind === 'tool') log(`→ ${d.name}`, JSON.stringify(d.args)?.slice(0, 200));
  });
  const text = String(report || '').trim() || '_No report produced._';
  log(`done: ${(text.length / 1024).toFixed(1)} KiB`);
  return { content: [{ type: 'text', text }] };
}

async function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    if (msg?.id !== undefined) err(msg.id, -32600, 'invalid request');
    return;
  }
  const { id, method, params } = msg;
  try {
    switch (method) {
      case 'initialize': {
        const v = SUPPORTED.includes(params?.protocolVersion) ? params.protocolVersion : LATEST;
        ok(id, {
          protocolVersion: v,
          capabilities: { tools: {} },
          serverInfo: { name: NAME, version: VERSION },
          instructions: 'Agentic web researcher. Call the `search` tool with a question; you get back one cited Markdown report.',
        });
        break;
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        break; // notifications: no response
      case 'ping':
        ok(id, {});
        break;
      case 'tools/list':
        ok(id, { tools: [TOOL] });
        break;
      case 'tools/call':
        ok(id, await handleCall(params));
        break;
      default:
        if (id !== undefined) err(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    log('error:', e?.message || e);
    if (id !== undefined) err(id, e?.code ?? -32603, String(e?.message || e));
  }
}

async function main() {
  log(`MCP stdio server v${VERSION} (model=${process.env.LLM_MODEL || 'llama-server:default'}, search=${searchSource()}, key=${process.env.BRAVE_API_KEY ? 'set' : 'MISSING'})`);
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of Bun.stdin.stream()) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { log('ignoring non-JSON line'); continue; }
      // Don't block the read loop; tool calls run long.
      handle(msg);
    }
  }
}

main().catch((e) => { log('fatal:', e?.message || e); process.exit(1); });
