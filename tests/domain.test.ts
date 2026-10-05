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
    const index = new ToolIndex(db, { embeddings: async () => new NoopEmbeddingProvider() });
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
    const index = new ToolIndex(db, { embeddings: async () => new NoopEmbeddingProvider() });
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
      async embed(texts) {
        calls += texts.length;
        return texts.map((t) => (t.includes('slack') ? [1, 0] : [0, 1]));
      },
    };
    const index = new ToolIndex(db, { embeddings: async () => provider });
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

describe('HybridRanker', () => {
  const lexical = () => new ToolIndex(db, { embeddings: async () => new NoopEmbeddingProvider() });

  it('matches mixed-case words whole and split, and repairs typos', async () => {
    const index = lexical();
    const s = servers.create({ name: 'gl', command: 'x' });
    await index.save(s.id, [
      { name: 'search_repositories', description: 'Search for GitLab projects' },
      { name: 'create_issue', description: 'Create an issue' },
    ]);
    for (const q of ['gitlab projects', 'GitLab projects', 'git lab projects', 'gitlab projetcs']) {
      expect((await index.search(q, 1))[0]?.name, q).toBe('search_repositories');
    }
    expect(await index.search('zzzz qqqq', 5)).toEqual([]); // nothing matches → no hits
  });

  it('confines the ranking toward a server the query names', async () => {
    const index = lexical();
    const a = servers.create({ name: 'linear', command: 'x' });
    const b = servers.create({ name: 'jira', command: 'x' });
    await index.save(a.id, [{ name: 'create_ticket', description: 'Create a ticket' }]);
    await index.save(b.id, [{ name: 'create_ticket', description: 'Create a new ticket' }]);
    expect((await index.search('create a ticket in jira', 2))[0].server).toBe('jira');
    expect((await index.search('create a ticket in linear', 2))[0].server).toBe('linear');
  });

  it('boosts tools that are actually called (usage prior from metrics)', async () => {
    const index = lexical();
    const a = servers.create({ name: 'a', command: 'x' });
    const b = servers.create({ name: 'b', command: 'x' });
    const tools = [{ name: 'list_items', description: 'List items' }];
    await index.save(a.id, tools);
    await index.save(b.id, tools);
    const before = await index.search('list items', 2);
    const loser = before[1];
    db.run('INSERT INTO server_metrics (server_id, tool_name, call_count) VALUES (?, ?, 50)', [
      loser.server_id,
      loser.name,
    ]);
    const after = await index.search('list items', 2);
    expect(after[0].id).toBe(loser.id);
    expect(after[0].score).toBeLessThanOrEqual(1);
  });
});
