# Changelog

## v1.0.0

Initial release.

- 2 action-based MCP tools: `registry` (list/install/uninstall/browse/status) and `registry_server` (activate/deactivate)
- MCP server proxy: activate/deactivate servers, expose their tools via `serverName__toolName` namespacing with `tools/list_changed` notifications
- Official MCP registry marketplace browser (registry.modelcontextprotocol.io)
- Auto-detect install method (npx, uvx, docker) with package name validation
- Enterprise features: secrets management (masked values, env merge on activate), health monitoring, usage metrics, approval status workflow
- REST API with 16 endpoints (CRUD, secrets, health, metrics, browse)
- WebSocket real-time dashboard with 2s polling
- Dashboard UI: Servers tab (approval badges, health dots, expandable Secrets/Metrics/Config sections) and Browse tab (marketplace search with install button)
- SQLite with WAL mode, schema V2 (servers, server_tools, server_secrets, server_metrics, servers_fts)
- 152 tests (unit, integration, E2E)
- Theme sync for agent-desk integration (postMessage + MutationObserver)
- Connection status indicator
