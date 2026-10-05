// Trees for the /discover pane and the attention band. Pure: state in, elements out;
// the actions come from register.tsx. Sized for 80 columns and a docked pane: rows
// truncate, button rows wrap.
import type { Elements } from 'claude-code';

import type {
  AgentDiscoverAudit,
  AgentDiscoverBrowse,
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
  setSecret: (name: string, key: string, value: string) => void;
  addSecret: (name: string, pair: string) => void;
  deleteSecret: (name: string, key: string) => void;
  toggleTool: (name: string, tool: string) => void;
  search: (query: string) => void;
  syncRegistry: () => void;
  showPlan: (entry: AgentDiscoverEntry) => void;
  fill: (key: string, value: string) => void;
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
const time = (iso: string) => iso.replace('T', ' ').slice(5, 19);
const quote = (a: string) => (/[\s"'`$]/.test(a) || a === '' ? `"${a.replace(/"/g, '\\"')}"` : a);

type ViewProps = { el: El; on: Actions };

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
      <Detail el={p.el} on={on} d={p.detail} tool={p.tool} confirm={p.confirm} />
    ) : (
      <Text dimColor>Loading {route.server}...</Text>
    );
  else if (route.tab === 'servers') body = <Servers el={p.el} on={on} servers={snap.servers} />;
  else if (route.tab === 'browse')
    body = <Browse el={p.el} on={on} browse={p.browse} plan={p.plan} />;
  else if (route.tab === 'logs') body = <Logs el={p.el} on={on} logs={p.logs} />;
  else body = <Audit el={p.el} on={on} audit={p.audit} />;

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexWrap="wrap" columnGap={1}>
        {TABS.map(([tab, label]) => (
          <Button
            key={`tab:${tab}`}
            label={label}
            {...primary(route.tab === tab && !(tab === 'servers' && route.server))}
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
  return (
    <Box flexDirection="column">
      {sorted.map((s) => {
        const st = state(s);
        return (
          <Box key={`row:${s.name}`} columnGap={1}>
            <Text {...color(TONE[st])}>{MARK[st]}</Text>
            <Button key={`open:${s.name}`} label={s.name} plain onPress={() => on.open(s.name)} />
            <Text dimColor wrap="truncate">
              {st}, {plural(s.tool_count, 'tool')}
              {s.error_count ? `, ${plural(s.error_count, 'error')}` : ''}
              {s.registry_status === 'deleted' ? ', removed from the registry' : ''}
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
};

function Detail({ el, on, d, tool, confirm }: DetailProps) {
  const { Box, Text, Button, Input, Link, Code } = el;
  const st = state(d);
  const fact = (label: string, value: string | null) =>
    value && (
      <Text key={`fact:${label}`} wrap="truncate">
        <Text dimColor>{label}: </Text>
        {value}
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
  const health = d.health
    ? `${d.health.status} in ${d.health.latency_ms} ms${d.health.error ? `: ${d.health.error}` : ''}`
    : `${d.health_status}${d.last_health_check ? ` (checked ${time(d.last_health_check)})` : ''}`;

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box columnGap={1}>
          <Button key="back" label="< Servers" dimColor onPress={() => on.go('servers')} />
          <Text bold>{d.name}</Text>
          <Text {...color(TONE[st])}>{st}</Text>
          {d.connected && <Text dimColor>connected</Text>}
        </Box>
        {d.description && (
          <Text dimColor wrap="truncate">
            {d.description}
          </Text>
        )}
      </Box>

      {d.drift && (
        <Box flexDirection="column">
          <Text color="red" bold>
            Tools changed since approval: review before use
          </Text>
          {d.drift.changed.map((c) => (
            <Text key={`chg:${c.tool}`} wrap="truncate">
              ~ {c.tool}: {c.what}
            </Text>
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

      <Box flexDirection="column">
        {fact('Runs', where)}
        {fact('Source', d.registry_name ? `${d.source} ${d.registry_name}` : d.source)}
        {d.registry_status === 'deleted' &&
          fact('Registry', 'deleted (taken down by the MCP Registry)')}
        {fact('Package', pkg)}
        {fact('Tags', d.tags.join(', '))}
        {fact('Env keys', d.env_keys.join(', '))}
        {fact('Header keys', d.header_keys.join(', '))}
        {fact('Health', health)}
        {d.error_count > 0 && fact('Errors', String(d.error_count))}
      </Box>

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

      {d.auth && (
        <Box flexDirection="column">
          <Text>
            <Text dimColor>Sign-in: </Text>
            {d.auth.status}
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
        <Text bold>Secrets</Text>
        {d.missing_secrets.map((k) => (
          <Text key={`miss:${k}`} color="yellow">
            missing: {k}
          </Text>
        ))}
        {d.secrets.map((k) => (
          <Box key={`sec:${k}`} columnGap={1}>
            <Text>{k}</Text>
            <Text dimColor>set</Text>
            <Button
              key={`secdel:${k}`}
              label="Delete"
              dimColor
              onPress={() => on.deleteSecret(d.name, k)}
            />
          </Box>
        ))}
        {Input &&
          d.missing_secrets.map((k) => (
            <Input
              key={`secset:${k}`}
              label={k}
              placeholder="value (stored in the keychain, never shown)"
              submitLabel="save"
              onSubmit={(v) => on.setSecret(d.name, k, v)}
            />
          ))}
        {Input && (
          <Input
            key="secadd"
            label="Add"
            placeholder="KEY=value"
            submitLabel="save"
            onSubmit={(v) => on.addSecret(d.name, v)}
          />
        )}
      </Box>

      <Box flexDirection="column">
        <Text bold>Tools ({d.tools.length})</Text>
        {d.tools.length === 0 && <Text dimColor>Not indexed yet: Re-index.</Text>}
        {d.tools.map((t) => {
          const m = d.metrics.find((x) => x.tool === t.name);
          const isOpen = tool?.server === d.name && tool.tool === t.name;
          return (
            <Box key={`tool:${t.name}`} flexDirection="column">
              <Box columnGap={1}>
                <Button
                  key={`toolbtn:${t.name}`}
                  label={`${isOpen ? 'v' : '>'} ${t.name}`}
                  plain
                  onPress={() => on.toggleTool(d.name, t.name)}
                />
                <Text dimColor wrap="truncate">
                  {m
                    ? `${plural(m.calls, 'call')}, ${m.errors} err, ${Math.round(m.avg_ms)} ms · `
                    : ''}
                  {t.description}
                </Text>
              </Box>
              {isOpen && <Code source={tool.schema} language="json" />}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

type BrowseProps = ViewProps & {
  browse: AgentDiscoverBrowse | null;
  plan: AgentDiscoverPlan | null;
};

function Browse({ el, on, browse, plan }: BrowseProps) {
  const { Box, Text, Button, Input } = el;
  if (plan) return <Plan el={el} on={on} plan={plan} />;
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

function Plan({ el, on, plan }: ViewProps & { plan: AgentDiscoverPlan }) {
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
          {Input &&
            plan.requirements
              .filter((r) => !r.present)
              .map((r) => (
                <Input
                  key={`reqset:${r.key}`}
                  label={r.key}
                  placeholder={r.secret ? 'value (goes to the keychain, never shown)' : 'value'}
                  submitLabel="set"
                  onSubmit={(v) => on.fill(r.key, v)}
                />
              ))}
        </Box>
      )}
      {!plan.blocked && (
        <Box flexWrap="wrap" columnGap={1}>
          <Button
            key="install-enable"
            label="Install and enable"
            variant="primary"
            onPress={() => on.install(true)}
          />
          <Button key="install" label="Install only" onPress={() => on.install(false)} />
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
          {time(e.time)} {e.server}/{e.tool} {e.ms} ms{e.error ? ` ${e.error}` : ''}
        </Text>
      ))}
    </Box>
  );
}

function Audit({ el, on, audit }: ViewProps & { audit: AgentDiscoverAudit | null }) {
  const { Box, Text, Button, Input } = el;
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
            placeholder="all (install, enable, call, approve, ...)"
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
            {time(e.ts)} {e.action} {e.server ?? ''}
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
