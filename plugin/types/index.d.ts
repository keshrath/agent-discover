/** One installed server as GET /api/status and `server_status` report it. */
export type AgentDiscoverServer = {
  name: string;
  description: string;
  enabled: boolean;
  quarantined: boolean;
  tool_count: number;
  health_status: string;
};

/** What the daemon looked like at the last poll. `isUp` false: nothing else is meaningful. */
export type AgentDiscoverSnapshot = {
  isUp: boolean;
  /** Dashboard origin, e.g. http://127.0.0.1:3424 */
  dashboard: string;
  servers: AgentDiscoverServer[];
  /** Upstream elicitations waiting for an answer in the dashboard. */
  pending: number;
  /** Names of servers that need a look (quarantined, or enabled and unhealthy). */
  attention: string[];
};

export type AgentDiscoverSearch = {
  query: string;
  /** Installed tools matching the query. */
  tools: { server: string; tool: string; description: string; isEnabled: boolean }[];
  /** Uninstalled servers from the registry. */
  market: { name: string; description: string; version: string }[];
  error?: string;
};

declare module 'claude-code' {
  interface PluginState {
    'agent-discover': {
      snapshot: AgentDiscoverSnapshot | null;
      search: AgentDiscoverSearch | null;
      /** The action in flight ("enable fixture"), shown instead of its buttons. */
      busy: string | null;
      /** The last action's outcome, one line. */
      notice: string | null;
      /** Attention signature the person dismissed from the band; it returns when that changes. */
      dismissed: string | null;
    };
  }
}
