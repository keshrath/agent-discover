// =============================================================================
// agent-discover — server.json parsing and install plans
//
// `parseServerJson` normalizes an MCP Registry `server.json` (schemas
// 2025-09-29 and 2025-12-11) into `ServerJson`. npm/PyPI federation results
// are expressed in the same shape, so every install source goes through one
// builder: `buildInstallPlan` turns a ServerJson into the exact process spawn
// (or remote endpoint) plus the env/header requirements and provenance facts
// the consent prompt shows. `InstallPlan.input` is what ServerLifecycle.install
// receives — nothing else decides the command.
//
// Commands are argv arrays (never a shell string); versions are pinned
// exactly (`pkg@1.2.3`, `pkg==1.2.3`, `image:tag`/`@sha256:`).
// =============================================================================

import type { ServerInput, ServerTransport } from '../types.js';

export type RegistryStatus = 'active' | 'deprecated' | 'deleted';
export type InstallSource = 'registry' | 'npm' | 'pypi';

export interface InputSpec {
  description?: string;
  isRequired: boolean;
  isSecret: boolean;
  value?: string;
  default?: string;
  choices?: string[];
  variables: Record<string, InputSpec>;
}

export interface KeyValueSpec extends InputSpec {
  name: string;
}

export interface ArgumentSpec extends InputSpec {
  type: 'positional' | 'named';
  /** Flag name (named arguments), including leading dashes. */
  name?: string;
  valueHint?: string;
}

export interface PackageSpec {
  registryType: string;
  registryBaseUrl?: string;
  identifier: string;
  version?: string;
  fileSha256?: string;
  runtimeHint?: string;
  transport: { type: string; url?: string };
  runtimeArguments: ArgumentSpec[];
  packageArguments: ArgumentSpec[];
  environmentVariables: KeyValueSpec[];
}

export interface RemoteSpec {
  type: 'streamable-http' | 'sse';
  url: string;
  headers: KeyValueSpec[];
  variables: Record<string, InputSpec>;
}

/** Normalized server.json. */
export interface ServerJson {
  name: string;
  title?: string;
  description: string;
  version: string;
  repository?: string;
  websiteUrl?: string;
  packages: PackageSpec[];
  remotes: RemoteSpec[];
}

/** Registry facts about an entry (from the `io.modelcontextprotocol.registry/official` meta). */
export interface RegistryFacts {
  status: RegistryStatus;
  publishedAt?: string;
  updatedAt?: string;
  isLatest?: boolean;
}

/** A resolved install candidate: the server.json plus where it came from. */
export interface InstallCandidate {
  source: InstallSource;
  server: ServerJson;
  /** Present for official-registry entries. */
  registry?: RegistryFacts;
}

// ---------------------------------------------------------------------------
// InstallPlan — the structured object consent prompts render (W4 owns the
// formatting). Fields are only ever added.
// ---------------------------------------------------------------------------

export interface Requirement {
  key: string;
  kind: 'env' | 'header';
  required: boolean;
  secret: boolean;
  description?: string;
  /** A value is already available (fixed by the publisher, a default, or a stored secret). */
  present: boolean;
}

export type CheckStatus = 'pass' | 'fail' | 'skipped' | 'error';

export interface ProvenanceCheck {
  id: 'registry_namespace' | 'npm_mcp_name' | 'pypi_mcp_name' | 'oci_label';
  status: CheckStatus;
  detail: string;
}

export interface Provenance {
  /** Official MCP Registry entry; `publisher` is the namespace the registry verified at publish. */
  registry?: {
    name: string;
    status: RegistryStatus;
    publisher: string;
    published_at?: string;
    is_latest?: boolean;
  };
  package?: {
    ecosystem: string;
    name: string;
    version: string | null;
    registry_base_url?: string;
  };
  /** remote endpoint (remotes[] installs). */
  remote?: { url: string; type: 'streamable-http' | 'sse' };
  /** The exact artifact is fixed (exact version / image digest or tag). */
  pinned: boolean;
  /** OCI digest when the identifier pins one. */
  digest?: string;
  repository?: string;
  /** Verifications run against the package registries (filled by checkProvenance). */
  checks: ProvenanceCheck[];
}

