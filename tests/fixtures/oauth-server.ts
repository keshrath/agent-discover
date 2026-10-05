// =============================================================================
// In-process OAuth 2.1 authorization server + protected MCP resource server
// for tests: RFC 9728 resource metadata, RFC 8414 AS metadata (with
// authorization_response_iss_parameter_supported), DCR, PKCE S256, an
// authorize endpoint that "logs the user in" and redirects at once, a token
// endpoint, and an MCP endpoint that wants a Bearer token.
// =============================================================================

import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import * as z from 'zod';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

export interface MockOAuth {
  base: string;
  mcpUrl: string;
  /** Issuer the AS echoes as `iss` on redirects (tests swap it for a mix-up attack). */
  redirectIss: string;
  registrations: number;
  tokensIssued: number;
  close(): Promise<void>;
}

async function body(req: IncomingMessage): Promise<string> {
  let raw = '';
  for await (const c of req) raw += c;
  return raw;
}

export async function startMockOAuth(): Promise<MockOAuth> {
  const codes = new Map<string, { challenge: string; redirect: string; client: string }>();
  const tokens = new Set<string>();
  const clients = new Set<string>();
  const mcp = createMcpHandler(() => {
    const s = new McpServer({ name: 'secure', version: '1.0.0' });
    s.registerTool(
      'whoami',
      { description: 'Who is calling', inputSchema: z.object({}) },
      async () => ({ content: [{ type: 'text', text: 'authorized' }] }),
    );
    return s;
  });
  const mcpNode = toNodeHandler(mcp);

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', state.base);
    const send = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };
    switch (url.pathname) {
      case '/.well-known/oauth-protected-resource':
      case '/.well-known/oauth-protected-resource/mcp':
        return send(200, { resource: state.mcpUrl, authorization_servers: [state.base] });
      case '/.well-known/oauth-authorization-server':
        return send(200, {
          issuer: state.base,
          authorization_endpoint: `${state.base}/authorize`,
          token_endpoint: `${state.base}/token`,
          registration_endpoint: `${state.base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          authorization_response_iss_parameter_supported: true,
        });
      case '/register': {
        const meta = JSON.parse(await body(req)) as Record<string, unknown>;
        const id = `client-${randomUUID()}`;
        clients.add(id);
        state.registrations++;
        return send(201, { ...meta, client_id: id });
      }
      case '/authorize': {
        const q = url.searchParams;
        const client = q.get('client_id') ?? '';
        if (!clients.has(client) || q.get('code_challenge_method') !== 'S256') {
          return send(400, { error: 'invalid_request' });
        }
        const code = randomUUID();
        const redirect = q.get('redirect_uri') ?? '';
        codes.set(code, { challenge: q.get('code_challenge') ?? '', redirect, client });
        const target = new URL(redirect);
        target.searchParams.set('code', code);
        target.searchParams.set('state', q.get('state') ?? '');
        target.searchParams.set('iss', state.redirectIss);
        res.writeHead(302, { location: target.href });
        return res.end();
      }
      case '/token': {
        const p = new URLSearchParams(await body(req));
        if (p.get('grant_type') === 'authorization_code') {
          const entry = codes.get(p.get('code') ?? '');
          codes.delete(p.get('code') ?? '');
          const verifier = p.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (!entry || entry.challenge !== challenge || entry.redirect !== p.get('redirect_uri')) {
            return send(400, { error: 'invalid_grant' });
          }
        } else if (!tokens.has(p.get('refresh_token') ?? '')) {
          return send(400, { error: 'invalid_grant' });
        }
        const access = randomUUID();
        tokens.add(access);
        state.tokensIssued++;
        return send(200, {
          access_token: access,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: access,
        });
      }
      case '/mcp': {
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        if (!bearer || !tokens.has(bearer)) {
          return send(
            401,
            { error: 'unauthorized' },
            {
              'www-authenticate': `Bearer resource_metadata="${state.base}/.well-known/oauth-protected-resource/mcp"`,
            },
          );
        }
        return mcpNode(req, res);
      }
      default:
        return send(404, { error: 'not found' });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  const state: MockOAuth = {
    base,
    mcpUrl: `${base}/mcp`,
    redirectIss: base,
    registrations: 0,
    tokensIssued: 0,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await mcp.close();
    },
  };
  return state;
}
