#!/usr/bin/env node

// =============================================================================
// agent-discover SessionStart hook
//
// Announces the registry/marketplace dashboard URL so new sessions know that
// agent-discover exists. Without this, the dashboard at 3424 is invisible to
// agents — they only see agent-comm (3421), agent-tasks (3422), and
// agent-knowledge (3423) from those servers' own SessionStart hooks.
// =============================================================================

const port = process.env.AGENT_DISCOVER_PORT || '3424';

const msg = {
  systemMessage: `agent-discover: http://localhost:${port}`,
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: `Discover (MCP registry + skill/hook catalog): http://localhost:${port}`,
  },
};

console.log(JSON.stringify(msg));
