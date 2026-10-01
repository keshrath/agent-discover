---
description: Show which MCP servers agent-discover has installed and enabled, their health, missing secrets and quarantined servers.
argument-hint: '[server name]'
disable-model-invocation: true
allowed-tools: mcp__plugin_agent-discover_agent-discover__server_status
---

Call `server_status` (pass `name` if one was given: $ARGUMENTS). The result is already shown to the user as a table or card, so only add what needs action: quarantined servers to review, missing secrets, servers that are down, each with its dashboard link from the result.
