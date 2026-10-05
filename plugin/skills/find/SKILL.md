---
description: Find and enable an MCP tool or server for a capability you do not currently have (e.g. "query Postgres", "post to Slack", "read Jira tickets"). Use BEFORE telling the user something is impossible or asking them to install anything.
argument-hint: '[what you need to do]'
allowed-tools: mcp__plugin_agent-discover_agent-discover__search_tools mcp__plugin_agent-discover_agent-discover__search_servers mcp__plugin_agent-discover_agent-discover__get_tool mcp__plugin_agent-discover_agent-discover__server_status
---

Goal: get a working tool for this need with the fewest calls: $ARGUMENTS

1. `search_tools` with 2-4 short phrasings of the need in one call (`queries: [...]`). It searches every installed server's indexed tools, enabled or not.
2. Good hit on an **enabled** server: call that tool directly (native name `<server>__<tool>`), or via `call_tool` if it is not in your tool list.
3. Good hit on an installed but **not enabled** server: `enable_server`, then use the tool. Mention missing secrets from the result instead of calling a tool that will fail.
4. No good hit: `search_servers` (searches local + MCP Registry/npm/PyPI). Pick the best match and call `install_server`. The user is asked for consent with the exact command, env keys and provenance; never install without that approval and never retry a denied install.
5. Use `get_tool` when you need the full input schema before calling.

Report in one or two lines what you enabled or installed. Do not paste the result tables back; the user already sees them.
