// =============================================================================
// agent-discover — MCP prompts (slash commands in hosts like Claude Code)
// =============================================================================

import { ProtocolError, ProtocolErrorCode, type GetPromptResult, type Prompt } from '@modelcontextprotocol/server';

export const PROMPTS: Prompt[] = [
  {
    name: 'discover',
    title: 'Find tools for a task',
    description: 'Search installed and installable MCP servers for the tools a task needs, and enable them.',
    arguments: [{ name: 'task', description: 'What you want to get done', required: true }],
  },
  {
    name: 'install',
    title: 'Install an MCP server',
    description: 'Find an MCP server by name or need and install it.',
    arguments: [{ name: 'server', description: 'Server name, package or need', required: true }],
  },
  {
    name: 'status',
    title: 'MCP server status',
    description: 'Show installed MCP servers and their state.',
  },
];

function text(t: string): GetPromptResult {
  return { messages: [{ role: 'user', content: { type: 'text', text: t } }] };
}

export function getPrompt(name: string, args: Record<string, string> | undefined): GetPromptResult {
  switch (name) {
    case 'discover':
      return text(
        `Task: ${args?.task ?? ''}\n\nUse agent-discover: call search_tools with one query per capability the task needs. ` +
          'Call exposed matches directly; for matches on disabled servers either call_tool them or enable_server. ' +
          'If nothing fits, search_servers and propose an install_server to me.',
      );
    case 'install':
      return text(
        `Install the MCP server "${args?.server ?? ''}" with agent-discover: search_servers for it, pick the best match, ` +
          'then call install_server (I will confirm the exact command).',
      );
    case 'status':
      return text('Call agent-discover server_status and summarize which servers are installed, enabled, connected and healthy.');
    default:
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown prompt: ${name}`);
  }
}
