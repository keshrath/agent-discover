// Trees for the panel and the attention band. Pure: state in, elements out; the
// handlers come from register.tsx.
import type { Elements } from 'claude-code';

import type { AgentDiscoverSearch, AgentDiscoverServer, AgentDiscoverSnapshot } from '../types';

/** The elements the panel draws with; `Input` is missing on mobile, which has no text field. */
export type El = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Link'> &
  Partial<Pick<Elements['terminal'], 'Input'>>;

export type Handlers = {
  refresh: () => void;
  /** Runs an action with the busy/notice bookkeeping, then refreshes. */
  run: (label: string, fn: () => Promise<string>) => void;
  enable: (name: string) => Promise<string>;
  disable: (name: string) => Promise<string>;
  reindex: (name: string) => Promise<string>;
  install: (name: string) => Promise<string>;
  find: (query: string) => void;
  open: () => void;
  dismiss: () => void;
};

export const needsAttention = (s: AgentDiscoverServer) =>
  s.quarantined || (s.enabled && s.health_status === 'unhealthy');

const clip = (text: string, max = 70) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const mark = (s: AgentDiscoverServer) =>
  s.quarantined ? '!' : !s.enabled ? '○' : s.health_status === 'unhealthy' ? '✗' : '●';

const tone = (s: AgentDiscoverServer) =>
  s.quarantined || s.health_status === 'unhealthy' ? 'red' : s.enabled ? 'green' : undefined;

type PanelProps = {
  el: El;
  snap: AgentDiscoverSnapshot;
  found: AgentDiscoverSearch | null;
  busy: string | null;
  notice: string | null;
  on: Handlers;
};

export function Panel({ el, snap, found, busy, notice, on }: PanelProps) {
  const { Box, Text, Button, Input, Link } = el;
  const enabled = snap.servers.filter((s) => s.enabled).length;
  const group = (title: string, list: AgentDiscoverServer[]) =>
    list.length > 0 && (
      <Box key={title} flexDirection="column">
        <Text bold dimColor>
          {title}
        </Text>
        {list.map((s) => (
          <Box key={`row:${s.name}`} gap={1}>
            <Text color={tone(s)}>{mark(s)}</Text>
            <Text bold>{s.name}</Text>
            <Text dimColor wrap="truncate">
              {s.tool_count} tools, {s.quarantined ? 'quarantined' : s.health_status}
            </Text>
            {!s.quarantined && (
              <Button
                key={`toggle:${s.name}`}
                label={s.enabled ? 'Disable' : 'Enable'}
                onPress={() =>
                  on.run(`${s.enabled ? 'disable' : 'enable'} ${s.name}`, () =>
                    s.enabled ? on.disable(s.name) : on.enable(s.name),
                  )
                }
              />
            )}
            <Button
              key={`reindex:${s.name}`}
              label="Re-index"
              dimColor
              onPress={() => on.run(`re-index ${s.name}`, () => on.reindex(s.name))}
            />
          </Box>
        ))}
      </Box>
    );

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1}>
        <Text bold>agent-discover</Text>
        {snap.isUp && (
          <Text dimColor>
            MCP {enabled}/{snap.servers.length} enabled
          </Text>
        )}
        <Link href={`${snap.dashboard}/#/servers`} label="dashboard" />
        <Button key="refresh" label="Refresh" dimColor onPress={on.refresh} />
      </Box>
      {!snap.isUp && <Text color="red">The daemon does not answer at {snap.dashboard}.</Text>}
      {snap.pending > 0 && (
        <Box gap={1}>
          <Text color="yellow">{snap.pending} upstream request(s) wait for an answer.</Text>
          <Link href={`${snap.dashboard}/#/approvals`} label="open dashboard" />
        </Box>
      )}
      {group(
        'Quarantined (tools changed, review before use)',
        snap.servers.filter((s) => s.quarantined),
      )}
      {group(
        'Enabled',
        snap.servers.filter((s) => s.enabled && !s.quarantined),
      )}
      {group(
        'Available',
        snap.servers.filter((s) => !s.enabled && !s.quarantined),
      )}
      {snap.isUp && snap.servers.length === 0 && (
        <Text dimColor>No servers installed yet. Search below to find one.</Text>
      )}
      {Input && (
        <Input
          key="search"
          label="Search"
          placeholder="what do you need? e.g. query postgres"
          value={found?.query}
          submitLabel="search"
          onSubmit={on.find}
        />
      )}
      {found && (
        <Box flexDirection="column">
          {found.error && <Text color="red">{found.error}</Text>}
          {found.tools.map((t) => (
            <Box key={`tool:${t.server}:${t.tool}`} gap={1}>
              <Text bold>
                {t.server}__{t.tool}
              </Text>
              <Text dimColor wrap="truncate">
                {clip(t.description)}
              </Text>
              {!t.isEnabled && (
                <Button
                  key={`enable:${t.server}:${t.tool}`}
                  label="Enable server"
                  onPress={() => on.run(`enable ${t.server}`, () => on.enable(t.server))}
                />
              )}
            </Box>
          ))}
          {found.market.map((m) => (
            <Box key={`market:${m.name}`} gap={1}>
              <Text bold>{m.name}</Text>
              <Text dimColor wrap="truncate">
                {m.version} {clip(m.description, 60)}
              </Text>
              <Button
                key={`install:${m.name}`}
                label="Install"
                variant="primary"
                onPress={() => on.run(`install ${m.name}`, () => on.install(m.name))}
              />
            </Box>
          ))}
          {!found.error && found.tools.length + found.market.length === 0 && (
            <Text dimColor>Nothing found for "{found.query}".</Text>
          )}
        </Box>
      )}
      {busy ? <Text color="yellow">{busy}...</Text> : notice && <Text dimColor>{notice}</Text>}
    </Box>
  );
}

export function Band({ el, snap, on }: { el: El; snap: AgentDiscoverSnapshot; on: Handlers }) {
  const { Box, Text, Button } = el;
  const what = [
    snap.attention.length > 0 && `needs a look: ${snap.attention.join(', ')}`,
    snap.pending > 0 && `${snap.pending} request(s) waiting for an answer`,
  ].filter(Boolean);

  return (
    <Box gap={1}>
      <Text color="yellow">agent-discover: {what.join('; ')}</Text>
      <Button key="open" label="Open panel" variant="primary" onPress={on.open} />
      <Button key="dismiss" label="Dismiss" dimColor onPress={on.dismiss} />
    </Box>
  );
}
