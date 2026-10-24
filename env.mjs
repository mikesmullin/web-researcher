// Shared .env loader for this repo. Bun auto-loads .env from the *process* cwd,
// but MCP clients start `bun .../mcp.mjs` from their own workspace, so the keys
// would vanish for callers outside this repo. Read the .env sitting next to
// this file as well; real environment variables (systemd EnvironmentFile, shell
// exports) still win.
import { join } from 'node:path';

// Modules that read API credentials should `await loadEnv()` on import.
const ENV_FILES = ['.env.local', '.env'];
export const ENV_PATHS = ENV_FILES.map((n) => join(import.meta.dir, n));

export async function loadEnv() {
  for (const path of ENV_PATHS) {
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    for (const raw of (await file.text()).split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
      if (!key) continue;
      let value = line.slice(eq + 1).trim();
      const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
      if (quoted) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, '').trim(); // strip trailing comment
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
