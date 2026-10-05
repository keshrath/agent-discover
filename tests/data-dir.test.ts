// =============================================================================
// Default DB location: host-neutral data dir, env overrides, one-time move of
// the 1.x ~/.claude database (with WAL/SHM and the file secret store).
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { dataDir } from '../src/config.js';
import { resolveDbPath } from '../src/storage/database.js';

const dirs: string[] = [];
function fakeHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'agent-discover-home-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('dataDir', () => {
  it('uses the platform default per user', () => {
    expect(dataDir({ LOCALAPPDATA: 'L:/Local' }, 'win32', 'H:/me')).toBe(
      join('L:/Local', 'agent-discover'),
    );
    expect(dataDir({}, 'win32', 'H:/me')).toBe(join('H:/me', 'AppData', 'Local', 'agent-discover'));
    expect(dataDir({}, 'darwin', '/Users/me')).toBe(
      join('/Users/me', 'Library', 'Application Support', 'agent-discover'),
    );
    expect(dataDir({ XDG_DATA_HOME: '/xdg' }, 'linux', '/home/me')).toBe(
      join('/xdg', 'agent-discover'),
    );
    expect(dataDir({}, 'linux', '/home/me')).toBe(
      join('/home/me', '.local', 'share', 'agent-discover'),
    );
  });

  it('AGENT_DISCOVER_DATA_DIR wins', () => {
    expect(dataDir({ AGENT_DISCOVER_DATA_DIR: '/data', LOCALAPPDATA: 'x' }, 'win32', 'h')).toBe(
      '/data',
    );
  });
});

describe('resolveDbPath', () => {
  it('a fresh install creates the data dir and uses it', () => {
    const home = fakeHome();
    const path = resolveDbPath(undefined, { XDG_DATA_HOME: join(home, 'xdg') }, 'linux', home);
    expect(path).toBe(join(home, 'xdg', 'agent-discover', 'agent-discover.db'));
    expect(existsSync(join(home, 'xdg', 'agent-discover'))).toBe(true);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('AGENT_DISCOVER_DB and an explicit path override the data dir', () => {
    const home = fakeHome();
    expect(resolveDbPath('/x.db', { AGENT_DISCOVER_DB: '/y.db' }, 'linux', home)).toBe('/x.db');
    expect(resolveDbPath(undefined, { AGENT_DISCOVER_DB: '/y.db' }, 'linux', home)).toBe('/y.db');
  });

  it('moves the 1.x database and its companions out of ~/.claude once', () => {
    const home = fakeHome();
    const legacy = join(home, '.claude');
    mkdirSync(legacy);
    const db = new Database(join(legacy, 'agent-discover.db'));
    db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept')");
    db.close();
    for (const f of ['-wal', '-shm']) writeFileSync(join(legacy, `agent-discover.db${f}`), '');
    writeFileSync(join(legacy, 'agent-discover-secrets.json'), '{"a":1}');
    writeFileSync(join(legacy, 'agent-discover-secrets.key'), 'k');
    const env = { XDG_DATA_HOME: join(home, 'xdg') };
    const data = join(home, 'xdg', 'agent-discover');

    const path = resolveDbPath(undefined, env, 'linux', home);
    expect(path).toBe(join(data, 'agent-discover.db'));
    for (const f of [
      'agent-discover.db',
      'agent-discover.db-wal',
      'agent-discover.db-shm',
      'agent-discover-secrets.json',
      'agent-discover-secrets.key',
    ]) {
      expect(existsSync(join(data, f))).toBe(true);
      expect(existsSync(join(legacy, f))).toBe(false);
    }
    expect(readFileSync(join(data, 'agent-discover-secrets.json'), 'utf8')).toBe('{"a":1}');
    const moved = new Database(path, { readonly: true });
    expect(moved.prepare('SELECT v FROM t').get()).toEqual({ v: 'kept' });
    moved.close();

    // A new legacy file appearing later is ignored: the data dir DB exists.
    writeFileSync(join(legacy, 'agent-discover.db'), '');
    expect(resolveDbPath(undefined, env, 'linux', home)).toBe(path);
    expect(existsSync(join(legacy, 'agent-discover.db'))).toBe(true);
  });

  it('never adopts the 1.x database into an explicit AGENT_DISCOVER_DATA_DIR', () => {
    const home = fakeHome();
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', 'agent-discover.db'), '');
    const env = { AGENT_DISCOVER_DATA_DIR: join(home, 'data') };
    expect(resolveDbPath(undefined, env, 'linux', home)).toBe(
      join(home, 'data', 'agent-discover.db'),
    );
    expect(existsSync(join(home, '.claude', 'agent-discover.db'))).toBe(true);
    expect(existsSync(join(home, 'data', 'agent-discover.db'))).toBe(false);
  });

  it('refuses to take the 1.x database while another process has it open', async () => {
    const home = fakeHome();
    const legacy = join(home, '.claude', 'agent-discover.db');
    mkdirSync(join(home, '.claude'));
    const init = new Database(legacy);
    init.pragma('journal_mode = WAL');
    init.exec('CREATE TABLE t (v TEXT)');
    init.close();
    // A separate process: POSIX locks do not conflict within one process.
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const d = new (require('better-sqlite3'))(process.argv[1]); d.prepare('SELECT * FROM t').all(); console.log('open'); setInterval(() => {}, 1000);`,
        legacy,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      await new Promise((r) => holder.stdout!.once('data', r));
      const env = { XDG_DATA_HOME: join(home, 'xdg') };
      expect(() => resolveDbPath(undefined, env, 'linux', home)).toThrow(
        /in use by another process/,
      );
      expect(existsSync(legacy)).toBe(true);
      expect(existsSync(join(home, 'xdg', 'agent-discover', 'agent-discover.db'))).toBe(false);
    } finally {
      holder.kill();
      await new Promise((r) => holder.once('exit', r));
    }
  });
});
