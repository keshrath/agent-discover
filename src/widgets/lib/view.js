// Which meta tool produced a structuredContent object (shapes: src/widgets/types.ts).
// Hosts need not tell the widget the tool name, so the view is picked from the shape;
// tests/widgets/contract.test.ts pins this against real results of every tool.
export function viewOf(sc) {
  if (!sc || typeof sc !== 'object') return null;
  if (Array.isArray(sc.results)) return 'search_tools';
  if (Array.isArray(sc.installed) && Array.isArray(sc.marketplace)) return 'search_servers';
  if (Array.isArray(sc.servers) && typeof sc.mode === 'string') return 'server_status';
  if (typeof sc.found === 'boolean') return 'get_tool';
  if (typeof sc.status === 'string' && Array.isArray(sc.tools)) return 'install_server';
  if (typeof sc.name === 'string' && typeof sc.enabled === 'boolean')
    return Array.isArray(sc.tools) ? 'enable_server' : 'disable_server';
  return null;
}
