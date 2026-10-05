// =============================================================================
// agent-discover — OAuth 2.1 for remote upstream servers
//
// One OAuthClientProvider per remote server, handed to the SDK transport
// (which runs discovery, PKCE, refresh and the RFC 9207 `iss` check through
// `auth()`). Everything the flow must remember is persisted through the
// secrets store, keyed per authorization server issuer:
//   oauth:client:<issuer>   registered client (DCR result, or the CIMD URL)
//   oauth:tokens:<issuer>   tokens
//   oauth:issuer            issuer of the most recent tokens
//   oauth:discovery         discovery state (binds the callback to the AS)
//   oauth:verifier          PKCE verifier of the pending authorization
// `state` lives in memory only (10 min, single use) and maps the callback to
// its server.
//
// The redirect target is the daemon's own loopback callback
// (http://127.0.0.1:<port>/oauth/callback, RFC 8252 §7.3). The authorization
// URL is never opened by agent-discover: it is handed to the user through
// URL-mode elicitation, the dashboard (GET /api/servers/:id/auth) or the
// error text, and only http(s) URLs are ever passed on.
//
// Client identity: with AGENT_DISCOVER_OAUTH_CLIENT_METADATA_URL set (an
// HTTPS Client ID Metadata Document the operator hosts) the SDK uses it as
// `client_id` when the AS supports CIMD. Without it — the local default, as
// a loopback daemon cannot host a public HTTPS document — the SDK registers
// dynamically (RFC 7591) per issuer.
// =============================================================================

import { randomBytes } from 'node:crypto';
import {
  auth,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import type { SecretsService } from './secrets.js';
import type { ServerStore } from './servers.js';
import { RegistryError, ValidationError } from '../types.js';
import { version } from '../version.js';

const STATE_TTL_MS = 10 * 60_000;
export const OAUTH_SECRET_PREFIX = 'oauth:';

/** The upstream needs the user to sign in; `authorizeUrl` starts it. */
export class AuthRequiredError extends RegistryError {
  constructor(
    readonly server: string,
    readonly authorizeUrl: string,
  ) {
    super(
      `"${server}" requires sign-in. Open ${authorizeUrl} to authorize agent-discover, then retry.`,
      'AUTH_REQUIRED',
      401,
    );
  }
}

/** Only http(s) URLs ever leave the daemon as something to open. */
export function safeAuthorizeUrl(url: URL | string): string {
  const u = new URL(String(url));
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new ValidationError(`refusing authorization URL with scheme ${u.protocol}`);
  }
  return u.href;
}

export interface AuthStatus {
  status: 'authorized' | 'required' | 'unknown';
  authorize_url?: string;
  issuer?: string;
}

export class OAuthManager {
  private readonly states = new Map<string, { server: string; expiresAt: number }>();
  private readonly pending = new Map<string, string>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(
    private readonly servers: ServerStore,
    private readonly secrets: SecretsService,
    private readonly redirectUrl: string,
    private readonly clientMetadataUrl?: string,
  ) {}

