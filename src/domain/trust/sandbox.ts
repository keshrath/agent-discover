// =============================================================================
// agent-discover — Docker sandbox for stdio servers (opt-in per server)
//
// `sandbox: "docker"` rewrites the launch command:
//   - `docker run ... <image>` (OCI packages): run natively, with hardening
//     flags injected; host mounts, privileged mode, extra capabilities and
//     custom networks in the original args are refused;
//   - `npx ...` / `uvx ...`: run inside a minimal node / uv image.
// Every container: --rm, --init, read-only root, cap-drop ALL,
// no-new-privileges, /tmp tmpfs, and ONE per-server named volume
// (agent-discover-<server>) as $HOME/workdir — no host paths. Network stays
// on unless `sandbox_network: false` (--network none). Env/secrets reach the
// container as `-e KEY` (name only; the value comes from the docker CLI's
// environment, never argv). Other commands can't be sandboxed and are
// rejected at install time. Without docker on PATH the connect fails with
// the pool's "command docker not found" hint.
// =============================================================================

import type { ServerConfig } from '../../types.js';
import { ValidationError } from '../../types.js';

export const SANDBOX_IMAGES = {
  npx: 'node:22-alpine',
  uvx: 'ghcr.io/astral-sh/uv:python3.12-alpine',
} as const;

const HARDENING = [
  '--init',
  '--read-only',
  '--tmpfs',
  '/tmp',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
];

// Flags of `docker run` that would break the sandbox if the stored args carried them.
const FORBIDDEN = new Set([
  '-v',
  '--volume',
  '--mount',
  '--volumes-from',
  '--privileged',
  '--cap-add',
  '--device',
  '--network',
  '--net',
  '--pid',
  '--ipc',
  '--userns',
  '--uts',
  '--security-opt',
]);
// Value-taking `docker run` flags (so the image can be told apart from a flag value).
const WITH_VALUE = new Set([
  '-e',
  '--env',
  '--env-file',
  '--name',
  '-w',
  '--workdir',
  '-u',
  '--user',
  '--entrypoint',
  '-l',
  '--label',
  '-p',
  '--publish',
  '--platform',
  '--pull',
  '-m',
  '--memory',
  '--cpus',
  '--hostname',
  '-h',
  '--add-host',
  '--tmpfs',
]);

export interface SandboxSettings {
  readonly name: string;
  readonly command: string | null;
  readonly args: string[];
  readonly sandbox_network: boolean;
}

function commandBase(command: string | null): string {
  return (command ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .replace(/\.(cmd|exe)$/i, '');
}

/** Index of the image in `docker run` args (0 = "run"). */
function imageIndex(args: string[]): number {
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const flag = a.split('=')[0];
    if (FORBIDDEN.has(flag)) {
      throw new ValidationError(`sandbox: docker flag "${flag}" is not allowed inside the sandbox`);
    }
    if (!a.startsWith('-')) return i;
    if (WITH_VALUE.has(a)) i++;
  }
  throw new ValidationError('sandbox: no image found in docker run args');
}

/** Throws unless `server` can run under the docker sandbox. */
export function assertSandboxable(server: Omit<SandboxSettings, 'sandbox_network'>): void {
  const base = commandBase(server.command);
  if (base === 'docker') {
    if (server.args[0] !== 'run')
      throw new ValidationError('sandbox: docker servers must use "docker run"');
    imageIndex(server.args);
    return;
  }
  if (base !== 'npx' && base !== 'uvx') {
    throw new ValidationError(
      `sandbox: docker supports npx, uvx and "docker run" servers, not "${server.command}"`,
    );
  }
}

/** The docker launch for a sandboxed stdio server (see header). */
export function sandboxConfig(server: SandboxSettings, config: ServerConfig): ServerConfig {
  assertSandboxable(server);
  const volume = `agent-discover-${server.name}`;
  const common = [
    ...HARDENING,
    '-v',
    `${volume}:/scratch`,
    '-w',
    '/scratch',
    '-e',
    'HOME=/scratch',
    ...Object.keys(config.env).flatMap((k) => ['-e', k]),
    ...(server.sandbox_network ? [] : ['--network', 'none']),
  ];
  const base = commandBase(server.command);
  let args: string[];
  if (base === 'docker') {
    const at = imageIndex(server.args);
    const own = server.args.slice(1, at).filter((a) => a !== '--rm' && a !== '-i');
    args = ['run', '-i', '--rm', ...common, ...own, ...server.args.slice(at)];
  } else {
    const image = SANDBOX_IMAGES[base as 'npx' | 'uvx'];
    args = ['run', '-i', '--rm', ...common, image, base, ...server.args];
  }
  return { ...config, command: 'docker', args };
}
