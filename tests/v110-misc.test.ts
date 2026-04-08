// =============================================================================
// agent-discover — v1.1.0 misc coverage
//
// - Hydration failure path: a row marked active=1 with no usable command
//   should be cleared on context boot (so we don't retry forever).
// - /api/prereqs endpoint shape (real spawn against the host).
// - Registry resilience to malformed args/env JSON in the DB.
// - Installer: scoped npm names, unicode rejection.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync } from 'fs';
import { createContext, type AppContext } from '../src/context.js';
import { createRouter } from '../src/transport/rest.js';
import { createDb } from '../src/storage/database.js';
import { InstallerService } from '../src/domain/installer.js';
import { ValidationError } from '../src/types.js';

describe('Hydration failure path', () => {
  it('clears active=1 for rows that fail to activate on boot', async () => {
    // Seed a real temp DB with an active+installed server that has NO command.
    // On context boot, hydration will hit createTransport's "no command" guard,
    // throw inside activate(), and the catch branch must clear active=0 so we
    // don't loop forever on every restart. We use a file path (not :memory:)
    // because seeding and the context need to share the same physical DB.
    const path = join(tmpdir(), `agent-discover-hydration-${Date.now()}.db`);
    const seed = createDb({ path });
    seed.run(
      `INSERT INTO servers (name, source, args, env, tags, transport, installed, active)
       VALUES (?, 'local', '[]', '{}', '[]', 'stdio', 1, 1)`,
      ['stale-active'],
    );
    seed.close();

    const ctx = createContext({ path });
    try {
      // Hydration is a fire-and-forget IIFE inside createContext — poll for the
      // side effect (active flag clears) rather than awaiting an internal promise.
      const deadline = Date.now() + 3_000;
      let server = ctx.registry.getByName('stale-active');
      while (Date.now() < deadline && server && server.active) {
        await new Promise((r) => setTimeout(r, 50));
        server = ctx.registry.getByName('stale-active');
      }
      expect(server).toBeTruthy();
      expect(server!.active).toBe(false);
      // And the in-memory proxy must NOT have a phantom entry for it.
      expect(ctx.proxy.isActive('stale-active')).toBe(false);
    } finally {
      ctx.close();
      try {
        unlinkSync(path);
      } catch {
        /* best-effort */
      }
    }
  }, 10_000);
});

describe('GET /api/prereqs', () => {
  let ctx: AppContext;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    ctx = createContext({ path: ':memory:' });
    server = createServer(createRouter(ctx));
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    ctx.close();
  });

  it('detects npx (which must exist since the test runs under npm)', async () => {
    const res = await fetch(`${baseUrl}/api/prereqs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.npx).toBe('boolean');
    expect(typeof body.uvx).toBe('boolean');
    expect(typeof body.docker).toBe('boolean');
    expect(typeof body.uv).toBe('boolean');
    // npx ships with Node and the test runner uses npm, so this is a real
    // positive assertion — proves probe() actually exits 0 on success rather
    // than always returning false. The other three are environment-dependent.
    expect(body.npx).toBe(true);
  }, 15_000);
});

describe('Registry resilience to malformed JSON columns', () => {
  // rowToServer JSON.parses args/env/tags. If any of them gets corrupted on
  // disk (manual edit, partial write, schema migration bug), the registry
  // must surface a SyntaxError synchronously on the next read rather than
  // returning a partially-decoded ServerEntry that crashes downstream code.
  let ctx: AppContext;
  beforeEach(() => {
    ctx = createContext({ path: ':memory:' });
  });
  afterEach(() => ctx.close());

  it('surfaces SyntaxError when args column is not valid JSON', () => {
    ctx.db.run(
      `INSERT INTO servers (name, source, command, args, env, tags, transport, installed)
       VALUES (?, 'local', 'node', ?, '{}', '[]', 'stdio', 1)`,
      ['bad-args', 'definitely not json'],
    );
    expect(() => ctx.registry.getByName('bad-args')).toThrow(SyntaxError);
  });

  it('surfaces SyntaxError when env column is not valid JSON', () => {
    ctx.db.run(
      `INSERT INTO servers (name, source, command, args, env, tags, transport, installed)
       VALUES (?, 'local', 'node', '[]', ?, '[]', 'stdio', 1)`,
      ['bad-env', '{not: valid}'],
    );
    expect(() => ctx.registry.getByName('bad-env')).toThrow(SyntaxError);
  });
});

describe('InstallerService — edge cases', () => {
  const inst = new InstallerService();

  it('accepts scoped npm package names', () => {
    const c = inst.detectInstallConfig('@modelcontextprotocol/server-everything');
    expect(c.command).toBe('npx');
    expect(c.args).toEqual(['-y', '@modelcontextprotocol/server-everything']);
    expect(c.transport).toBe('stdio');
  });

  it('routes runtime=python to uvx', () => {
    const c = inst.detectInstallConfig('mcp-server-time', 'python');
    expect(c.command).toBe('uvx');
    expect(c.args).toEqual(['mcp-server-time']);
  });

  it('routes runtime=docker to docker run', () => {
    const c = inst.detectInstallConfig('myimg', 'docker');
    expect(c.command).toBe('docker');
    expect(c.args).toEqual(['run', '-i', '--rm', 'myimg']);
  });

  it('rejects unicode and shell metacharacters', () => {
    expect(() => inst.detectInstallConfig('hello;rm -rf /')).toThrow(ValidationError);
    expect(() => inst.detectInstallConfig('пакет')).toThrow(ValidationError);
    expect(() => inst.detectInstallConfig('foo bar')).toThrow(ValidationError);
    expect(() => inst.detectInstallConfig('')).toThrow(ValidationError);
  });

  it('strips uvx- and docker- prefixes from package names', () => {
    expect(inst.detectInstallConfig('uvx-mcp-server-time').args).toEqual(['mcp-server-time']);
    expect(inst.detectInstallConfig('docker-myimg').args).toEqual(['run', '-i', '--rm', 'myimg']);
  });
});