export interface InstallPlan {
  /** Local server name. */
  server: string;
  source: InstallSource | 'manual';
  /** Official registry name (reverse-DNS), when the plan came from the registry. */
  registry_name?: string;
  title?: string;
  description: string;
  version: string | null;
  transport: ServerTransport;
  /** Exact process spawn (stdio), one token per arg. */
  command?: string;
  args?: string[];
  /** Remote endpoint (http/sse). */
  url?: string;
  requirements: Requirement[];
  provenance: Provenance;
  warnings: string[];
  /** Set when the entry cannot be installed automatically; install refuses with this message. */
  blocked?: string;
  /** What ServerLifecycle.install receives. */
  input: ServerInput;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

function obj(v: unknown): Raw {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {};
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function parseInput(raw: unknown): InputSpec {
  const r = obj(raw);
  const variables: Record<string, InputSpec> = {};
  for (const [k, v] of Object.entries(obj(r.variables))) variables[k] = parseInput(v);
  return {
    description: optStr(r.description),
    isRequired: r.isRequired === true,
    isSecret: r.isSecret === true,
    value: typeof r.value === 'string' ? r.value : undefined,
    default: typeof r.default === 'string' ? r.default : undefined,
    choices: Array.isArray(r.choices) ? r.choices.filter((c) => typeof c === 'string') : undefined,
    variables,
  };
}

function parseKeyValues(raw: unknown): KeyValueSpec[] {
  return arr(raw)
    .map((e) => ({ ...parseInput(e), name: optStr(obj(e).name) ?? '' }))
    .filter((e) => e.name !== '');
}

function parseArguments(raw: unknown): ArgumentSpec[] {
  return arr(raw).map((e) => {
    const r = obj(e);
    return {
      ...parseInput(e),
      type: r.type === 'named' ? 'named' : 'positional',
      name: optStr(r.name),
      valueHint: optStr(r.valueHint),
    };
  });
}

export function parseServerJson(raw: unknown): ServerJson {
  const r = obj(raw);
  const packages: PackageSpec[] = arr(r.packages).map((p) => {
    const pr = obj(p);
    const t = obj(pr.transport);
    return {
      registryType: String(pr.registryType ?? ''),
      registryBaseUrl: optStr(pr.registryBaseUrl),
      identifier: String(pr.identifier ?? ''),
      version: optStr(pr.version),
      fileSha256: optStr(pr.fileSha256),
      runtimeHint: optStr(pr.runtimeHint),
      transport: { type: optStr(t.type) ?? 'stdio', url: optStr(t.url) },
      runtimeArguments: parseArguments(pr.runtimeArguments),
      packageArguments: parseArguments(pr.packageArguments),
      environmentVariables: parseKeyValues(pr.environmentVariables),
    };
  });
  const remotes: RemoteSpec[] = arr(r.remotes)
    .map((e) => {
      const rr = obj(e);
      const variables: Record<string, InputSpec> = {};
      for (const [k, v] of Object.entries(obj(rr.variables))) variables[k] = parseInput(v);
      return {
        type: rr.type === 'sse' ? ('sse' as const) : ('streamable-http' as const),
        url: String(rr.url ?? ''),
        headers: parseKeyValues(rr.headers),
        variables,
      };
    })
    .filter((x) => x.url !== '');
  return {
    name: String(r.name ?? ''),
    title: optStr(r.title),
    description: String(r.description ?? ''),
    version: String(r.version ?? ''),
    repository: optStr(obj(r.repository).url),
    websiteUrl: optStr(r.websiteUrl),
    packages,
    remotes,
  };
}

/** The registry's own facts from an entry's `_meta`. */
export function parseRegistryFacts(meta: unknown): RegistryFacts {
  const official = obj(obj(meta)['io.modelcontextprotocol.registry/official']);
  const status = official.status;
  return {
    status: status === 'deprecated' || status === 'deleted' ? status : 'active',
    publishedAt: optStr(official.publishedAt),
    updatedAt: optStr(official.updatedAt),
    isLatest: typeof official.isLatest === 'boolean' ? official.isLatest : undefined,
  };
}

// ---------------------------------------------------------------------------
// Plan building
// ---------------------------------------------------------------------------

/** The registry verified this namespace at publish time (GitHub account or DNS/HTTP domain). */
export function publisherOf(registryName: string): string {
  const ns = registryName.split('/')[0] ?? '';
  const gh = /^io\.github\.([^/]+)$/i.exec(ns);
  if (gh) return `github:${gh[1]}`;
  return `domain:${ns.split('.').reverse().join('.')}`;
}

/** A local server name derived from a registry/package name (last path segment). */
export function localNameFor(name: string): string {
  const last = name.split('/').pop() ?? name;
  const clean = last
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/_{2,}/g, '_')
    .replace(/^[^a-zA-Z0-9]+/, '');
  return clean || 'server';
}

const EXACT_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;

function isExactVersion(v: string | undefined): v is string {
  return !!v && v !== 'latest' && EXACT_VERSION.test(v) && !/^[0-9]+(\.[0-9x*]+)?$/.test(v);
}

/** Resolve `{var}` placeholders from an input's variables (value, else default). */
function substitute(template: string, variables: Record<string, InputSpec>): string {
  return template.replace(/\{([^{}]+)\}/g, (whole, key: string) => {
    const v = variables[key];
    return v?.value ?? v?.default ?? whole;
  });
}

function resolvedValue(input: InputSpec): string | undefined {
  const v = input.value ?? input.default;
  return v === undefined ? undefined : substitute(v, input.variables);
}

const UNRESOLVED = /\{[^{}]+\}/;

function buildArgs(list: ArgumentSpec[], missing: string[]): string[] {
  const out: string[] = [];
  for (const a of list) {
    const value = resolvedValue(a);
    if (value !== undefined && UNRESOLVED.test(value)) {
      missing.push(a.valueHint ?? a.name ?? value);
      continue;
    }
    if (a.type === 'named') {
      if (!a.name) continue;
      if (value === undefined) {
        if (a.isRequired) missing.push(a.name);
        continue;
      }
      out.push(value === '' ? a.name : `${a.name}=${value}`);
    } else if (value !== undefined) {
      out.push(value);
    } else if (a.isRequired) {
      missing.push(a.valueHint ?? 'positional argument');
    }
  }
  return out;
}

function ociReference(pkg: PackageSpec): { ref: string; digest?: string; pinned: boolean } {
  const id = pkg.identifier;
  const digest = /@(sha256:[a-f0-9]{64})$/.exec(id)?.[1];
  if (digest) return { ref: id, digest, pinned: true };
  const lastSegment = id.split('/').pop() ?? id;
  const tag = lastSegment.includes(':') ? lastSegment.split(':').pop() : undefined;
  if (tag) return { ref: id, pinned: tag !== 'latest' };
  if (pkg.version && pkg.version !== 'latest') {
    return { ref: `${id}:${pkg.version}`, pinned: true };
  }
  return { ref: id, pinned: false };
}

interface Built {
  command?: string;
  args?: string[];
  url?: string;
  transport: ServerTransport;
  env: Record<string, string>;
  headers: Record<string, string>;
  requirements: Requirement[];
  version: string | null;
  pinned: boolean;
  digest?: string;
  warnings: string[];
  blocked?: string;
}

function requirementsOf(
  list: KeyValueSpec[],
  kind: 'env' | 'header',
  present: (key: string) => boolean,
  values: Record<string, string>,
): Requirement[] {
  return list.map((kv) => {
    const value = kv.isSecret ? undefined : resolvedValue(kv);
    if (value !== undefined && !UNRESOLVED.test(value)) values[kv.name] = value;
    else if (kind === 'header') values[kv.name] = '';
    return {
      key: kv.name,
      kind,
      required: kv.isRequired,
      secret: kv.isSecret,
      ...(kv.description ? { description: kv.description } : {}),
      present: (value !== undefined && !UNRESOLVED.test(value)) || present(kv.name),
    };
  });
}

function buildPackage(pkg: PackageSpec, present: (key: string) => boolean): Built {
  const warnings: string[] = [];
  const env: Record<string, string> = {};
  const requirements = requirementsOf(pkg.environmentVariables, 'env', present, env);
  const base = {
    env,
    headers: {},
    requirements,
    transport: 'stdio' as const,
    warnings,
    version: pkg.version ?? null,
    pinned: false,
  };
  if (pkg.transport.type !== 'stdio') {
    return {
      ...base,
      blocked: `package "${pkg.identifier}" uses the ${pkg.transport.type} transport (a local HTTP server); only stdio packages and remotes are supported`,
    };
  }
  const missing: string[] = [];
  const runtimeArgs = buildArgs(pkg.runtimeArguments, missing);
  const packageArgs = buildArgs(pkg.packageArguments, missing);
  if (missing.length) {
    return {
      ...base,
      blocked: `required argument(s) without a value: ${missing.join(', ')} — install manually with command/args`,
    };
  }
  if (
    pkg.registryBaseUrl &&
    !/^https:\/\/(registry\.npmjs\.org|pypi\.org|docker\.io)\/?$/.test(pkg.registryBaseUrl)
  ) {
    warnings.push(
      `package registry ${pkg.registryBaseUrl} is not the default one and is not verified`,
    );
  }
  switch (pkg.registryType) {
    case 'npm': {
      const pinned = isExactVersion(pkg.version);
      return {
        ...base,
        command: 'npx',
        args: [
          '-y',
          ...runtimeArgs,
          pinned ? `${pkg.identifier}@${pkg.version}` : pkg.identifier,
          ...packageArgs,
        ],
        pinned,
      };
    }
    case 'pypi': {
      const pinned = isExactVersion(pkg.version);
      return {
        ...base,
        command: 'uvx',
        args: [
          ...runtimeArgs,
          pinned ? `${pkg.identifier}==${pkg.version}` : pkg.identifier,
          ...packageArgs,
        ],
        pinned,
      };
    }
    case 'oci': {
      const { ref, digest, pinned } = ociReference(pkg);
      if (!digest && pinned) warnings.push('image tags are mutable; only a digest pins the image');
      // `-e NAME` forwards the value from docker's own env (ours: env + secrets).
      const envFlags = pkg.environmentVariables.flatMap((e) => ['-e', e.name]);
      return {
        ...base,
        command: 'docker',
        args: ['run', '-i', '--rm', ...runtimeArgs, ...envFlags, ref, ...packageArgs],
        version: digest ?? pkg.version ?? null,
        pinned,
        digest,
      };
    }
    case 'mcpb':
      return {
        ...base,
        blocked:
          'MCPB bundles are not supported: agent-discover cannot download, verify (fileSha256) and unpack them — install it in a host with MCPB support',
      };
    default:
      return {
        ...base,
        blocked: `packages from "${pkg.registryType}" are not supported (npm, pypi and oci are)`,
      };
  }
}

function buildRemote(remote: RemoteSpec, present: (key: string) => boolean): Built {
  const headers: Record<string, string> = {};
  const requirements = requirementsOf(remote.headers, 'header', present, headers);
  const url = substitute(remote.url, remote.variables);
  const base = {
    url,
    transport: remote.type,
    env: {},
    headers,
    requirements,
    version: null,
    pinned: false,
    warnings: [] as string[],
  };
  if (UNRESOLVED.test(url)) {
    return { ...base, blocked: `remote URL ${remote.url} needs values for its {variables}` };
  }
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    /* handled below */
  }
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    return { ...base, blocked: `remote URL ${url} is not an http(s) URL` };
  }
  if (parsed.protocol === 'http:') base.warnings.push('remote endpoint is not served over https');
  return base;
}

