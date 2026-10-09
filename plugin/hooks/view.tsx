// Trees for the /discover pane and the attention band. Pure: state in, elements out;
// the actions come from register.tsx. Laid out for the docked sidebar first (about 45
// to 70 columns): a one-line tab bar, two-line rows, labels beside wrapping values.
// Wider panes only get more room per line; nothing depends on it.
import type { Elements } from 'claude-code';

import type {
  AgentDiscoverAudit,
  AgentDiscoverBrowse,
  AgentDiscoverConfigKey,
  AgentDiscoverDetail,
  AgentDiscoverElicitation,
  AgentDiscoverEntry,
  AgentDiscoverLogs,
  AgentDiscoverPlan,
  AgentDiscoverRoute,
  AgentDiscoverServer,
  AgentDiscoverSnapshot,
  AgentDiscoverTab,
  AgentDiscoverTool,
} from '../types';

/** The elements the pane draws with; mobile has no `Input` or `Select`. */
export type El = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Link' | 'Code'> &
  Partial<Pick<Elements['terminal'], 'Input' | 'Select'>>;

export type Actions = {
  refresh: () => void;
  go: (tab: AgentDiscoverTab) => void;
  open: (name: string) => void;
  enable: (name: string) => void;
  disable: (name: string) => void;
  reindex: (name: string) => void;
  health: (name: string) => void;
  resetErrors: (name: string) => void;
  approve: (name: string) => void;
  keepDisabled: (name: string) => void;
  signIn: (name: string) => void;
  askUninstall: (name: string) => void;
  cancel: () => void;
  uninstall: (name: string) => void;
  /** A masked field reported `shown` (bullets plus the person's edit). */
  mask: (id: string, shown: string) => void;
  /** Saves what was typed into the masked field of `key` as a secret of `name`. */
  setSecret: (name: string, key: string) => void;
  /** Opens (or with null closes) the masked field for one config key. */
  editSecret: (key: string | null) => void;
  /** Starts a secret under a new key name. */
  addSecret: (key: string) => void;
  deleteSecret: (name: string, key: string) => void;
  toggleTool: (name: string, tool: string) => void;
  search: (query: string) => void;
  syncRegistry: () => void;
  showPlan: (entry: AgentDiscoverEntry) => void;
  fill: (key: string, value: string) => void;
  /** Fills a secret requirement from its masked field. */
  fillSecret: (key: string) => void;
  cancelPlan: () => void;
  install: (enable: boolean) => void;
  reloadLogs: () => void;
  reloadAudit: () => void;
  filterAudit: (field: 'server' | 'action', value: string) => void;
  olderAudit: () => void;
  newerAudit: () => void;
  answer: (id: string, field: string, value: string) => void;
  respond: (id: string, action: 'accept' | 'decline' | 'cancel') => void;
  openFromBand: () => void;
  dismiss: () => void;
};

export const needsAttention = (s: AgentDiscoverServer) =>
  s.quarantined || (s.enabled && s.health_status === 'unhealthy');

type State = 'quarantined' | 'unhealthy' | 'enabled' | 'installed';

const state = (s: { quarantined: boolean; enabled: boolean; health_status: string }): State =>
  s.quarantined
    ? 'quarantined'
    : s.enabled && s.health_status === 'unhealthy'
      ? 'unhealthy'
      : s.enabled
        ? 'enabled'
        : 'installed';

// Theme keys, so the pane follows the person's theme (light, dark, colorblind).
const OK = 'success';
const BAD = 'error';
const WARN = 'warning';
const ACCENT = 'suggestion';

const TONE: Record<State, string | undefined> = {
  quarantined: BAD,
  unhealthy: BAD,
  enabled: OK,
  installed: undefined,
};
const MARK: Record<State, string> = {
  quarantined: '!',
  unhealthy: '✗',
  enabled: '●',
  installed: '○',
};
const ORDER: State[] = ['quarantined', 'unhealthy', 'enabled', 'installed'];

/** The list's order: what needs a look first, then enabled, then the rest; by name within. */
export const sortServers = (servers: AgentDiscoverServer[]) =>
  [...servers].sort(
    (a, b) => ORDER.indexOf(state(a)) - ORDER.indexOf(state(b)) || a.name.localeCompare(b.name),
  );
const SOURCE: Record<AgentDiscoverConfigKey['source'], string> = {
  secret: 'in the keychain',
  value: 'in the config',
  missing: 'missing',
};
const SOURCE_TONE: Record<AgentDiscoverConfigKey['source'], string | undefined> = {
  secret: OK,
  value: undefined,
  missing: WARN,
};
const CHECK: Record<string, [string, string | undefined]> = {
  pass: ['✓', OK],
  fail: ['✗', BAD],
  error: ['?', WARN],
  skipped: ['–', undefined],
};

