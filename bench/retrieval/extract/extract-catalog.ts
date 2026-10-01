// =============================================================================
// Build bench/retrieval/catalog.json by spawning real MCP servers and calling
// tools/list. NOT run in CI — the committed catalog.json is the frozen corpus.
// Re-run only to refresh the corpus (then re-check query labels).
//
// Usage:
//   npx tsx bench/retrieval/extract/extract-catalog.ts [--only=id1,id2]
//
// Each entry in servers.json describes how to launch one server. Placeholders
// in command/args/env:
//   ${PY}    → Scripts/ (win) or bin/ dir of a venv holding the pip servers
//              (env W1_VENV, see README)
//   ${GOBIN} → dir holding go-installed binaries (env W1_GOBIN)
//   ${TMP}   → a scratch dir (filesystem/sqlite servers need a path)
//
// Credentials are always dummies: the point is tools/list, which almost every
// server answers without validating the token. Servers that fail or hang past
// the hard deadline are reported and skipped (README lists the ones dropped).
// Previously extracted servers are kept, so --only=<id> refreshes one entry.
// =============================================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { toJson } from '../json.js';

// Lenient tools/list shape: some servers (e.g. server-gitlab) emit schemas the
// SDK's strict ListToolsResultSchema rejects; we only need name/desc/schema.
const LenientToolsResult = z
  .object({
    tools: z.array(
      z.object({ name: z.string(), description: z.string().optional(), inputSchema: z.unknown() }),
    ),
    nextCursor: z.string().optional(),
  })
  .passthrough();
// Per-server hard deadline for connect + tools/list (install time excluded).
const SPAWN_TIMEOUT_MS = Number(process.env.W1_SPAWN_TIMEOUT_MS ?? 20_000);
const TIMEOUT = { timeout: SPAWN_TIMEOUT_MS };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'catalog.json');

interface ServerSpec {
  id: string;
  /** npm/pypi/go module spec, used for provenance + version resolution. */
  package: string;
  runtime: 'npm' | 'pip' | 'go';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** npm only: pin a version (default: latest at extraction time). */
  version?: string;
  /** npm only: run this script (relative to extract/) instead of the package bin. */
  launcher?: string;
  /** npm only: extra packages installed next to `package` (for launchers). */
  deps?: string[];
}

interface CatalogTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface CatalogServer {
  server: string;
  provenance: string;
  method: 'tools/list';
  tools: CatalogTool[];
}

const TMP = path.join(os.tmpdir(), 'agent-discover-retrieval');
mkdirSync(TMP, { recursive: true });
const VARS: Record<string, string> = {
  PY: process.env.W1_VENV
    ? path.join(process.env.W1_VENV, process.platform === 'win32' ? 'Scripts' : 'bin')
    : '',
  GOBIN: process.env.W1_GOBIN ?? '',
  TMP: TMP.replace(/\\/g, '/'),
};
const run = promisify(execFile);
// npm resolution/installs go straight to the public registry so a slow
// user-level mirror can't stall extraction (override: W1_NPM_REGISTRY).
const REGISTRY = `--registry=${process.env.W1_NPM_REGISTRY ?? 'https://registry.npmjs.org/'}`;
const sub = (s: string) => s.replace(/\$\{(\w+)\}/g, (_, k: string) => VARS[k] ?? '');

async function npmVersion(spec: string): Promise<string> {
  const { stdout } = await run('npm', ['view', spec, 'version', '--json', REGISTRY], {
    shell: true,
  });
  const v = JSON.parse(stdout.trim()) as string | string[];
  return Array.isArray(v) ? v[v.length - 1] : v;
}

function pipVersion(pkg: string): string {
  const py = path.join(VARS.PY, 'python');
  const out = execFileSync(py, ['-m', 'pip', 'show', pkg], { encoding: 'utf8' });
  return /^Version:\s*(\S+)/m.exec(out)?.[1] ?? 'unknown';
}

/** Install an npm server into its own cache dir; returns [command, args-prefix, env]. */
async function npmInstall(
  spec: ServerSpec,
  version: string,
): Promise<[string, string[], Record<string, string>]> {
  const pkg = spec.package;
  const dir = path.join(TMP, 'npm', pkg.replace(/[@/]/g, '_'));
  const pj = path.join(dir, 'node_modules', ...pkg.split('/'), 'package.json');
  if (!existsSync(pj)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), '{"private":true}');
    const pkgs = [`${pkg}@${version}`, ...(spec.deps ?? [])];
    await run('npm', ['install', '--no-audit', '--no-fund', REGISTRY, ...pkgs], {
      cwd: dir,
      shell: true,
      env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: '1' },
    });
  }
  if (spec.launcher) {
    const launcher = path.join(HERE, spec.launcher);
    return [process.execPath, ['--import', 'tsx', launcher], { W1_PKG_DIR: dir }];
  }
  const meta = JSON.parse(readFileSync(pj, 'utf8')) as { bin?: string | Record<string, string> };
  const bin = typeof meta.bin === 'string' ? meta.bin : Object.values(meta.bin ?? {})[0];
  if (!bin) throw new Error(`${pkg} has no bin`);
  return [process.execPath, [path.join(path.dirname(pj), bin)], {}];
}

