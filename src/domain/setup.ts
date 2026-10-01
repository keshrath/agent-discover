// =============================================================================
// agent-discover — Declarative setup file
//
// JSON file (AGENT_DISCOVER_SETUP_FILE, plus an optional sibling
// `*.local.json`) listing servers to ensure-installed on daemon start.
// Operator-authored, so installs from it need no interactive consent.
// Idempotent: existing servers are kept; secrets are re-synced; `enabled:
// true` enables. `$ENV_VAR` references in env/secrets resolve at sync time.
// =============================================================================

import { readFileSync, existsSync } from 'fs';
import type { ServerLifecycle } from './lifecycle.js';

export interface SetupServerEntry {
  name: string;
  description?: string;
  transport?: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  tags?: string[];
  secrets?: Record<string, string>;
  enabled?: boolean;
  sandbox?: 'none' | 'docker';
  sandbox_network?: boolean;
}

export interface SetupFile {
  servers: SetupServerEntry[];
}

export interface SyncResult {
  registered: string[];
  enabled: string[];
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
}

function resolveEnvRefs(value: string): string {
  return value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name) => process.env[name] ?? '');
}

function resolveEnvMap(map: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, resolveEnvRefs(v)]));
}

export function getSetupFilePath(): string | null {
  return process.env.AGENT_DISCOVER_SETUP_FILE ?? null;
}

export function readSetupFile(filePath: string): SetupFile {
  const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as { servers?: unknown };
  if (!Array.isArray(parsed.servers))
    throw new Error(`setup file missing "servers" array: ${filePath}`);
  for (const entry of parsed.servers as Array<Record<string, unknown>>) {
    if ('auto_activate' in entry) {
      throw new Error(
        `setup file ${filePath}: "${String(entry.name)}" uses "auto_activate", renamed to "enabled" in 2.0`,
      );
    }
  }
  return parsed as SetupFile;
}

async function syncSingleFile(
  lifecycle: ServerLifecycle,
  path: string,
  result: SyncResult,
): Promise<void> {
  let setup: SetupFile;
  try {
    setup = readSetupFile(path);
  } catch (err) {
    result.errors.push({ name: path, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  for (const entry of setup.servers) {
    if (!entry.name) {
      result.errors.push({ name: '(unnamed)', error: 'missing name field' });
      continue;
    }
    try {
      const resolvedSecrets = Object.fromEntries(
        Object.entries(resolveEnvMap(entry.secrets)).filter(([, v]) => v),
      );
      const existing = lifecycle.get(entry.name);
      if (!existing) {
        const { index_error } = await lifecycle.install(
          {
            name: entry.name,
            description: entry.description,
            source: 'setup-file',
            transport: entry.transport ?? 'stdio',
            command: entry.command,
            args: entry.args,
            env: resolveEnvMap(entry.env),
            url: entry.url,
            headers: entry.headers,
            tags: entry.tags,
            sandbox: entry.sandbox,
            sandbox_network: entry.sandbox_network,
          },
          { secrets: resolvedSecrets },
        );
        result.registered.push(entry.name);
        if (index_error)
          result.errors.push({ name: entry.name, error: `index failed: ${index_error}` });
      } else {
        for (const [key, value] of Object.entries(resolvedSecrets)) {
          await lifecycle.setSecret(existing.name, key, value);
        }
        result.skipped.push(entry.name);
      }
      if (entry.enabled && !lifecycle.get(entry.name)!.enabled) {
        await lifecycle.enable(entry.name);
        result.enabled.push(entry.name);
      }
    } catch (err) {
      result.errors.push({
        name: entry.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function syncSetupFile(
  lifecycle: ServerLifecycle,
  filePath?: string,
): Promise<SyncResult> {
  const result: SyncResult = { registered: [], enabled: [], skipped: [], errors: [] };
  const basePath = filePath ?? getSetupFilePath();
  if (!basePath) return result;
  if (!existsSync(basePath)) {
    result.errors.push({ name: basePath, error: 'setup file not found' });
    return result;
  }
  await syncSingleFile(lifecycle, basePath, result);
  const localPath = basePath.replace(/\.json$/, '.local.json');
  if (localPath !== basePath && existsSync(localPath)) {
    await syncSingleFile(lifecycle, localPath, result);
  }
  if (result.registered.length + result.enabled.length + result.errors.length > 0) {
    process.stderr.write(
      `[agent-discover] setup sync (${basePath}): ${result.registered.length} registered, ${result.enabled.length} enabled, ${result.skipped.length} skipped, ${result.errors.length} errors\n`,
    );
  }
  return result;
}
