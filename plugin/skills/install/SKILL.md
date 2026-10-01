---
description: Install an MCP server by name or description, with an explicit consent step showing the exact command, environment keys and provenance.
argument-hint: '<server name or what it should do>'
disable-model-invocation: true
---

The user wants to install an MCP server: $ARGUMENTS

1. If that is not an exact server name, call `search_servers` and pick the best match (prefer MCP Registry entries with verified provenance and pinned versions). If several are equally good, ask which one.
2. Call `install_server` with the name (and version if known). The user approves or denies in the consent prompt; do not try to bypass or pre-answer it.
3. On success call `enable_server` unless the user said otherwise, then list the required secrets that are still missing and where to add them (the result includes a dashboard link).