export interface PlanOptions {
  /** Local server name (default: derived from the registry/package name). */
  name?: string;
  /** Pick a remote (streamable-http/sse) or a package (stdio); default: first stdio package, else first remote. */
  transport?: ServerTransport;
  /** Secret keys already stored for the server (fills `present`). */
  storedSecrets?: string[];
}

/** Build the plan for one candidate. Pure: provenance checks are added by checkProvenance. */
export function buildInstallPlan(candidate: InstallCandidate, opts: PlanOptions = {}): InstallPlan {
  const { server, source, registry } = candidate;
  const stored = new Set((opts.storedSecrets ?? []).map((k) => k.toLowerCase()));
  const present = (key: string) => stored.has(key.toLowerCase());
  const wantRemote = opts.transport === 'sse' || opts.transport === 'streamable-http';
  const remote = wantRemote
    ? (server.remotes.find((r) => r.type === opts.transport) ?? server.remotes[0])
    : undefined;
  const pkg = wantRemote
    ? undefined
    : (server.packages.find((p) => p.transport.type === 'stdio') ?? server.packages[0]);
  const chosenRemote = remote ?? (pkg ? undefined : server.remotes[0]);

  const built: Built = pkg
    ? buildPackage(pkg, present)
    : chosenRemote
      ? buildRemote(chosenRemote, present)
      : {
          transport: 'stdio',
          env: {},
          headers: {},
          requirements: [],
          version: null,
          pinned: false,
          warnings: [],
          blocked: `"${server.name}" declares neither packages nor remotes`,
        };

  const warnings = [...built.warnings];
  let blocked = built.blocked;
  if (registry?.status === 'deleted') {
    blocked = `"${server.name}" was removed from the MCP Registry (deleted entries are takedowns, e.g. malware or spam)`;
  } else if (registry?.status === 'deprecated') {
    warnings.push(`"${server.name}" is deprecated in the MCP Registry`);
  }
  if (pkg && !built.pinned && !blocked) warnings.push('the package version is not pinned');
  for (const r of built.requirements) {
    if (r.required && !r.present) warnings.push(`requires ${r.kind} ${r.key}`);
  }

  const name = opts.name ?? localNameFor(server.name);
  const input: ServerInput = {
    name,
    description: server.description,
    source: 'registry',
    transport: built.transport,
    ...(built.command ? { command: built.command, args: built.args } : {}),
    ...(built.url ? { url: built.url, headers: built.headers } : {}),
    env: built.env,
    tags: [source],
    package_name: pkg?.identifier,
    package_version: built.version ?? undefined,
    repository: server.repository,
    homepage: server.websiteUrl,
    ...(source === 'registry' ? { registry_name: server.name } : {}),
  };

  return {
    server: name,
    source,
    ...(source === 'registry' ? { registry_name: server.name } : {}),
    ...(server.title ? { title: server.title } : {}),
    description: server.description,
    version: built.version,
    transport: built.transport,
    ...(built.command ? { command: built.command, args: built.args } : {}),
    ...(built.url ? { url: built.url } : {}),
    requirements: built.requirements,
    provenance: {
      ...(source === 'registry' && registry
        ? {
            registry: {
              name: server.name,
              status: registry.status,
              publisher: publisherOf(server.name),
              ...(registry.publishedAt ? { published_at: registry.publishedAt } : {}),
              ...(registry.isLatest !== undefined ? { is_latest: registry.isLatest } : {}),
            },
          }
        : {}),
      ...(pkg
        ? {
            package: {
              ecosystem: pkg.registryType,
              name: pkg.identifier,
              version: built.version,
              ...(pkg.registryBaseUrl ? { registry_base_url: pkg.registryBaseUrl } : {}),
            },
          }
        : {}),
      ...(chosenRemote && built.url ? { remote: { url: built.url, type: chosenRemote.type } } : {}),
      pinned: built.pinned,
      ...(built.digest ? { digest: built.digest } : {}),
      ...(server.repository ? { repository: server.repository } : {}),
      checks: [],
    },
    warnings,
    ...(blocked ? { blocked } : {}),
    input,
  };
}

/** The plan for a manual command/url install (nothing to verify, nothing pinned). */
export function manualPlan(input: ServerInput): InstallPlan {
  const transport = input.transport ?? 'stdio';
  const keys = (m: Record<string, string> | undefined, kind: 'env' | 'header'): Requirement[] =>
    Object.keys(m ?? {}).map((key) => ({
      key,
      kind,
      required: false,
      secret: false,
      present: true,
    }));
  return {
    server: input.name,
    source: 'manual',
    description: input.description ?? '',
    version: null,
    transport,
    ...(transport === 'stdio'
      ? { command: input.command, args: input.args ?? [] }
      : { url: input.url }),
    requirements: [...keys(input.env, 'env'), ...keys(input.headers, 'header')],
    provenance: { pinned: false, checks: [] },
    warnings: [],
    input,
  };
}
