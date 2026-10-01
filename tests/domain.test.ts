// =============================================================================
// ServerStore / toConfig / ToolIndex / Ranker unit tests
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from '../src/storage/database.js';
import { ServerStore, toConfig } from '../src/domain/servers.js';
import { ToolIndex } from '../src/domain/tool-index.js';
import { toolHash } from '../src/domain/tool-hash.js';
import { NoopEmbeddingProvider, type EmbeddingProvider } from '../src/embeddings/index.js';
import { splitToolName } from '../src/domain/lifecycle.js';

let db: Db;
let servers: ServerStore;

beforeEach(() => {
  db = createDb({ path: ':memory:' });
  servers = new ServerStore(db);
});

describe('ServerStore', () => {
  it('validates names and transport shape', () => {
    expect(() => servers.create({ name: 'a__b', command: 'x' })).toThrow(/__/);
    expect(() => servers.create({ name: 'bad name', command: 'x' })).toThrow(/Invalid name/);
    expect(() => servers.create({ name: 'nocmd' })).toThrow(/command is required/);
    expect(() => servers.create({ name: 'r', transport: 'sse' })).toThrow(/url is required/);
    expect(() => servers.create({ name: 'r', transport: 'sse', url: 'ftp://x' })).toThrow(/http/);
    expect(() =>
      servers.create({
        name: 'h',
        transport: 'sse',
        url: 'https://x',
        headers: { 'X-A': 'a\r\nb' },
      }),
    ).toThrow(/header/);
  });

  it('stores remote url in its own column', () => {
    const s = servers.create({
      name: 'r',
      transport: 'streamable-http',
      url: 'https://x/mcp',
      homepage: 'https://docs',
    });
    expect(s.url).toBe('https://x/mcp');
    expect(s.homepage).toBe('https://docs');
    expect(s.command).toBeNull();
  });
});

describe('toConfig', () => {
  it('merges secrets into the stdio env', () => {
    const s = servers.create({ name: 'l', command: 'node', args: ['a'], env: { A: '1' } });
    expect(toConfig(s, { TOKEN: 't' })).toMatchObject({
      command: 'node',
      args: ['a'],
      env: { A: '1', TOKEN: 't' },
    });
  });

  it('sends only declared headers plus Authorization for remote servers', () => {
    const s = servers.create({
      name: 'r',
      transport: 'sse',
      url: 'https://x',
      headers: { 'X-Api-Key': '' },
    });
    const cfg = toConfig(s, { 'x-api-key': 'secret', API_KEY: 'k', DATABASE_PASSWORD: 'never' });
    expect(cfg.headers).toEqual({ 'X-Api-Key': 'secret', Authorization: 'Bearer k' });
    expect(JSON.stringify(cfg)).not.toContain('never');
  });

  it('prefers the AUTHORIZATION secret verbatim', () => {
    const s = servers.create({ name: 'r', transport: 'sse', url: 'https://x' });
    expect(toConfig(s, { AUTHORIZATION: 'Basic abc', API_KEY: 'k' }).headers).toEqual({
      Authorization: 'Basic abc',
    });
  });
});

describe('splitToolName', () => {
  it('splits at the first separator (server names never contain __)', () => {
    expect(splitToolName('srv__tool__with__parts')).toEqual({
      server: 'srv',
      tool: 'tool__with__parts',
    });
    expect(splitToolName('nosep')).toBeNull();
    expect(splitToolName('__x')).toBeNull();
  });
});

describe('ToolIndex', () => {
  const tools = [
    {
      name: 'slack_post_message',
      description: 'Post a message to a Slack channel',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    },
    {
      name: 'github_create_issue',
      description: 'Create an issue in a GitHub repo',
      annotations: { destructiveHint: false },
    },
  ];

  it('diffs by tool hash and keeps ids stable', async () => {
    const index = new ToolIndex(db, async () => new NoopEmbeddingProvider());
    const s = servers.create({ name: 'a', command: 'x' });
    expect(await index.save(s.id, tools)).toMatchObject({
      added: ['slack_post_message', 'github_create_issue'],
      removed: [],
      changed: [],
    });
    const before = index.get('a', 'slack_post_message')!;
    expect(before.tool_hash).toBe(toolHash(tools[0]));

    const diff = await index.save(s.id, [{ ...tools[0], description: 'changed' }]);
    expect(diff).toMatchObject({
      added: [],
      changed: ['slack_post_message'],
      removed: ['github_create_issue'],
      unchanged: 0,
    });
    expect(index.get('a', 'slack_post_message')!.id).toBe(before.id);
    expect(index.get('a', 'github_create_issue')).toBeNull();
  });

  it('search scores are normalized to 0..1 and rank name matches first', async () => {
    const index = new ToolIndex(db, async () => new NoopEmbeddingProvider());
    const s = servers.create({ name: 'a', command: 'x' });
    await index.save(s.id, tools);
    const hits = await index.search('post slack message', 5);
    expect(hits[0].name).toBe('slack_post_message');
    for (const h of hits) {
      expect(h.score).toBeGreaterThanOrEqual(0);
      expect(h.score).toBeLessThanOrEqual(1);
    }
    expect(await index.search('   ')).toEqual([]);
  });

  it('computes embeddings in the single save path and reuses them by hash', async () => {
    let calls = 0;
    const provider: EmbeddingProvider = {
      name: 'fake',
      model: 'fake-1',
      dimensions: 2,
      async embed(texts) {
        calls += texts.length;
        return texts.map((t) => (t.includes('slack') ? [1, 0] : [0, 1]));
      },
      async embedOne() {
        return [1, 0];
      },
      async isAvailable() {
        return true;
      },
    };
    const index = new ToolIndex(db, async () => provider);
    const a = servers.create({ name: 'a', command: 'x' });
    const b = servers.create({ name: 'b', command: 'x' });
    expect((await index.save(a.id, tools)).embedded).toBe(2);
    expect(calls).toBe(2);
    expect((await index.save(b.id, tools)).embedded).toBe(2); // same hashes → cached vectors
    expect(calls).toBe(2);
    await index.save(a.id, tools); // unchanged → nothing to do
    expect(calls).toBe(2);
    const hits = await index.search('chat', 2);
    expect(hits[0].name).toBe('github_create_issue'); // purely semantic: "chat" embeds to [0,1]
  });
});