  /** Provider for a remote server's transport. */
  provider(serverName: string): OAuthClientProvider {
    const store = this.store(serverName);
    const metadata: OAuthClientMetadata = {
      client_name: 'agent-discover',
      software_version: version,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
    return {
      redirectUrl: this.redirectUrl,
      clientMetadataUrl: this.clientMetadataUrl,
      clientMetadata: metadata,
      state: () => this.mintState(serverName),
      clientInformation: (ctx?: OAuthClientInformationContext) =>
        ctx ? store.json<StoredOAuthClientInformation>(`client:${ctx.issuer}`) : undefined,
      saveClientInformation: (info: StoredOAuthClientInformation, ctx?) => {
        store.set(`client:${ctx?.issuer ?? info.issuer ?? ''}`, JSON.stringify(info));
      },
      tokens: (ctx?: OAuthClientInformationContext) => {
        const issuer = ctx?.issuer ?? store.get('issuer');
        return issuer ? store.json<StoredOAuthTokens>(`tokens:${issuer}`) : undefined;
      },
      saveTokens: (tokens: StoredOAuthTokens, ctx?) => {
        const issuer = ctx?.issuer ?? tokens.issuer ?? '';
        store.set(`tokens:${issuer}`, JSON.stringify(tokens));
        store.set('issuer', issuer);
      },
      redirectToAuthorization: (url: URL) => {
        this.pending.set(serverName, safeAuthorizeUrl(url));
      },
      saveCodeVerifier: (v: string) => {
        store.set('verifier', v);
      },
      codeVerifier: () => {
        const v = store.get('verifier');
        if (!v) throw new ValidationError('no pending authorization (PKCE verifier missing)');
        return v;
      },
      saveDiscoveryState: (s: OAuthDiscoveryState) => {
        store.set('discovery', JSON.stringify(s));
      },
      discoveryState: () => store.json<OAuthDiscoveryState>('discovery'),
      invalidateCredentials: (scope) => {
        const prefixes = {
          all: [''],
          client: ['client:'],
          tokens: ['tokens:', 'issuer'],
          verifier: ['verifier'],
          discovery: ['discovery'],
        }[scope];
        store.deleteWhere((key) => prefixes.some((p) => key.startsWith(p)));
      },
    };
  }

  /** The sign-in URL produced by the last 401 from this server, if any. */
  authorizeUrl(serverName: string): string | undefined {
    return this.pending.get(serverName);
  }

  status(serverName: string): AuthStatus {
    const store = this.store(serverName);
    const issuer = store.get('issuer') ?? undefined;
    if (issuer && store.get(`tokens:${issuer}`)) return { status: 'authorized', issuer };
    const url = this.pending.get(serverName);
    return url ? { status: 'required', authorize_url: url } : { status: 'unknown' };
  }

  /** Start (or refresh) authorization explicitly; returns the URL to open when sign-in is needed. */
  async begin(serverName: string, serverUrl: string): Promise<AuthStatus> {
    await auth(this.provider(serverName), { serverUrl });
    return this.status(serverName);
  }

  /**
   * Finish the redirect leg. The SDK checks `iss` (RFC 9207) and that the
   * callback belongs to the authorization server discovery recorded.
   */
  async callback(
    params: URLSearchParams,
    serverUrl: (serverName: string) => string,
  ): Promise<string> {
    const state = params.get('state') ?? '';
    const entry = this.states.get(state);
    this.states.delete(state);
    if (!entry || entry.expiresAt < Date.now()) {
      throw new ValidationError('unknown or expired OAuth state');
    }
    const error = params.get('error');
    if (error) {
      this.pending.delete(entry.server);
      throw new ValidationError(
        `authorization was not granted: ${error}${params.get('error_description') ? ` (${params.get('error_description')})` : ''}`,
      );
    }
    const code = params.get('code');
    if (!code) throw new ValidationError('authorization response has no code');
    await auth(this.provider(entry.server), {
      serverUrl: serverUrl(entry.server),
      authorizationCode: code,
      iss: params.get('iss') ?? undefined,
    });
    this.store(entry.server).delete('verifier');
    this.pending.delete(entry.server);
    for (const wake of this.waiters.get(entry.server) ?? []) wake();
    this.waiters.delete(entry.server);
    return entry.server;
  }

  /** Resolves true when the server's sign-in completes within `timeoutMs`. */
  waitForAuthorization(serverName: string, timeoutMs: number, signal?: AbortSignal) {
    return new Promise<boolean>((resolve) => {
      const set = this.waiters.get(serverName) ?? new Set<() => void>();
      this.waiters.set(serverName, set);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        set.delete(wake);
        signal?.removeEventListener('abort', abort);
        resolve(ok);
      };
      const wake = () => done(true);
      const abort = () => done(false);
      const timer = setTimeout(() => done(false), timeoutMs);
      set.add(wake);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private mintState(serverName: string): string {
    const now = Date.now();
    for (const [k, v] of this.states) if (v.expiresAt < now) this.states.delete(k);
    const state = randomBytes(24).toString('base64url');
    this.states.set(state, { server: serverName, expiresAt: now + STATE_TTL_MS });
    return state;
  }

  private store(serverName: string) {
    const owner = this.servers.require(serverName);
    const secrets = this.secrets;
    const key = (k: string) => `${OAUTH_SECRET_PREFIX}${k}`;
    return {
      get: (k: string) => secrets.get(owner, key(k)),
      json<T>(k: string): T | undefined {
        const raw = secrets.get(owner, key(k));
        return raw ? (JSON.parse(raw) as T) : undefined;
      },
      set: (k: string, v: string) => secrets.set(owner, key(k), v),
      delete: (k: string) => secrets.delete(owner, key(k)),
      deleteWhere(match: (k: string) => boolean) {
        for (const { key: full } of secrets.list(owner)) {
          if (
            full.startsWith(OAUTH_SECRET_PREFIX) &&
            match(full.slice(OAUTH_SECRET_PREFIX.length))
          ) {
            secrets.delete(owner, full);
          }
        }
      },
    };
  }
}