/** Optional props are left out, never passed as undefined: a remote surface refuses undefined. */
const color = (c: string | false | undefined) => (c ? { color: c } : {});
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pad2 = (n: number) => String(n).padStart(2, '0');
const human = (id: string) => id.replace(/_/g, ' ');

/**
 * Daemon timestamps are UTC (ISO, or SQLite's `YYYY-MM-DD HH:MM:SS`); drawn local:
 * HH:MM:SS today, MM-DD HH:MM before.
 */
export function time(ts: string, now = new Date()): string {
  const d = new Date(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(ts) ? ts : `${ts.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return ts;
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.toDateString() === now.toDateString()
    ? `${clock}:${pad2(d.getSeconds())}`
    : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock}`;
}

const quote = (a: string) => (/[\s"'`$]/.test(a) || a === '' ? `"${a.replace(/"/g, '\\"')}"` : a);

type ViewProps = { el: El; on: Actions };

/** Id of a masked field: `plan` or `secret:<server>`, then the key. */
export const maskId = (scope: string, key: string) => `${scope}:${key}`;

type MaskedProps = ViewProps & {
  id: string;
  field: string;
  label: string;
  length: number;
  submitLabel: string;
  onSubmit: () => void;
};

/** An Input that only ever draws bullets: the typed value stays in register.tsx. */
function Masked({ el, on, id, field, label, length, submitLabel, onSubmit }: MaskedProps) {
  const { Input } = el;
  return Input ? (
    <Input
      key={field}
      label={label}
      placeholder="value, kept in the keychain"
      value={'•'.repeat(length)}
      submitLabel={submitLabel}
      onInput={(v) => on.mask(id, v)}
      onSubmit={onSubmit}
    />
  ) : null;
}

/** A section heading: bold, with an optional dim count or aside. */
function Heading({ el, title, aside }: { el: El; title: string; aside?: string }) {
  const { Text } = el;
  return (
    <Text wrap="truncate">
      <Text bold>{title}</Text>
      {aside ? <Text dimColor> {aside}</Text> : null}
    </Text>
  );
}

/** A label column beside a value that wraps under itself. */
function Fact({ el, label, children }: { el: El; label: string; children: unknown }) {
  const { Box, Text } = el;
  return (
    <Box columnGap={1}>
      <Box width={8} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        {children as never}
      </Box>
    </Box>
  );
}

/** A one-glyph mark beside text that wraps under itself, not under the mark. */
function Marked({
  el,
  mark,
  tone,
  text,
}: {
  el: El;
  mark: string;
  tone: string | undefined;
  text: string;
}) {
  const { Box, Text } = el;
  return (
    <Box>
      <Box width={2} flexShrink={0}>
        <Text {...color(tone)}>{mark}</Text>
      </Box>
      <Box flexShrink={1}>
        <Text {...(tone === undefined ? { dimColor: true } : {})}>{text}</Text>
      </Box>
    </Box>
  );
}

/** "‹ label": the way back to the list a view was opened from. */
function Back({
  el,
  k,
  label,
  onPress,
}: {
  el: El;
  k: string;
  label: string;
  onPress: () => void;
}) {
  const { Button } = el;
  return <Button key={k} label={`‹ ${label}`} plain dimColor onPress={onPress} />;
}

export type PaneProps = ViewProps & {
  snap: AgentDiscoverSnapshot;
  route: AgentDiscoverRoute;
  detail: AgentDiscoverDetail | null;
  tool: AgentDiscoverTool | null;
  confirm: string | null;
  browse: AgentDiscoverBrowse | null;
  plan: AgentDiscoverPlan | null;
  logs: AgentDiscoverLogs | null;
  audit: AgentDiscoverAudit | null;
  busy: string | null;
  notice: string | null;
  /** The pane holds the keyboard (Tab walks it), as the Pane site reports. */
  isFocused: boolean;
  /** The pane body's width (`bodyColumns`); lines stop at MAX_COLUMNS on wider panes. */
  columns: number;
  masked: Record<string, number>;
  editing: string | null;
};

/** Tab, label and the hotkey that opens it while the pane holds the keyboard. */
const TABS: [AgentDiscoverTab, string, string][] = [
  ['servers', 'Servers', '1'],
  ['browse', 'Browse', '2'],
  ['logs', 'Logs', '3'],
  ['audit', 'Audit', '4'],
];

/** Every `AuditAction` (src/domain/trust/audit.ts), for the filter. */
const AUDIT_ACTIONS = [
  'install',
  'uninstall',
  'enable',
  'disable',
  'call_tool',
  'approve',
  'deny',
  'quarantine',
  'release',
  'flag',
  'secret-set',
  'secret-delete',
  'shutdown',
  'sampling',
];
export const AUDIT_PAGE = 20;
/** Past this a row's name and its state drift too far apart to read as one line. */
const MAX_COLUMNS = 100;

/** `act` in register.tsx leads a failed outcome with ✗. */
const isFailure = (notice: string) => notice.startsWith('✗');

export function Pane(p: PaneProps) {
  const { Box, Text, Button, Code } = p.el;
  const { snap, route, on } = p;
  const width = Math.min(p.columns, MAX_COLUMNS);
  // Every tab needs the daemon: no tabs then, just what to do about it.
  if (!snap.isUp)
    return (
      <Box flexDirection="column" gap={1} width={width}>
        <Box flexDirection="column">
          <Text color={BAD} bold>
            The agent-discover daemon is not running
          </Text>
          <Text dimColor>
            Nothing answers at {snap.origin}. The next MCP call starts it, or run:
          </Text>
        </Box>
        <Code source="agent-discover daemon" language="shell" />
        <Button key="retry" label="Retry" variant="primary" onPress={on.refresh} />
      </Box>
    );
  let body;
  if (route.tab === 'servers' && route.server)
    body = p.detail ? (
      <Detail
        el={p.el}
        on={on}
        d={p.detail}
        tool={p.tool}
        confirm={p.confirm}
        masked={p.masked}
        editing={p.editing}
      />
    ) : (
      <Text dimColor>Loading {route.server}…</Text>
    );
  else if (route.tab === 'servers') body = <Servers el={p.el} on={on} snap={snap} />;
  else if (route.tab === 'browse')
    body = <Browse el={p.el} on={on} browse={p.browse} plan={p.plan} masked={p.masked} />;
  else if (route.tab === 'logs') body = <Logs el={p.el} on={on} logs={p.logs} />;
  else body = <Audit el={p.el} on={on} audit={p.audit} />;

  return (
    <Box flexDirection="column" gap={1} width={width}>
      <Box flexDirection="column">
        <Box flexWrap="wrap" columnGap={2}>
          {TABS.map(([tab, label, hotkey]) =>
            route.tab === tab && !route.server ? (
              <Text key={`tab:${tab}`}>
                <Text color={ACCENT}>{hotkey}: </Text>
                <Text bold underline>
                  {label}
                </Text>
              </Text>
            ) : (
              <Button
                key={`tab:${tab}`}
                label={label}
                hotkey={hotkey}
                plain
                {...(route.tab === tab ? {} : { dimColor: true })}
                onPress={() => on.go(tab)}
              />
            ),
          )}
          <Button key="refresh" label="Refresh" hotkey="r" plain dimColor onPress={on.refresh} />
        </Box>
        {/* One status line under the tabs: the action in flight, else its outcome, else the
            keys. Nothing above the view grows or shrinks as actions come and go. */}
        {p.busy ? (
          <Text color={WARN} wrap="truncate">
            {p.busy}…
          </Text>
        ) : p.notice ? (
          <Text {...color(isFailure(p.notice) ? BAD : OK)}>{p.notice}</Text>
        ) : (
          <Text dimColor wrap="truncate">
            {p.isFocused
              ? 'Tab moves · Enter presses · ↑↓ scroll · Esc to the prompt'
              : 'ctrl+x tab to work this pane from the keyboard'}
          </Text>
        )}
      </Box>
      {snap.elicitations.map((q) => (
        <Question key={`q:${q.id}`} el={p.el} on={on} q={q} />
      ))}
      {body}
    </Box>
  );
}

function Question({ el, on, q }: ViewProps & { q: AgentDiscoverElicitation }) {
  const { Box, Text, Button, Input, Select } = el;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={WARN} paddingX={1}>
      <Text color={WARN} bold>
        {q.server} asks
      </Text>
      <Text>{q.message}</Text>
      {q.fields.map((f) =>
        f.options.length && Select ? (
          <Select
            key={`q:${q.id}:${f.name}`}
            label={f.title}
            options={f.options.map((o) => ({ value: o, label: o }))}
            onSelect={(v) => on.answer(q.id, f.name, v)}
          />
        ) : (
          Input && (
            <Input
              key={`q:${q.id}:${f.name}`}
              label={`${f.title}${f.required ? ' *' : ''}`}
              submitLabel="set"
              onSubmit={(v) => on.answer(q.id, f.name, v)}
            />
          )
        ),
      )}
      <Box flexWrap="wrap" columnGap={1}>
        <Button
          key={`q:${q.id}:accept`}
          label="Accept"
          variant="primary"
          onPress={() => on.respond(q.id, 'accept')}
        />
        <Button
          key={`q:${q.id}:decline`}
          label="Decline"
          onPress={() => on.respond(q.id, 'decline')}
        />
        <Button
          key={`q:${q.id}:cancel`}
          label="Cancel"
          dimColor
          onPress={() => on.respond(q.id, 'cancel')}
        />
      </Box>
    </Box>
  );
}

function Servers({ el, on, snap }: ViewProps & { snap: AgentDiscoverSnapshot }) {
  const { Box, Text, Button } = el;
  const servers = snap.servers;
  if (servers.length === 0)
    return (
      <Box flexDirection="column" gap={1}>
        <Text>No MCP servers installed yet.</Text>
        <Button
          key="empty-browse"
          label="Browse for one"
          variant="primary"
          onPress={() => on.go('browse')}
        />
      </Box>
    );
  const enabled = servers.filter((s) => s.enabled).length;
  const sorted = sortServers(servers);
  return (
    <Box flexDirection="column" gap={1}>
      <Text wrap="truncate">
        <Text bold>{plural(servers.length, 'MCP server')}</Text>
        <Text dimColor> · {enabled} enabled</Text>
        {snap.attention.length > 0 && (
          <Text color={WARN}> · {snap.attention.length} to review</Text>
        )}
      </Text>
      <Box flexDirection="column">
        {sorted.map((s) => {
          const st = state(s);
          const facts = [
            plural(s.tool_count, 'tool'),
            st === 'quarantined' ? 'its tools changed: review them' : '',
            st === 'unhealthy' ? 'failing its health check' : '',
            s.error_count ? plural(s.error_count, 'error') : '',
            s.registry_status === 'deleted' ? 'removed from the registry' : '',
            s.description,
          ].filter(Boolean);
          return (
            <Box key={`row:${s.name}`} flexDirection="column">
              <Box columnGap={1}>
                <Text {...color(TONE[st])}>{MARK[st]}</Text>
                <Box flexGrow={1} flexShrink={1}>
                  <Button
                    key={`open:${s.name}`}
                    label={s.name}
                    plain
                    onPress={() => on.open(s.name)}
                  />
                </Box>
                <Box flexShrink={0}>
                  <Text {...color(TONE[st])} {...(st === 'installed' ? { dimColor: true } : {})}>
                    {st}
                  </Text>
                </Box>
              </Box>
              <Box paddingLeft={2}>
                <Text dimColor wrap="truncate">
                  {facts.join(' · ')}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

type DetailProps = ViewProps & {
  d: AgentDiscoverDetail;
  tool: AgentDiscoverTool | null;
  confirm: string | null;
  masked: Record<string, number>;
  editing: string | null;
};

function Detail({ el, on, d, tool, confirm, masked, editing }: DetailProps) {
  const { Box, Text, Button, Input, Link, Code } = el;
  const st = state(d);
  const where = d.command
    ? [d.command, ...d.args].map(quote).join(' ')
    : d.url
      ? `${d.url} (${d.transport})`
      : null;
  const pkg = d.package_name
    ? `${d.package_name}${d.package_version ? `@${d.package_version}` : ''}`
    : null;
  const healthStatus = d.health?.status ?? d.health_status;
  const health = d.health
    ? `${d.health.status} in ${d.health.latency_ms} ms${d.health.error ? `: ${d.health.error}` : ''}`
    : d.health_status === 'unknown'
      ? 'not checked yet'
      : `${d.health_status}${d.last_health_check ? `, checked ${time(d.last_health_check)}` : ''}`;
  const calls = d.metrics.reduce((n, m) => n + m.calls, 0);
  const failed = d.metrics.reduce((n, m) => n + m.errors, 0);
  const avg = calls ? d.metrics.reduce((n, m) => n + m.avg_ms * m.calls, 0) / calls : 0;
  const usage = calls
    ? `${plural(calls, 'call')}${failed ? `, ${failed} failed` : ''}, ${Math.round(avg)} ms avg`
    : 'no calls yet';
  const toolWidth = Math.min(22, Math.max(8, ...d.tools.map((t) => t.name.length + 2)));
  const missing = d.config.filter((c) => c.source === 'missing');
  const source = d.registry_name ? `${d.source} · ${d.registry_name}` : d.source;
  const value = (text: string, tone?: string) => (
    <Text {...color(tone)} wrap="wrap">
      {text}
    </Text>
  );

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Back el={el} k="back" label="Servers" onPress={() => on.go('servers')} />
        <Text wrap="truncate">
          <Text bold>{d.name}</Text>
          <Text {...color(TONE[st])}>
            {'  '}
            {MARK[st]} {st}
          </Text>
          {d.connected && <Text dimColor> · connected</Text>}
        </Text>
        {d.description && <Text dimColor>{d.description}</Text>}
      </Box>

      {d.drift && (
        <Box flexDirection="column" borderStyle="round" borderColor={BAD} paddingX={1}>
          <Text color={BAD} bold>
            Its tools changed since you approved them
          </Text>
          <Text dimColor>It stays off until you approve the new definitions.</Text>
          {d.drift.changed.map((c) => (
            <Box key={`chg:${c.tool}`} flexDirection="column" marginTop={1}>
              <Text>
                <Text color={WARN}>~ </Text>
                <Text bold>{c.tool}</Text>
                <Text dimColor> {c.what}</Text>
              </Text>
              {c.description && (
                <Box flexDirection="column" paddingLeft={2}>
                  <Text color={BAD}>- {c.description.before}</Text>
                  <Text color={OK}>+ {c.description.after}</Text>
                </Box>
              )}
            </Box>
          ))}
          {d.drift.added.map((t) => (
            <Text key={`add:${t}`}>
              <Text color={OK}>+ </Text>
              <Text bold>{t}</Text>
              <Text dimColor> new tool</Text>
            </Text>
          ))}
          {d.drift.removed.map((t) => (
            <Text key={`rm:${t}`}>
              <Text color={BAD}>- </Text>
              <Text bold>{t}</Text>
              <Text dimColor> removed</Text>
            </Text>
          ))}
          <Box flexWrap="wrap" columnGap={1} marginTop={1}>
            <Button
              key="approve"
              label="Approve"
              variant="primary"
              onPress={() => on.approve(d.name)}
            />
            <Button key="keep" label="Keep disabled" onPress={() => on.keepDisabled(d.name)} />
          </Box>
        </Box>
      )}

      <Box flexWrap="wrap" columnGap={1}>
        {!d.quarantined && (
          <Button
            key="toggle"
            label={d.enabled ? 'Disable' : 'Enable'}
            {...(d.enabled ? {} : { variant: 'primary' as const })}
            onPress={() => (d.enabled ? on.disable(d.name) : on.enable(d.name))}
          />
        )}
        <Button key="health" label="Check health" onPress={() => on.health(d.name)} />
        <Button key="reindex" label="Re-index" onPress={() => on.reindex(d.name)} />
        {d.error_count > 0 && (
          <Button key="reset" label="Reset errors" onPress={() => on.resetErrors(d.name)} />
        )}
        {confirm === `uninstall:${d.name}` ? null : (
          <Button
            key="uninstall"
            label="Uninstall"
            dimColor
            onPress={() => on.askUninstall(d.name)}
          />
        )}
      </Box>
      {confirm === `uninstall:${d.name}` && (
        <Box flexDirection="column">
          <Text color={WARN}>Uninstall {d.name}? Its config and secrets are removed.</Text>
          <Box columnGap={1}>
            <Button
              key="uninstall-yes"
              label="Uninstall"
              variant="primary"
              onPress={() => on.uninstall(d.name)}
            />
            <Button key="uninstall-no" label="Keep it" onPress={on.cancel} />
          </Box>
        </Box>
      )}

      <Box flexDirection="column">
        {where && (
          <Fact el={el} label="Runs">
            {value(where)}
          </Fact>
        )}
        <Fact el={el} label="Source">
          {value(source)}
        </Fact>
        {d.registry_status === 'deleted' && (
          <Fact el={el} label="Registry">
            {value('taken down by the MCP Registry', BAD)}
          </Fact>
        )}
        {pkg && (
          <Fact el={el} label="Package">
            {value(pkg)}
          </Fact>
        )}
        {d.tags.length > 0 && (
          <Fact el={el} label="Tags">
            {value(d.tags.join(', '))}
          </Fact>
        )}
        <Fact el={el} label="Health">
          {value(
            health,
            healthStatus === 'healthy' ? OK : healthStatus === 'unhealthy' ? BAD : undefined,
          )}
        </Fact>
        <Fact el={el} label="Usage">
          {value(usage)}
        </Fact>
        {d.error_count > 0 && (
          <Fact el={el} label="Errors">
            {value(`${d.error_count} since the last reset`, BAD)}
          </Fact>
        )}
      </Box>

      {d.auth && (
        <Box flexDirection="column">
          <Text>
            <Text bold>Sign-in </Text>
            <Text color={d.auth.status === 'authorized' ? OK : WARN}>
              {d.auth.status === 'authorized' ? 'signed in' : 'required'}
            </Text>
          </Text>
          {d.auth.status !== 'authorized' && (
            <Button
              key="signin"
              label="Sign in"
              variant="primary"
              onPress={() => on.signIn(d.name)}
            />
          )}
          {d.auth.authorize_url && (
            <Link href={d.auth.authorize_url} label="Open the sign-in page in your browser" />
          )}
        </Box>
      )}

      <Box flexDirection="column">
        <Heading el={el} title="Tools" aside={`(${d.tools.length})`} />
        {d.tools.length === 0 && <Text dimColor>Not indexed yet: Re-index lists them.</Text>}
        {d.tools.map((t) => {
          const m = d.metrics.find((x) => x.tool === t.name);
          const isOpen = tool?.server === d.name && tool.tool === t.name;
          return (
            <Box key={`tool:${t.name}`} flexDirection="column">
              <Box columnGap={1}>
                <Box width={toolWidth} flexShrink={0}>
                  <Button
                    key={`toolbtn:${t.name}`}
                    label={`${isOpen ? '▾' : '▸'} ${t.name}`}
                    plain
                    onPress={() => on.toggleTool(d.name, t.name)}
                  />
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text dimColor wrap="truncate">
                    {t.description.split('\n')[0]}
                  </Text>
                </Box>
                {m && (
                  <Box flexShrink={0}>
                    <Text {...(m.errors ? { color: BAD } : { dimColor: true })}>
                      {m.errors ? `${m.errors}/${m.calls} failed` : plural(m.calls, 'call')}
                    </Text>
                  </Box>
                )}
              </Box>
              {isOpen && (
                <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
                  <Text dimColor>{t.description}</Text>
                  <Code source={tool.schema} language="json" />
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      <Box flexDirection="column">
        <Heading el={el} title="Configuration" aside="(values are never shown)" />
        {d.config.length === 0 && <Text dimColor>No env vars, headers or secrets.</Text>}
        {d.config.map((c) => (
          <Box key={`cfg:${c.kind}:${c.key}`} flexWrap="wrap" columnGap={1}>
            <Text wrap="truncate">
              <Text bold>{c.key}</Text>
              <Text dimColor> {c.kind} · </Text>
              <Text {...color(SOURCE_TONE[c.source])}>{SOURCE[c.source]}</Text>
            </Text>
            {c.source !== 'missing' && (
              <Button
                key={`secedit:${c.key}`}
                label={c.source === 'secret' ? 'Replace' : 'Store as secret'}
                dimColor
                onPress={() => on.editSecret(c.key)}
              />
            )}
            {c.source === 'secret' && (
              <Button
                key={`secdel:${c.key}`}
                label="Delete"
                dimColor
                onPress={() => on.deleteSecret(d.name, c.key)}
              />
            )}
          </Box>
        ))}
        {[
          ...missing.map((c) => c.key),
          ...(editing && !missing.some((c) => c.key === editing) ? [editing] : []),
        ].map((key) => {
          const id = maskId(`secret:${d.name}`, key);
          return (
            <Masked
              key={`secset:${key}`}
              el={el}
              on={on}
              id={id}
              field={`secset:${key}`}
              label={key}
              length={masked[id] ?? 0}
              submitLabel="save"
              onSubmit={() => on.setSecret(d.name, key)}
            />
          );
        })}
        {editing && (
          <Button
            key="secedit-cancel"
            label="Cancel"
            plain
            dimColor
            onPress={() => on.editSecret(null)}
          />
        )}
        {Input && !editing && (
          <Input
            key="secadd"
            label="+ Secret"
            placeholder="KEY_NAME, then its value"
            submitLabel="next"
            onSubmit={on.addSecret}
          />
        )}
      </Box>
    </Box>
  );
}

type BrowseProps = ViewProps & {
  browse: AgentDiscoverBrowse | null;
  plan: AgentDiscoverPlan | null;
  masked: Record<string, number>;
};

function Browse({ el, on, browse, plan, masked }: BrowseProps) {
  const { Box, Text, Button, Input } = el;
  if (plan) return <Plan el={el} on={on} plan={plan} masked={masked} />;
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        {Input && (
          <Input
            key="search"
            label="Search"
            placeholder="what do you need? e.g. postgres"
            value={browse?.query ?? ''}
            submitLabel="search"
            onSubmit={on.search}
          />
        )}
        {!browse && (
          <Text dimColor>
            The MCP Registry, npm and PyPI. A result shows exactly what it runs before anything is
            installed.
          </Text>
        )}
        {browse && !browse.error && (
          <Text dimColor>
            {browse.results.length
              ? `${plural(browse.results.length, 'result')} for “${browse.query}” · Enter shows the install plan`
              : `Nothing found for “${browse.query}”.`}
          </Text>
        )}
        {browse?.error && <Text color={BAD}>{browse.error}</Text>}
        <Button
          key="sync"
          label="Sync the MCP Registry mirror"
          plain
          dimColor
          onPress={on.syncRegistry}
        />
      </Box>
      {browse && browse.results.length > 0 && (
        <Box flexDirection="column">
          {browse.results.map((r) => (
            <Box key={`res:${r.source}:${r.name}`} flexDirection="column">
              <Box columnGap={1}>
                <Box flexShrink={1}>
                  {r.installed ? (
                    <Button
                      key={`installed:${r.installed}`}
                      label={`✓ ${r.name}`}
                      plain
                      onPress={() => r.installed && on.open(r.installed)}
                    />
                  ) : (
                    <Button
                      key={`plan:${r.source}:${r.name}`}
                      label={`▸ ${r.name}`}
                      plain
                      onPress={() => on.showPlan(r)}
                    />
                  )}
                </Box>
                <Box flexShrink={0}>
                  <Text dimColor>
                    {[r.version, r.source, r.status !== 'active' ? r.status : '']
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                  {r.installed && <Text color={OK}> · installed</Text>}
                </Box>
              </Box>
              <Box paddingLeft={2}>
                <Text dimColor wrap="truncate">
                  {r.description}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

function Plan({
  el,
  on,
  plan,
  masked,
}: ViewProps & { plan: AgentDiscoverPlan; masked: Record<string, number> }) {
  const { Box, Text, Button, Input, Code } = el;
  const runs = plan.command
    ? [plan.command, ...plan.args].map(quote).join(' ')
    : `${plan.url ?? ''} (${plan.transport})`;
  const facts: [string, string | undefined, string][] = [
    plan.pinned ? ['✓', OK, 'version pinned'] : ['!', WARN, 'version not pinned: it can change'],
    ...(plan.publisher
      ? [
          ['✓', OK, `publisher ${plan.publisher}, verified by the MCP Registry`] as [
            string,
            string,
            string,
          ],
        ]
      : []),
    ...(plan.registry_status && plan.registry_status !== 'active'
      ? [['!', WARN, `registry status ${plan.registry_status}`] as [string, string, string]]
      : []),
    ...plan.checks.map((c): [string, string | undefined, string] => {
      const [mark, tone] = CHECK[c.status] ?? ['·', undefined];
      return [mark, tone, `${human(c.id)}${c.detail ? `: ${c.detail}` : ''}`];
    }),
    ...(plan.repository
      ? [['·', undefined, `source ${plan.repository}`] as [string, undefined, string]]
      : []),
  ];
  const missing = plan.requirements.filter(
    (r) => r.required && !r.present && !plan.filled.includes(r.key),
  );
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Back el={el} k="plan-back" label="Results" onPress={on.cancelPlan} />
        <Text bold wrap="truncate">
          Install {plan.server}
          {plan.version ? ` ${plan.version}` : ''}?
        </Text>
        <Text dimColor wrap="truncate">
          {plan.name} · {plan.source}
        </Text>
      </Box>
      <Box flexDirection="column">
        <Text dimColor>{plan.command ? 'Runs on this machine' : 'Connects to'}</Text>
        <Code source={runs} language="shell" />
      </Box>
      <Box flexDirection="column">
        <Heading el={el} title="Checks" />
        {facts.map(([mark, tone, text]) => (
          <Marked key={`fact:${text}`} el={el} mark={mark} tone={tone} text={text} />
        ))}
        {plan.warnings.map((w) => (
          <Marked key={`warn:${w}`} el={el} mark="!" tone={WARN} text={w} />
        ))}
        {plan.blocked && (
          <Marked el={el} mark="✗" tone={BAD} text={`Cannot install: ${plan.blocked}`} />
        )}
      </Box>
      {plan.requirements.length > 0 && (
        <Box flexDirection="column">
          <Heading el={el} title="Needs" />
          {plan.requirements.map((r) => {
            const isTyped = plan.filled.includes(r.key);
            const isSet = r.present || isTyped;
            return (
              <Box key={`req:${r.key}`} flexDirection="column">
                <Text wrap="truncate">
                  <Text {...color(isSet ? OK : r.required ? WARN : undefined)}>
                    {isSet ? '✓' : r.required ? '!' : '·'}{' '}
                  </Text>
                  <Text bold>{r.key}</Text>
                  <Text dimColor>
                    {' '}
                    {[
                      r.kind,
                      r.required ? 'required' : 'optional',
                      r.secret && 'secret',
                      r.present ? 'already set' : isTyped && 'typed',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </Text>
                {!r.present &&
                  (r.secret ? (
                    <Masked
                      key={`reqset:${r.key}`}
                      el={el}
                      on={on}
                      id={maskId('plan', r.key)}
                      field={`reqset:${r.key}`}
                      label={`  ${r.key}`}
                      length={masked[maskId('plan', r.key)] ?? 0}
                      submitLabel="set"
                      onSubmit={() => on.fillSecret(r.key)}
                    />
                  ) : (
                    Input && (
                      <Input
                        key={`reqset:${r.key}`}
                        label={`  ${r.key}`}
                        placeholder="value"
                        submitLabel="set"
                        onSubmit={(v) => on.fill(r.key, v)}
                      />
                    )
                  ))}
              </Box>
            );
          })}
        </Box>
      )}
      {!plan.blocked && missing.length > 0 && (
        <Text color={WARN}>Set {missing.map((r) => r.key).join(', ')} to install.</Text>
      )}
      <Box flexWrap="wrap" columnGap={1}>
        {!plan.blocked && missing.length === 0 && (
          <Button
            key="install-enable"
            label="Install and enable"
            variant="primary"
            onPress={() => on.install(true)}
          />
        )}
        {!plan.blocked && missing.length === 0 && (
          <Button key="install" label="Install only" onPress={() => on.install(false)} />
        )}
        <Button key="plan-cancel" label="Cancel" dimColor onPress={on.cancelPlan} />
      </Box>
    </Box>
  );
}

function Logs({ el, on, logs }: ViewProps & { logs: AgentDiscoverLogs | null }) {
  const { Box, Text, Button } = el;
  const callWidth = Math.max(
    0,
    ...(logs?.entries ?? []).map((e) => e.server.length + e.tool.length + 1),
  );
  return (
    <Box flexDirection="column" gap={1}>
      <Box columnGap={2}>
        <Heading
          el={el}
          title="Recent calls"
          aside={logs ? `${logs.total} kept · newest first` : undefined}
        />
        <Button key="logs-reload" label="Reload" plain dimColor onPress={on.reloadLogs} />
      </Box>
      <Box flexDirection="column">
        {!logs && <Text dimColor>Loading…</Text>}
        {logs?.entries.length === 0 && (
          <Text dimColor>No calls yet. Tool calls through agent-discover show here.</Text>
        )}
        {logs?.entries.map((e) => (
          <Box key={`log:${e.id}`} flexDirection="column">
            <Text wrap="truncate">
              <Text dimColor>{time(e.time)} </Text>
              <Text {...color(e.error ? BAD : undefined)}>
                {e.error ? '✗' : '✓'} {`${e.server}/${e.tool}`.padEnd(callWidth)}
              </Text>
              <Text dimColor> {`${e.ms} ms`.padStart(8)}</Text>
            </Text>
            {e.error && (
              <Box paddingLeft={2}>
                <Text color={BAD} wrap="truncate">
                  {e.error}
                </Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function Audit({ el, on, audit }: ViewProps & { audit: AgentDiscoverAudit | null }) {
  const { Box, Text, Button, Input, Select } = el;
  const actionWidth = Math.max(0, ...(audit?.entries ?? []).map((e) => e.action.length));
  /** Entries on this page and every newer one: the cursors are the pages above. */
  const seen = audit ? audit.cursors.length * AUDIT_PAGE + audit.entries.length : 0;
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box columnGap={2}>
          <Heading el={el} title="Audit log" aside="installs, approvals, secrets, calls" />
          <Button key="audit-reload" label="Reload" plain dimColor onPress={on.reloadAudit} />
        </Box>
        {Select && (
          <Select
            key="audit-action"
            label="Action"
            value={audit?.action ?? ''}
            options={[
              { value: '', label: 'all' },
              ...AUDIT_ACTIONS.map((a) => ({ value: a, label: a })),
            ]}
            onSelect={(v) => on.filterAudit('action', v)}
          />
        )}
        {Input && (
          <Input
            key="audit-server"
            label="Server"
            placeholder="all"
            value={audit?.server ?? ''}
            submitLabel="filter"
            onSubmit={(v) => on.filterAudit('server', v.trim())}
          />
        )}
      </Box>
      <Box flexDirection="column">
        {!audit && <Text dimColor>Loading…</Text>}
        {audit?.entries.length === 0 && <Text dimColor>No entries.</Text>}
        {audit?.entries.map((e) => (
          <Text key={`audit:${e.id}`} wrap="truncate">
            <Text dimColor>{time(e.ts)} </Text>
            <Text {...color(e.isError ? BAD : undefined)}>{e.action.padEnd(actionWidth)} </Text>
            <Text>
              {e.server ?? ''}
              {e.tool ? `/${e.tool}` : ''}
            </Text>
            {e.ms !== null && <Text dimColor> {e.ms} ms</Text>}
          </Text>
        ))}
      </Box>
      {audit && (
        <Box flexWrap="wrap" columnGap={2}>
          <Text dimColor>
            {audit.entries.length
              ? `${seen - audit.entries.length + 1}-${seen} of ${audit.total}`
              : `${audit.total} total`}
          </Text>
          {audit.cursors.length > 0 && (
            <Button key="audit-newer" label="‹ Newer" plain onPress={on.newerAudit} />
          )}
          {seen < audit.total && (
            <Button key="audit-older" label="Older ›" plain onPress={on.olderAudit} />
          )}
        </Box>
      )}
    </Box>
  );
}

export function Band({ el, snap, on }: ViewProps & { snap: AgentDiscoverSnapshot }) {
  const { Box, Text, Button } = el;
  const what = [
    snap.attention.length > 0 &&
      `${snap.attention.join(', ')} ${snap.attention.length === 1 ? 'needs' : 'need'} a look`,
    snap.elicitations.length > 0 &&
      `${plural(snap.elicitations.length, 'question')} waiting for you`,
  ].filter(Boolean);

  return (
    <Box columnGap={1} flexWrap="wrap">
      <Text color={WARN}>MCP: {what.join(' · ')}</Text>
      <Button key="open" label="Review" variant="primary" onPress={on.openFromBand} />
      <Button key="dismiss" label="Dismiss" dimColor onPress={on.dismiss} />
    </Box>
  );
}
