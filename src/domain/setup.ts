// =============================================================================
// agent-discover — Declarative setup file
//
// Reads a JSON file listing servers to ensure-registered on startup.
// Path configured via AGENT_DISCOVER_SETUP_FILE env var.
// Idempotent: skips servers that already exist. Secrets with $ENV_VAR
// references are resolved at sync time and stored via SecretsService.
// =============================================================================

import { readFileSync, existsSync } from 'fs';
import type { RegistryService } from './registry.js';
import type { SecretsService } from './secrets.js';
import type { McpProxy } from './proxy.js';

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
  auto_activate?: boolean;
}

export interface SetupFile {
  servers: SetupServerEntry[];
}

function resolveEnvRefs(value: string): string {
  return value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name) => process.env[name] ?? '');
}

function resolveEnvMap(map: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    resolved[k] = resolveEnvRefs(v);
  }
  return resolved;
}

export function getSetupFilePath(): string | null {
  return process.env.AGENT_DISCOVER_SETUP_FILE ?? null;
}

export function readSetupFile(filePath: string): SetupFile | null {
  if (!existsSync(filePath)) {
    process.stderr.write(`[agent-discover] setup file not found: ${filePath}\n`);
    return null;
  }
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.servers || !Array.isArray(parsed.servers)) {
      process.stderr.write(`[agent-discover] setup file missing "servers" array: ${filePath}\n`);
      return null;
    }
    return parsed as SetupFile;
  } catch (err) {
    process.stderr.write(
      `[agent-discover] failed to read setup file: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

export interface SyncResult {
  registered: string[];
  activated: string[];
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
}

function mergeResults(target: SyncResult, source: SyncResult): void {
  target.registered.push(...source.registered);
  target.activated.push(...source.activated);
  target.skipped.push(...source.skipped);
  target.errors.push(...source.errors);
}

async function syncSingleFile(
  registry: RegistryService,
  secrets: SecretsService,
  proxy: McpProxy,
  path: string,
): Promise<SyncResult> {
  const setup = readSetupFile(path);
  if (!setup) return { registered: [], activated: [], skipped: [], errors: [] };

  const result: SyncResult = { registered: [], activated: [], skipped: [], errors: [] };

  for (const entry of setup.servers) {
    if (!entry.name) {
      result.errors.push({ name: '(unnamed)', error: 'missing name field' });
      continue;
    }

    try {
      const existing = registry.getByName(entry.name);

      if (!existing) {
        const env = entry.env ? resolveEnvMap(entry.env) : {};
        registry.register({
          name: entry.name,
          description: entry.description,
          source: 'setup-file',
          command: entry.command,
          args: entry.args,
          env,
          tags: entry.tags,
          transport: entry.transport ?? 'stdio',
          homepage: entry.url,
        });
        result.registered.push(entry.name);
      } else {
        result.skipped.push(entry.name);
      }

      // Sync secrets (always, even for existing servers — secrets may have changed)
      if (entry.secrets) {
        const server = registry.getByName(entry.name);
        if (server) {
          for (const [key, value] of Object.entries(entry.secrets)) {
            const resolved = resolveEnvRefs(value);
            if (resolved) {
              secrets.set(server.id, key, resolved);
            }
          }
        }
      }

      // Auto-activate if requested and not already active
      if (entry.auto_activate) {
        const server = registry.getByName(entry.name);
        if (server && !proxy.isActive(server.name)) {
          try {
            await proxy.activate({
              name: server.name,
              command: server.command ?? undefined,
              args: server.args,
              env: server.env,
              transport: server.transport,
              url: server.homepage ?? undefined,
            });
            registry.setActive(server.name, true);
            result.activated.push(entry.name);
          } catch (err) {
            result.errors.push({
              name: entry.name,
              error: `activation failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      }
    } catch (err) {
      result.errors.push({
        name: entry.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (result.registered.length > 0 || result.activated.length > 0 || result.errors.length > 0) {
    process.stderr.write(
      `[agent-discover] setup sync (${path}): ${result.registered.length} registered, ${result.activated.length} activated, ${result.skipped.length} skipped, ${result.errors.length} errors\n`,
    );
  }

  return result;
}

export async function syncSetupFile(
  registry: RegistryService,
  secrets: SecretsService,
  proxy: McpProxy,
  filePath?: string,
): Promise<SyncResult> {
  const basePath = filePath ?? getSetupFilePath();
  if (!basePath) return { registered: [], activated: [], skipped: [], errors: [] };

  const result = await syncSingleFile(registry, secrets, proxy, basePath);

  // Auto-read .local variant (gitignored, machine-specific servers with secrets)
  const localPath = basePath.replace(/\.json$/, '.local.json');
  if (localPath !== basePath && existsSync(localPath)) {
    const localResult = await syncSingleFile(registry, secrets, proxy, localPath);
    mergeResults(result, localResult);
  }

  return result;
}
