// Trees for the /discover pane and the attention band. Pure: state in, elements out;
// the actions come from register.tsx. Sized for 80 columns and a docked pane: rows
// truncate, button rows wrap.
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

const state = (s: { quarantined: boolean; enabled: boolean; health_status: string }) =>
  s.quarantined
    ? 'quarantined'
    : s.enabled && s.health_status === 'unhealthy'
      ? 'unhealthy'
      : s.enabled
        ? 'enabled'
        : 'installed';

const TONE: Record<string, string> = { quarantined: 'red', unhealthy: 'red', enabled: 'green' };
const TONE_HEALTH: Record<string, string> = { healthy: 'green', unhealthy: 'red' };
const SOURCE: Record<AgentDiscoverConfigKey['source'], string> = {
  secret: '•••••• secret (keychain)',
  value: '•••••• set in the config',
  missing: 'missing: set it below',
};
const SOURCE_TONE: Record<string, string> = { secret: 'green', missing: 'yellow' };

/** Optional props are left out, never passed as undefined: a remote surface refuses undefined. */
const color = (c: string | false | undefined) => (c ? { color: c } : {});
const primary = (is: boolean) => (is ? { variant: 'primary' as const } : {});
const MARK: Record<string, string> = {
  quarantined: '!',
  unhealthy: '✗',
  enabled: '●',
  installed: '○',
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pad2 = (n: number) => String(n).padStart(2, '0');
/** Daemon timestamps are UTC (ISO, or SQLite's `YYYY-MM-DD HH:MM:SS`); drawn local, MM-DD HH:MM:SS. */
const time = (ts: string) => {
  const d = new Date(/[zZ]|[+-]dd:?dd$/.test(ts) ? ts : `${ts.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return ts;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
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
      placeholder="type the value: shown as dots, kept in the keychain"
      value={'•'.repeat(length)}
      submitLabel={submitLabel}
      onInput={(v) => on.mask(id, v)}
      onSubmit={onSubmit}
    />
  ) : null;
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
  masked: Record<string, number>;
  editing: string | null;
};

const TABS: [AgentDiscoverTab, string][] = [
  ['servers', 'Servers'],
  ['browse', 'Browse'],
  ['logs', 'Logs'],
  ['audit', 'Audit'],
];

export function Pane(p: PaneProps) {
  const { Box, Text, Button } = p.el;
  const { snap, route, on } = p;
  const enabled = snap.servers.filter((s) => s.enabled).length;
  let body;
  if (!snap.isUp) body = <Text color="red">The daemon does not answer at {snap.origin}.</Text>;
  else if (route.tab === 'servers' && route.server)
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
      <Text dimColor>Loading {route.server}...</Text>
    );
  else if (route.tab === 'servers') body = <Servers el={p.el} on={on} servers={snap.servers} />;
  else if (route.tab === 'browse')
    body = <Browse el={p.el} on={on} browse={p.browse} plan={p.plan} masked={p.masked} />;
  else if (route.tab === 'logs') body = <Logs el={p.el} on={on} logs={p.logs} />;
  else body = <Audit el={p.el} on={on} audit={p.audit} />;

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexWrap="wrap" columnGap={1}>
        {TABS.map(([tab, label]) => (
          <Button
            key={`tab:${tab}`}
            label={label}
            {...primary(route.tab === tab)}
            onPress={() => on.go(tab)}
          />
        ))}
        <Button key="refresh" label="Refresh" dimColor onPress={on.refresh} />
        {snap.isUp && (
          <Text dimColor>
            MCP {enabled}/{snap.servers.length}
          </Text>
        )}
      </Box>
      <Text dimColor wrap="truncate">
        {p.isFocused
          ? 'Tab / shift+Tab move · Enter presses · ↑↓ scroll · Esc back to the prompt'
          : 'ctrl+x tab: use this pane from the keyboard'}
      </Text>
      {p.busy ? (
        <Text color="yellow">{p.busy}...</Text>
      ) : (
        p.notice && <Text dimColor>{p.notice}</Text>
      )}
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
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">{q.server} asks:</Text>
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

function Servers({ el, on, servers }: ViewProps & { servers: AgentDiscoverServer[] }) {
  const { Box, Text, Button } = el;
  if (servers.length === 0)
    return <Text dimColor>No servers installed yet. Browse finds one to install.</Text>;
  const order = ['quarantined', 'unhealthy', 'enabled', 'installed'];
  const sorted = [...servers].sort(
    (a, b) => order.indexOf(state(a)) - order.indexOf(state(b)) || a.name.localeCompare(b.name),
  );
  const nameWidth = Math.min(32, Math.max(...servers.map((s) => s.name.length)));
  return (
    <Box flexDirection="column">
      {sorted.map((s) => {
        const st = state(s);
        return (
          <Box key={`row:${s.name}`} columnGap={1}>
            <Text {...color(TONE[st])}>{MARK[st]}</Text>
            <Box width={nameWidth} flexShrink={0}>
              <Button key={`open:${s.name}`} label={s.name} plain onPress={() => on.open(s.name)} />
            </Box>
            <Box width={12} flexShrink={0}>
              <Text {...color(TONE[st])}>{st}</Text>
            </Box>
            <Text dimColor wrap="truncate">
              {plural(s.tool_count, 'tool')}
              {s.error_count ? `, ${plural(s.error_count, 'error')}` : ''}
              {s.registry_status === 'deleted' ? ', removed from the registry' : ''}
              {s.description ? ` · ${s.description}` : ''}
            </Text>
          </Box>
        );
      })}
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
  const fact = (label: string, value: string | null, tone?: string) =>
    value && (
      <Text key={`fact:${label}`} wrap="truncate">
        <Text dimColor>{label.padEnd(9)}</Text>
        <Text {...color(tone)}>{value}</Text>
      </Text>
    );
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
      : `${d.health_status}${d.last_health_check ? ` (checked ${time(d.last_health_check)})` : ''}`;
  const calls = d.metrics.reduce((n, m) => n + m.calls, 0);
  const failed = d.metrics.reduce((n, m) => n + m.errors, 0);
  const avg = calls ? d.metrics.reduce((n, m) => n + m.avg_ms * m.calls, 0) / calls : 0;
  const usage = calls
    ? `${plural(calls, 'call')}, ${failed} failed, ${Math.round(avg)} ms average`
    : 'no calls yet';
  const toolWidth = Math.min(26, Math.max(...d.tools.map((t) => t.name.length + 2)));
  const keyWidth = Math.min(28, Math.max(...d.config.map((c) => c.key.length)));
  const missing = d.config.filter((c) => c.source === 'missing');

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box columnGap={1}>
          <Button key="back" label="< Servers" dimColor onPress={() => on.go('servers')} />
          <Text bold>{d.name}</Text>
          <Text {...color(TONE[st])}>{st}</Text>
          {d.connected && <Text dimColor>connected</Text>}
        </Box>
        {d.description && <Text dimColor>{d.description}</Text>}
      </Box>

      {d.drift && (
        <Box flexDirection="column">
          <Text color="red" bold>
            Tools changed since approval: review before use
          </Text>
          {d.drift.changed.map((c) => (
            <Box key={`chg:${c.tool}`} flexDirection="column">
              <Text wrap="truncate">
                ~ {c.tool}: {c.what}
              </Text>
              {c.description && (
                <Box flexDirection="column" paddingLeft={4}>
                  <Text dimColor>was: {c.description.before}</Text>
                  <Text color="yellow">now: {c.description.after}</Text>
                </Box>
              )}
            </Box>
          ))}
          {d.drift.added.map((t) => (
            <Text key={`add:${t}`} color="green">
              + {t}
            </Text>
          ))}
          {d.drift.removed.map((t) => (
            <Text key={`rm:${t}`} color="red">
              - {t}
            </Text>
          ))}
          <Box flexWrap="wrap" columnGap={1}>
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
            {...primary(!d.enabled)}
            onPress={() => (d.enabled ? on.disable(d.name) : on.enable(d.name))}
          />
        )}
        <Button key="reindex" label="Re-index" onPress={() => on.reindex(d.name)} />
        <Button key="health" label="Check health" onPress={() => on.health(d.name)} />
        {d.error_count > 0 && (
          <Button key="reset" label="Reset errors" onPress={() => on.resetErrors(d.name)} />
        )}
        {confirm === `uninstall:${d.name}` ? (
          <Box columnGap={1}>
            <Button
              key="uninstall-yes"
              label={`Uninstall ${d.name}`}
              variant="primary"
              onPress={() => on.uninstall(d.name)}
            />
            <Button key="uninstall-no" label="Keep it" onPress={on.cancel} />
          </Box>
        ) : (
          <Button
            key="uninstall"
            label="Uninstall"
            dimColor
            onPress={() => on.askUninstall(d.name)}
          />
        )}
      </Box>

      <Box flexDirection="column">
        {fact('Runs', where)}
        {fact('Source', d.registry_name ? `${d.source} ${d.registry_name}` : d.source)}
        {d.registry_status === 'deleted' &&
          fact('Registry', 'deleted (taken down by the MCP Registry)', 'red')}
        {fact('Package', pkg)}
        {fact('Tags', d.tags.join(', '))}
        {fact('Health', health, TONE_HEALTH[healthStatus])}
        {fact('Usage', usage)}
        {d.error_count > 0 && fact('Errors', `${d.error_count} since the last reset`, 'red')}
      </Box>

      {d.auth && (
        <Box flexDirection="column">
          <Text>
            <Text bold>Sign-in </Text>
            <Text color={d.auth.status === 'authorized' ? 'green' : 'yellow'}>
              {d.auth.status === 'authorized' ? 'signed in' : 'required'}
            </Text>
          </Text>
          {d.auth.status !== 'authorized' && (
            <Button key="signin" label="Sign in" onPress={() => on.signIn(d.name)} />
          )}
          {d.auth.authorize_url && (
            <Link href={d.auth.authorize_url} label="Open the sign-in page in your browser" />
          )}
        </Box>
      )}

      <Box flexDirection="column">
        <Text bold>Tools ({d.tools.length})</Text>
        {d.tools.length === 0 && <Text dimColor>Not indexed yet: Re-index.</Text>}
        {d.tools.map((t) => {
          const m = d.metrics.find((x) => x.tool === t.name);
          const isOpen = tool?.server === d.name && tool.tool === t.name;
          return (
            <Box key={`tool:${t.name}`} flexDirection="column">
              <Box columnGap={1}>
                <Box width={toolWidth} flexShrink={0}>
                  <Button
                    key={`toolbtn:${t.name}`}
                    label={`${isOpen ? 'v' : '>'} ${t.name}`}
                    plain
                    onPress={() => on.toggleTool(d.name, t.name)}
                  />
                </Box>
                <Text dimColor wrap="truncate">
                  {t.description.split('\n')[0]}
                  {m
                    ? ` · ${plural(m.calls, 'call')}${m.errors ? `, ${m.errors} failed` : ''}`
                    : ''}
                </Text>
              </Box>
              {isOpen && (
                <Box flexDirection="column" paddingLeft={2}>
                  {t.description.includes('\n') && <Text dimColor>{t.description}</Text>}
                  <Code source={tool.schema} language="json" />
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      <Box flexDirection="column">
        <Text bold>Configuration and secrets</Text>
        {d.config.length === 0 && <Text dimColor>No env vars, headers or secrets.</Text>}
        {d.config.map((c) => (
          <Box key={`cfg:${c.kind}:${c.key}`} columnGap={1}>
            <Box width={keyWidth} flexShrink={0}>
              <Text wrap="truncate">{c.key}</Text>
            </Box>
            <Box width={6} flexShrink={0}>
              <Text dimColor>{c.kind}</Text>
            </Box>
            <Text {...color(SOURCE_TONE[c.source])}>{SOURCE[c.source]}</Text>
            {c.source !== 'missing' && (
              <Button
                key={`secedit:${c.key}`}
                label={c.source === 'secret' ? 'Replace' : 'Set secret'}
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
            dimColor
            onPress={() => on.editSecret(null)}
          />
        )}
        {Input && !editing && (
          <Input
            key="secadd"
            label="New secret"
            placeholder="its key, e.g. API_TOKEN (the value comes next, masked)"
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
        <Button
          key="sync"
          label="Sync the MCP Registry mirror"
          dimColor
          onPress={on.syncRegistry}
        />
      </Box>
      {browse?.error && <Text color="red">{browse.error}</Text>}
      {browse && browse.results.length === 0 && !browse.error && (
        <Text dimColor>Nothing found for "{browse.query}".</Text>
      )}
      {browse?.results.map((r) => (
        <Box key={`res:${r.source}:${r.name}`} flexDirection="column">
          <Box columnGap={1}>
            {r.isInstalled ? (
              <Text bold>{r.name}</Text>
            ) : (
              <Button
                key={`plan:${r.source}:${r.name}`}
                label={r.name}
                plain
                onPress={() => on.showPlan(r)}
              />
            )}
            <Text dimColor wrap="truncate">
              {[
                r.version,
                r.source,
                r.status !== 'active' ? r.status : '',
                r.isInstalled ? 'installed' : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </Box>
          <Text dimColor wrap="truncate">
            {'  '}
            {r.description}
          </Text>
        </Box>
      ))}
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
  const facts = [
    plan.pinned ? 'version pinned' : 'version NOT pinned',
    plan.publisher && `publisher ${plan.publisher} (verified by the MCP Registry)`,
    plan.registry_status &&
      plan.registry_status !== 'active' &&
      `registry status ${plan.registry_status}`,
    plan.repository && `repository ${plan.repository}`,
  ].filter((f): f is string => Boolean(f));
  const missing = plan.requirements.filter(
    (r) => r.required && !r.present && !plan.filled.includes(r.key),
  );
  return (
    <Box flexDirection="column" gap={1}>
      <Box columnGap={1}>
        <Button key="plan-back" label="< Results" dimColor onPress={on.cancelPlan} />
        <Text bold>
          Install {plan.server}
          {plan.version ? ` ${plan.version}` : ''}?
        </Text>
      </Box>
      <Box flexDirection="column">
        <Text dimColor>{plan.command ? 'Runs on this machine:' : 'Connects to:'}</Text>
        <Code source={runs} language="shell" />
      </Box>
      <Box flexDirection="column">
        {facts.map((f) => (
          <Text key={`fact:${f}`} wrap="truncate">
            · {f}
          </Text>
        ))}
        {plan.checks.map((c) => (
          <Text
            key={`check:${c.id}`}
            {...color(c.status === 'pass' ? 'green' : c.status === 'fail' && 'red')}
            wrap="truncate"
          >
            {c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '·'} {c.id}: {c.detail}
          </Text>
        ))}
        {plan.warnings.map((w) => (
          <Text key={`warn:${w}`} color="yellow">
            ! {w}
          </Text>
        ))}
        {plan.blocked && <Text color="red">Cannot install: {plan.blocked}</Text>}
      </Box>
      {plan.requirements.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Needs</Text>
          {plan.requirements.map((r) => (
            <Text key={`req:${r.key}`} wrap="truncate">
              {r.present || plan.filled.includes(r.key) ? '✓' : r.required ? '!' : '·'} {r.key}
              <Text dimColor>
                {' '}
                ({r.kind}
                {r.required ? ', required' : ''}
                {r.secret ? ', secret' : ''})
              </Text>
            </Text>
          ))}
          {plan.requirements
            .filter((r) => !r.present)
            .map((r) =>
              r.secret ? (
                <Masked
                  key={`reqset:${r.key}`}
                  el={el}
                  on={on}
                  id={maskId('plan', r.key)}
                  field={`reqset:${r.key}`}
                  label={r.key}
                  length={masked[maskId('plan', r.key)] ?? 0}
                  submitLabel="set"
                  onSubmit={() => on.fillSecret(r.key)}
                />
              ) : (
                Input && (
                  <Input
                    key={`reqset:${r.key}`}
                    label={r.key}
                    placeholder="value"
                    submitLabel="set"
                    onSubmit={(v) => on.fill(r.key, v)}
                  />
                )
              ),
            )}
        </Box>
      )}
      {!plan.blocked && (
        <Box flexWrap="wrap" columnGap={1}>
          {missing.length > 0 ? (
            <Text key="install-disabled" dimColor>
              Install and enable | Install only
            </Text>
          ) : (
            <>
              <Button
                key="install-enable"
                label="Install and enable"
                variant="primary"
                onPress={() => on.install(true)}
              />
              <Button key="install" label="Install only" onPress={() => on.install(false)} />
            </>
          )}
          <Button key="plan-cancel" label="Cancel" dimColor onPress={on.cancelPlan} />
          {missing.length > 0 && (
            <Text color="yellow">missing: {missing.map((r) => r.key).join(', ')}</Text>
          )}
        </Box>
      )}
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
    <Box flexDirection="column">
      <Box columnGap={1}>
        <Text bold>Recent proxied calls</Text>
        {logs && <Text dimColor>({logs.total} kept)</Text>}
        <Button key="logs-reload" label="Reload" dimColor onPress={on.reloadLogs} />
      </Box>
      {!logs && <Text dimColor>Loading...</Text>}
      {logs?.entries.length === 0 && <Text dimColor>No calls yet.</Text>}
      {logs?.entries.map((e) => (
        <Text key={`log:${e.id}`} {...color(Boolean(e.error) && 'red')} wrap="truncate">
          {time(e.time)} {`${e.server}/${e.tool}`.padEnd(callWidth)} {`${e.ms} ms`.padStart(8)}
          {e.error ? `  ${e.error}` : ''}
        </Text>
      ))}
    </Box>
  );
}

function Audit({ el, on, audit }: ViewProps & { audit: AgentDiscoverAudit | null }) {
  const { Box, Text, Button, Input } = el;
  const actionWidth = Math.max(0, ...(audit?.entries ?? []).map((e) => e.action.length));
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
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
        {Input && (
          <Input
            key="audit-action"
            label="Action"
            placeholder="all (install, enable, call_tool, approve, quarantine, ...)"
            value={audit?.action ?? ''}
            submitLabel="filter"
            onSubmit={(v) => on.filterAudit('action', v.trim())}
          />
        )}
      </Box>
      <Box flexDirection="column">
        {!audit && <Text dimColor>Loading...</Text>}
        {audit?.entries.length === 0 && <Text dimColor>No entries.</Text>}
        {audit?.entries.map((e) => (
          <Text key={`audit:${e.id}`} {...color(e.isError && 'red')} wrap="truncate">
            {time(e.ts)} {e.action.padEnd(actionWidth)} {e.server ?? ''}
            {e.tool ? `/${e.tool}` : ''}
          </Text>
        ))}
      </Box>
      {audit && (
        <Box flexWrap="wrap" columnGap={1}>
          {audit.cursors.length > 0 && (
            <Button key="audit-newer" label="Newer" onPress={on.newerAudit} />
          )}
          {audit.entries.length > 0 && audit.entries.at(-1)!.id > 1 && (
            <Button key="audit-older" label="Older" onPress={on.olderAudit} />
          )}
          <Text dimColor>{audit.total} total</Text>
        </Box>
      )}
    </Box>
  );
}

export function Band({ el, snap, on }: ViewProps & { snap: AgentDiscoverSnapshot }) {
  const { Box, Text, Button } = el;
  const what = [
    snap.attention.length > 0 && `needs a look: ${snap.attention.join(', ')}`,
    snap.elicitations.length > 0 && `${snap.elicitations.length} question(s) waiting for you`,
  ].filter(Boolean);

  return (
    <Box columnGap={1} flexWrap="wrap">
      <Text color="yellow">agent-discover: {what.join('; ')}</Text>
      <Button key="open" label="Review" variant="primary" onPress={on.openFromBand} />
      <Button key="dismiss" label="Dismiss" dimColor onPress={on.dismiss} />
    </Box>
  );
}
