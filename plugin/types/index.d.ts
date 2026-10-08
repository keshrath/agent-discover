/** One installed server: GET /api/status merged with its GET /api/servers row. */
export type AgentDiscoverServer = {
  id: number;
  name: string;
  description: string;
  transport: string;
  enabled: boolean;
  quarantined: boolean;
  tool_count: number;
  health_status: string;
  error_count: number;
  /** `deleted` when its MCP Registry entry was taken down; null when not from the registry. */
  registry_status: string | null;
  registry_name: string | null;
  /** The npm or PyPI package it was installed from; Browse matches results by it. */
  package_name: string | null;
};

/** One field of an upstream elicitation form (requestedSchema property). */
export type AgentDiscoverField = {
  name: string;
  title: string;
  type: 'string' | 'number' | 'integer' | 'boolean';
  /** Allowed values (enum), drawn as a Select. */
  options: string[];
  required: boolean;
};

/** An upstream server's question waiting for the person (GET /api/elicitations). */
export type AgentDiscoverElicitation = {
  id: string;
  server: string;
  message: string;
  fields: AgentDiscoverField[];
};

/** What the daemon looked like at the last poll. `isUp` false: nothing else is meaningful. */
export type AgentDiscoverSnapshot = {
  isUp: boolean;
  /** Daemon origin, e.g. http://127.0.0.1:3424 */
  origin: string;
  servers: AgentDiscoverServer[];
  elicitations: AgentDiscoverElicitation[];
  /** Names of servers that need a look (quarantined, or enabled and unhealthy). */
  attention: string[];
};

export type AgentDiscoverTab = 'servers' | 'browse' | 'logs' | 'audit';

/** Which view the pane shows; `server` set on the servers tab is that server's detail. */
export type AgentDiscoverRoute = { tab: AgentDiscoverTab; server: string | null };

export type AgentDiscoverConfigKey = {
  key: string;
  kind: 'env' | 'header' | 'secret';
  source: 'secret' | 'value' | 'missing';
};

/** A server's detail view. Env and header values are never carried, only their keys. */
export type AgentDiscoverDetail = {
  id: number;
  name: string;
  description: string;
  transport: string;
  command: string | null;
  args: string[];
  url: string | null;
  tags: string[];
  source: string;
  registry_name: string | null;
  registry_status: string | null;
  package_name: string | null;
  package_version: string | null;
  enabled: boolean;
  quarantined: boolean;
  connected: boolean;
  health_status: string;
  last_health_check: string | null;
  error_count: number;
  /**
   * Every env var and header the server is started with, plus stored secrets: where its
   * value comes from (`secret` in the keychain, a plain `value` in the config, or
   * `missing`: a declared header nothing fills). Values themselves never enter state.
   */
  config: AgentDiscoverConfigKey[];
  tools: { name: string; description: string }[];
  metrics: { tool: string; calls: number; errors: number; avg_ms: number }[];
  /** Present while quarantined: what changed since the last approval. */
  drift: {
    /** `description`: the approved text and the one the server reports now. */
    changed: {
      tool: string;
      what: string;
      description: { before: string; after: string } | null;
    }[];
    added: string[];
    removed: string[];
  } | null;
  /** The tool hashes the trust report showed; an approval echoes exactly these. */
  hashes: string[];
  /** OAuth state of a remote server; null for stdio. */
  auth: { status: string; authorize_url: string | null } | null;
  /** The last health check run from the pane (on open for an enabled server, or pressed). */
  health: { status: string; latency_ms: number; error: string | null } | null;
};

/** A tool whose input schema is unfolded in the detail view. */
export type AgentDiscoverTool = { server: string; tool: string; schema: string };

export type AgentDiscoverEntry = {
  source: string;
  name: string;
  description: string;
  version: string;
  status: string;
  isInstalled: boolean;
};

export type AgentDiscoverBrowse = {
  query: string;
  results: AgentDiscoverEntry[];
  error: string | null;
};

/** The install plan shown for consent. Requirement values typed in stay out of state. */
export type AgentDiscoverPlan = {
  source: string;
  name: string;
  version: string | null;
  server: string;
  transport: string;
  command: string | null;
  args: string[];
  url: string | null;
  pinned: boolean;
  publisher: string | null;
  registry_status: string | null;
  repository: string | null;
  checks: { id: string; status: string; detail: string }[];
  warnings: string[];
  blocked: string | null;
  requirements: {
    key: string;
    kind: string;
    required: boolean;
    secret: boolean;
    present: boolean;
  }[];
  /** Keys the person typed a value for. */
  filled: string[];
};

export type AgentDiscoverLogs = {
  entries: {
    id: number;
    time: string;
    server: string;
    tool: string;
    ms: number;
    error: string | null;
  }[];
  total: number;
};

export type AgentDiscoverAudit = {
  entries: {
    id: number;
    ts: string;
    action: string;
    server: string | null;
    tool: string | null;
    isError: boolean;
    /** How long a call_tool took; null for other actions. */
    ms: number | null;
  }[];
  total: number;
  server: string;
  action: string;
  /** `before` cursors of the pages above this one; empty on the newest page. */
  cursors: number[];
  before: number | null;
};

declare module 'claude-code' {
  interface PluginState {
    'agent-discover': {
      snapshot: AgentDiscoverSnapshot | null;
      route: AgentDiscoverRoute;
      detail: AgentDiscoverDetail | null;
      tool: AgentDiscoverTool | null;
      /** An action waiting for a second press ("uninstall:github"). */
      confirm: string | null;
      browse: AgentDiscoverBrowse | null;
      plan: AgentDiscoverPlan | null;
      logs: AgentDiscoverLogs | null;
      audit: AgentDiscoverAudit | null;
      /** The action in flight ("enable fixture"), shown instead of its outcome. */
      busy: string | null;
      /** The last action's outcome, one line. */
      notice: string | null;
      /** Attention signature the person dismissed from the band; it returns when that changes. */
      dismissed: string | null;
      /** Length of what was typed into each masked field (secret values), by field id. */
      masked: Record<string, number>;
      /** The config key whose secret is being set in the server detail. */
      editing: string | null;
      /** The pane is open and drawn: the attention band stays out of its way. */
      paneOpen: boolean;
    };
  }
}