function goVersion(binary: string): string {
  const exe = process.platform === 'win32' && !binary.endsWith('.exe') ? `${binary}.exe` : binary;
  const out = execFileSync('go', ['version', '-m', exe], { encoding: 'utf8' });
  return /^\s*mod\s+\S+\s+(\S+)/m.exec(out)?.[1] ?? 'unknown';
}

async function listTools(spec: ServerSpec, version: string): Promise<CatalogTool[]> {
  let command = sub(spec.command ?? '');
  let args = (spec.args ?? []).map(sub);
  let installEnv: Record<string, string> = {};
  if (spec.runtime === 'npm' && !spec.command) {
    const [cmd, prefix, extra] = await npmInstall(spec, version);
    command = cmd;
    args = [...prefix, ...args];
    installEnv = extra;
  }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...installEnv,
    PUPPETEER_SKIP_DOWNLOAD: '1',
    ...Object.fromEntries(Object.entries(spec.env ?? {}).map(([k, v]) => [k, sub(v)])),
  };
  const transport = new StdioClientTransport({ command, args, env, stderr: 'ignore' });
  const client = new Client({ name: 'retrieval-bench-extract', version: '1.0.0' });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`hard timeout after ${SPAWN_TIMEOUT_MS}ms`)),
      SPAWN_TIMEOUT_MS,
    );
  });
  const work = async () => {
    await client.connect(transport, TIMEOUT);
    const tools: CatalogTool[] = [];
    let cursor: string | undefined;
    do {
      const res = await client.request(
        { method: 'tools/list', params: cursor ? { cursor } : {} },
        LenientToolsResult,
        TIMEOUT,
      );
      for (const t of res.tools) {
        tools.push({
          name: t.name,
          description: t.description ?? '',
          inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
        });
      }
      cursor = res.nextCursor;
    } while (cursor);
    return tools;
  };
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer);
    // Kill the whole process tree first: a hung server (or the npm/python
    // launcher above it) can otherwise make close() block indefinitely.
    killTree(transport.pid);
    void client.close().catch(() => undefined);
  }
}

function killTree(pid: number | null) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

async function extract(spec: ServerSpec): Promise<CatalogServer> {
  let version = 'unknown';
  if (spec.runtime === 'npm') version = spec.version ?? (await npmVersion(spec.package));
  else if (spec.runtime === 'pip') version = pipVersion(spec.package);
  else if (spec.runtime === 'go') version = goVersion(sub(spec.command!));
  const pkgName = spec.runtime === 'go' ? spec.package.split('@')[0] : spec.package;
  const tools = await listTools(spec, version);
  return {
    server: spec.id,
    provenance: `${spec.runtime}:${pkgName.replace(/@[^@/]*$/, '') || pkgName}@${version}`,
    method: 'tools/list',
    tools,
  };
}

async function main() {
  const only = process.argv
    .find((a) => a.startsWith('--only='))
    ?.slice(7)
    .split(',');
  const specs = (
    JSON.parse(readFileSync(path.join(HERE, 'servers.json'), 'utf8')) as ServerSpec[]
  ).filter((s) => !only || only.includes(s.id));
  const prev: CatalogServer[] = existsSync(OUT)
    ? (JSON.parse(readFileSync(OUT, 'utf8')) as { servers: CatalogServer[] }).servers
    : [];
  const byId = new Map(prev.map((s) => [s.server, s]));

  const wanted = new Set(
    (JSON.parse(readFileSync(path.join(HERE, 'servers.json'), 'utf8')) as ServerSpec[]).map(
      (s) => s.id,
    ),
  );
  const save = () => {
    const servers = [...byId.values()]
      .filter((s) => wanted.has(s.server))
      .sort((a, b) => a.server.localeCompare(b.server))
      .map((s) => ({ ...s, tools: [...s.tools].sort((a, b) => a.name.localeCompare(b.name)) }));
    writeFileSync(OUT, toJson({ version: 1, servers }));
    return servers;
  };

  const queue = [...specs];
  const failures: string[] = [];
  const worker = async () => {
    for (let spec = queue.shift(); spec; spec = queue.shift()) {
      try {
        const s = await extract(spec);
        if (s.tools.length === 0) throw new Error('zero tools');
        byId.set(s.server, s);
        save();
        console.warn(`ok   ${spec.id.padEnd(28)} ${s.tools.length} tools  ${s.provenance}`);
      } catch (err) {
        failures.push(spec.id);
        console.warn(`FAIL ${spec.id.padEnd(28)} ${(err as Error).message.slice(0, 120)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.W1_CONCURRENCY ?? 6) }, worker));

  const servers = save();
  const total = servers.reduce((n, s) => n + s.tools.length, 0);
  console.warn(`\n${servers.length} servers, ${total} tools -> ${OUT}`);
  if (failures.length) console.warn(`failed: ${failures.join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
