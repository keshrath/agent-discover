// =============================================================================
// agent-discover — Install provenance checks
//
// Facts shown in the install consent, verified against the package
// registries for the exact version being installed:
//   - registry namespace: the official registry verified the publisher
//     (GitHub account for io.github.*, DNS/HTTP for domain namespaces);
//   - npm: package.json of that version declares `mcpName` = registry name;
//   - PyPI: that release's README contains `mcp-name: <registry name>`;
//   - OCI: the image carries the label io.modelcontextprotocol.server.name
//     (read with `docker buildx imagetools inspect`, no pull; skipped
//     without docker).
// Network failures never block a plan: the check reports `error`.
// =============================================================================

import { execFile } from 'node:child_process';
import type { InstallPlan, ProvenanceCheck } from './install-plan.js';

const TIMEOUT_MS = 10_000;
const NPM_REGISTRY = 'https://registry.npmjs.org';
const PYPI = 'https://pypi.org/pypi';
const OCI_LABEL = 'io.modelcontextprotocol.server.name';

function npmPath(name: string): string {
  return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function errorCheck(id: ProvenanceCheck['id'], err: unknown): ProvenanceCheck {
  return { id, status: 'error', detail: err instanceof Error ? err.message : String(err) };
}

/** Latest published version of an npm package (pins federated/unversioned installs). */
export async function npmLatestVersion(name: string): Promise<string | null> {
  const data = (await getJson(`${NPM_REGISTRY}/${npmPath(name)}/latest`)) as { version?: unknown };
  return typeof data.version === 'string' ? data.version : null;
}

/** Latest release of a PyPI project. */
export async function pypiLatestVersion(name: string): Promise<string | null> {
  const data = (await getJson(`${PYPI}/${encodeURIComponent(name)}/json`)) as {
    info?: { version?: unknown };
  };
  return typeof data.info?.version === 'string' ? data.info.version : null;
}

async function checkNpm(
  pkg: string,
  version: string | null,
  expected?: string,
): Promise<ProvenanceCheck> {
  const id = 'npm_mcp_name';
  try {
    const data = (await getJson(`${NPM_REGISTRY}/${npmPath(pkg)}/${version ?? 'latest'}`)) as {
      mcpName?: unknown;
    };
    const declared = typeof data.mcpName === 'string' ? data.mcpName : undefined;
    if (!expected) {
      return {
        id,
        status: 'skipped',
        detail: declared
          ? `package declares mcpName "${declared}" (not installed via the registry)`
          : 'not installed via the registry',
      };
    }
    if (declared === expected) {
      return { id, status: 'pass', detail: `${pkg}@${version} declares mcpName "${declared}"` };
    }
    return {
      id,
      status: 'fail',
      detail: declared
        ? `${pkg}@${version} declares mcpName "${declared}", not "${expected}"`
        : `${pkg}@${version} has no mcpName (the registry entry does not own this package)`,
    };
  } catch (err) {
    return errorCheck(id, err);
  }
}

async function checkPypi(
  pkg: string,
  version: string | null,
  expected?: string,
): Promise<ProvenanceCheck> {
  const id = 'pypi_mcp_name';
  if (!expected) return { id, status: 'skipped', detail: 'not installed via the registry' };
  try {
    const path = version
      ? `${encodeURIComponent(pkg)}/${encodeURIComponent(version)}`
      : encodeURIComponent(pkg);
    const data = (await getJson(`${PYPI}/${path}/json`)) as { info?: { description?: unknown } };
    const readme = typeof data.info?.description === 'string' ? data.info.description : '';
    const marker = new RegExp(`mcp-name:\\s*${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    return marker.test(readme)
      ? { id, status: 'pass', detail: `${pkg} ${version ?? ''} README declares mcp-name` }
      : {
          id,
          status: 'fail',
          detail: `${pkg} ${version ?? ''} README has no "mcp-name: ${expected}"`,
        };
  } catch (err) {
    return errorCheck(id, err);
  }
}

/** Runs a command without a shell; resolves stdout or rejects (ENOENT = not installed). */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: 30_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

export function ociLabels(json: string): Record<string, string> {
  const image = JSON.parse(json) as Record<string, unknown>;
  // Single-platform images print the image; multi-platform ones a platform → image map.
  const images = 'config' in image ? [image] : Object.values(image);
  for (const img of images) {
    const labels = ((img as { config?: { Labels?: unknown } })?.config?.Labels ?? null) as Record<
      string,
      string
    > | null;
    if (labels) return labels;
  }
  return {};
}

async function checkOci(ref: string, expected?: string): Promise<ProvenanceCheck> {
  const id = 'oci_label';
  if (!expected) return { id, status: 'skipped', detail: 'not installed via the registry' };
  let out: string;
  try {
    out = await run('docker', [
      'buildx',
      'imagetools',
      'inspect',
      ref,
      '--format',
      '{{json .Image}}',
    ]);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? { id, status: 'skipped', detail: 'docker is not installed' }
      : errorCheck(id, err);
  }
  try {
    const label = ociLabels(out)[OCI_LABEL];
    return label === expected
      ? { id, status: 'pass', detail: `${ref} is labelled ${OCI_LABEL}=${label}` }
      : {
          id,
          status: 'fail',
          detail: label
            ? `${ref} is labelled for "${label}", not "${expected}"`
            : `${ref} has no ${OCI_LABEL} label`,
        };
  } catch (err) {
    return errorCheck(id, err);
  }
}

/** Fill `plan.provenance.checks` (in place) and turn failed checks into warnings. */
export async function checkProvenance(plan: InstallPlan): Promise<InstallPlan> {
  const checks: Array<Promise<ProvenanceCheck>> = [];
  const expected = plan.registry_name;
  const reg = plan.provenance.registry;
  if (reg) {
    checks.push(
      Promise.resolve({
        id: 'registry_namespace',
        status: 'pass',
        detail: `namespace verified by the MCP Registry at publish (${reg.publisher})`,
      }),
    );
  }
  const pkg = plan.provenance.package;
  if (pkg && !plan.blocked) {
    if (pkg.ecosystem === 'npm') checks.push(checkNpm(pkg.name, pkg.version, expected));
    if (pkg.ecosystem === 'pypi') checks.push(checkPypi(pkg.name, pkg.version, expected));
    if (pkg.ecosystem === 'oci') {
      const ref = plan.args?.find((a) => a === pkg.name || a.startsWith(`${pkg.name}:`)); // the image argument
      checks.push(checkOci(ref ?? pkg.name, expected));
    }
  }
  plan.provenance.checks = await Promise.all(checks);
  for (const c of plan.provenance.checks) {
    if (c.status === 'fail') plan.warnings.push(`provenance check failed: ${c.detail}`);
  }
  return plan;
}
