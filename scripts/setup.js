#!/usr/bin/env node

// =============================================================================
// agent-discover setup script
//
// Configures an MCP-compatible AI agent to use agent-discover.
// Currently supports: Claude Code (auto-detected via ~/.claude.json)
//
// What it does:
// - Builds the project if dist/ is missing
// - Registers the MCP server in the agent's config
// - Adds permission for mcp__agent-discover__* tools
//
// Usage: node scripts/setup.js [--agent claude|generic]
//   Default: auto-detects Claude Code, falls back to generic instructions
// =============================================================================

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(join(__dirname, '..'));
const HOME = homedir();
const CLAUDE_JSON = join(HOME, '.claude.json');
const SETTINGS_JSON = join(HOME, '.claude', 'settings.json');

const AGENT_FLAG = process.argv.find((_a, i, arr) => arr[i - 1] === '--agent') ?? 'auto';
const IS_CLAUDE = AGENT_FLAG === 'claude' || (AGENT_FLAG === 'auto' && existsSync(CLAUDE_JSON));

console.log('agent-discover setup\n');
console.log(`Agent type: ${IS_CLAUDE ? 'Claude Code' : 'Generic (manual MCP config)'}`);

// ---------------------------------------------------------------------------
// Build if needed
// ---------------------------------------------------------------------------

if (!existsSync(join(PROJECT_DIR, 'dist', 'index.js'))) {
  console.log('Building agent-discover...');
  execSync('npm run build', { cwd: PROJECT_DIR, stdio: 'inherit' });
  console.log('');
}

// ---------------------------------------------------------------------------
// Register MCP server
// ---------------------------------------------------------------------------

const distPath = join(PROJECT_DIR, 'dist', 'index.js');

console.log('Registering MCP server...');
if (IS_CLAUDE && existsSync(CLAUDE_JSON)) {
  const config = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'));
  if (!config.mcpServers) config.mcpServers = {};

  config.mcpServers['agent-discover'] = {
    type: 'stdio',
    command: 'node',
    args: [distPath],
    env: {},
  };

  writeFileSync(CLAUDE_JSON, JSON.stringify(config, null, 2));
  console.log(`  Added agent-discover MCP server → ${distPath}`);
} else {
  console.log(`  Add this to your MCP client config:`);
  console.log(`  {`);
  console.log(`    "mcpServers": {`);
  console.log(`      "agent-discover": {`);
  console.log(`        "command": "node",`);
  console.log(`        "args": ["${distPath.replace(/\\/g, '/')}"]`);
  console.log(`      }`);
  console.log(`    }`);
  console.log(`  }`);
}

// ---------------------------------------------------------------------------
// Configure permissions (Claude Code only)
// ---------------------------------------------------------------------------

if (!IS_CLAUDE) {
  console.log(`
Setup complete!

Start the dashboard:  node dist/server.js
MCP server (stdio):   node dist/index.js
Dashboard URL:        http://localhost:3424
`);
  process.exit(0);
}

console.log('Configuring Claude Code permissions...');
if (existsSync(SETTINGS_JSON)) {
  const settings = JSON.parse(readFileSync(SETTINGS_JSON, 'utf-8'));

  if (!settings.permissions) settings.permissions = {};
  if (!settings.permissions.allow) settings.permissions.allow = [];
  if (!settings.permissions.allow.includes('mcp__agent-discover__*')) {
    settings.permissions.allow.push('mcp__agent-discover__*');
    console.log('  Added mcp__agent-discover__* permission');
  }

  writeFileSync(SETTINGS_JSON, JSON.stringify(settings, null, 2));
  console.log('  Saved settings.json');
} else {
  console.log('  Warning: settings.json not found. Add permission manually.');
}

console.log(`
Setup complete!

Restart Claude Code to load the new MCP server. The server will:
  - Expose 2 registry tools (registry, registry_server) with action-based dispatch
  - Proxy tools from activated servers (appear as serverName__toolName)
  - Auto-start the dashboard at http://localhost:3424

For more info, see: https://github.com/keshrath/agent-discover#readme
`);
