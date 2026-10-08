// =============================================================================
// agent-discover — Secret backends
//
// Secret VALUES never live in SQLite. The DB keeps key names plus the backend
// that holds them; values go to one of:
//   - keyring: the OS credential store via @napi-rs/keyring (optional dep),
//     service "agent-discover", account "<server>/<KEY>" (values over 1280
//     chars continue in "<server>/<KEY>#0..n");
//   - file:    AES-256-GCM encrypted JSON next to the DB, key in a 0600 key
//     file (headless Linux without a secret service, or forced);
//   - memory:  process-lifetime map, for ':memory:' databases (tests, embeds).
// Selection: AGENT_DISCOVER_SECRETS=keyring|file forces one; otherwise the
// keychain when it answers a probe, else the encrypted file. The choice is
// logged once per process.
// =============================================================================

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const KEYRING_SERVICE = 'agent-discover';

export interface SecretBackend {
  readonly name: 'keyring' | 'file' | 'memory';
  get(account: string): string | null;
  set(account: string, value: string): void;
  delete(account: string): void;
}

export function secretAccount(server: string, key: string): string {
  return `${server}/${key}`;
}

export class MemorySecretBackend implements SecretBackend {
  readonly name = 'memory' as const;
  private readonly values = new Map<string, string>();
  get(account: string): string | null {
    return this.values.get(account) ?? null;
  }
  set(account: string, value: string): void {
    this.values.set(account, value);
  }
  delete(account: string): void {
    this.values.delete(account);
  }
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}
type KeyringModule = { Entry: new (service: string, account: string) => KeyringEntry };

/** Windows caps a credential at 2560 bytes of UTF-16; longer values span numbered entries. */
const KEYRING_CHUNK = 1280;
/** Head entry of a split value; env values and JSON never start with NUL. */
const CHUNKED = '\u0000chunks:';

function splitValue(value: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < value.length; ) {
    let end = Math.min(i + KEYRING_CHUNK, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--; // keep surrogate pairs whole
    parts.push(value.slice(i, end));
    i = end;
  }
  return parts;
}

export class KeyringSecretBackend implements SecretBackend {
  readonly name = 'keyring' as const;
  constructor(private readonly mod: KeyringModule) {}
  private entry(account: string, chunk?: number): KeyringEntry {
    return new this.mod.Entry(
      KEYRING_SERVICE,
      chunk === undefined ? account : `${account}#${chunk}`,
    );
  }
  private chunkCount(head: string | null): number {
    return head?.startsWith(CHUNKED) ? Number(head.slice(CHUNKED.length)) : 0;
  }
  private dropChunks(account: string, from: number, to: number): void {
    for (let i = from; i < to; i++) this.entry(account, i).deletePassword();
  }
  get(account: string): string | null {
    const head = this.entry(account).getPassword() ?? null;
    const count = this.chunkCount(head);
    if (count === 0) return head;
    let value = '';
    for (let i = 0; i < count; i++) {
      const part = this.entry(account, i).getPassword();
      if (part === null) return null;
      value += part;
    }
    return value;
  }
  set(account: string, value: string): void {
    const before = this.chunkCount(this.entry(account).getPassword());
    const parts = value.length > KEYRING_CHUNK ? splitValue(value) : [];
    parts.forEach((part, i) => this.entry(account, i).setPassword(part));
    this.entry(account).setPassword(parts.length ? `${CHUNKED}${parts.length}` : value);
    this.dropChunks(account, parts.length, before);
  }
  delete(account: string): void {
    const count = this.chunkCount(this.entry(account).getPassword());
    this.entry(account).deletePassword();
    this.dropChunks(account, 0, count);
  }
}

interface Sealed {
  iv: string;
  tag: string;
  data: string;
}

/** AES-256-GCM per value; the whole map is rewritten atomically (tmp + rename), mode 0600. */
export class EncryptedFileSecretBackend implements SecretBackend {
  readonly name = 'file' as const;
  private readonly key: Buffer;

  constructor(
    readonly path: string,
    keyPath: string,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(keyPath)) {
      writeFileSync(keyPath, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
    }
    this.key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64');
    if (this.key.length !== 32) throw new Error(`secret key file ${keyPath} is corrupt`);
  }

  private load(): Record<string, Sealed> {
    return existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, Sealed>)
      : {};
  }

  private save(map: Record<string, Sealed>): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(map), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  get(account: string): string | null {
    const sealed = this.load()[account];
    if (!sealed) return null;
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(Buffer.from(account));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  set(account: string, value: string): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(account));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const map = this.load();
    map[account] = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    this.save(map);
  }

  delete(account: string): void {
    const map = this.load();
    if (!(account in map)) return;
    delete map[account];
    this.save(map);
  }
}

function loadKeyring(): KeyringSecretBackend {
  const mod = createRequire(import.meta.url)('@napi-rs/keyring') as KeyringModule;
  const backend = new KeyringSecretBackend(mod);
  backend.get('__probe__'); // throws when no credential store is reachable
  return backend;
}

let announced = false;

function fileBackend(dbPath: string): EncryptedFileSecretBackend {
  const dir = dirname(dbPath);
  return new EncryptedFileSecretBackend(
    join(dir, 'agent-discover-secrets.json'),
    join(dir, 'agent-discover-secrets.key'),
  );
}

/**
 * Open a named backend for the database at `dbPath` so secrets stored there can move to the
 * active one; null when it cannot be reached (no keychain on this machine).
 */
export function openSecretBackend(name: string, dbPath: string): SecretBackend | null {
  try {
    if (name === 'keyring') return loadKeyring();
    if (name === 'file') return fileBackend(dbPath);
  } catch {
    /* unreachable store: its secrets stay where they are */
  }
  return null;
}

/** Pick the backend for a database at `dbPath` (see header). */
export function resolveSecretBackend(
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env,
): SecretBackend {
  if (dbPath === ':memory:') return new MemorySecretBackend();
  const forced = env.AGENT_DISCOVER_SECRETS;
  let backend: SecretBackend | undefined;
  let why = '';
  if (forced !== 'file') {
    try {
      backend = loadKeyring();
    } catch (err) {
      if (forced === 'keyring') throw err;
      why = ` (keychain unavailable: ${err instanceof Error ? err.message : String(err)})`;
    }
  }
  const dir = dirname(dbPath);
  backend ??= fileBackend(dbPath);
  if (!announced) {
    announced = true;
    process.stderr.write(
      `[agent-discover] secrets backend: ${backend.name === 'keyring' ? 'OS keychain' : `encrypted file in ${dir}${why}`}\n`,
    );
  }
  return backend;
}
