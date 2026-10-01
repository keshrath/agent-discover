---
description: Open the agent-discover dashboard (servers, marketplace, secrets, tool tester, logs), optionally at one server.
argument-hint: '[server name]'
disable-model-invocation: true
---

Dashboard URL: `http://127.0.0.1:3424` (port from `AGENT_DISCOVER_PORT` if set). Deep link for a server: `http://127.0.0.1:3424/#/servers/<url-encoded name>`; secrets: append `/secrets`; tool tester: append `/tools/<tool>`.

Target: $ARGUMENTS (empty = the servers list).

- If browser preview tools are available (Claude desktop app Browser pane), open the dashboard origin there, then navigate to the deep link. If the project has a `.claude/launch.json`, you may suggest adding `{ "name": "agent-discover", "url": "http://127.0.0.1:3424" }` to its `configurations` so it appears in the preview dropdown; only add it if the user agrees.
- Otherwise print the deep link as a bare URL on its own line (terminals make it clickable).

If the dashboard does not respond, call `server_status` once; that starts the daemon through the MCP server, then retry.
