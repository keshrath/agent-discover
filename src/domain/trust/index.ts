// =============================================================================
// agent-discover — Trust service
//
// The TrustHooks implementation wired into ServerLifecycle (see
// docs/SECURITY.md for the whole model):
//   - afterIndex: pin on first index, quarantine on drift from the pins,
//     audit hygiene flags of new/changed tools;
//   - aroundCall: OTel client span + traceparent injection + call audit;
//   - approve:    re-pin the current tool set (only the exact set reviewed);
//   - inspect:    drift + flagged tools for status views;
//   - record:     audit sink for lifecycle actions.
// It also owns description hygiene for everything shown to models.
// =============================================================================

import type { Db } from '../../storage/database.js';
import type { Config } from '../../config.js';
import type { ServerEntry } from '../../types.js';
import { ConflictError } from '../../types.js';
import type { ToolIndex } from '../tool-index.js';
import type { SecretsService } from '../secrets.js';
import type { CallResult, TrustHooks } from '../lifecycle.js';
import { AuditLog, maskArgs, type AuditEvent } from './audit.js';
import { PinStore, hashSetDigest, isDrifted, type Drift } from './pins.js';
import { cleanText, scanTool, type HygieneFlag } from './hygiene.js';
import { NOOP_TELEMETRY, type Telemetry } from './telemetry.js';

export interface FlaggedTool {
  tool: string;
  flags: HygieneFlag[];
}

export interface TrustReport {
  /** Present when the current tools differ from the approved pins. */
  drift?: Drift;
  flagged_tools: FlaggedTool[];
  /** Current tool hashes (what POST /api/servers/:id/approve must echo). */
  hashes: string[];
  /** hashSetDigest(hashes). */
  digest: string;
}

export interface TrustDeps {
  db: Db;
  config: Config;
  index: ToolIndex;
  secrets: SecretsService;
  telemetry?: Telemetry;
}

export class TrustService implements TrustHooks {
  readonly pins: PinStore;
  readonly audit: AuditLog;
  readonly telemetry: Telemetry;

  constructor(private readonly deps: TrustDeps) {
    this.pins = new PinStore(deps.db);
    this.audit = new AuditLog(deps.db, deps.config.auditMaxRows);
    this.telemetry = deps.telemetry ?? NOOP_TELEMETRY;
  }

  // -- hygiene ---------------------------------------------------------------

  cleanToolDescription(text: string): string {
    return cleanText(text, this.deps.config.maxToolDescription);
  }

  cleanServerDescription(text: string): string {
    return cleanText(text, this.deps.config.maxServerDescription);
  }

  // -- hooks -----------------------------------------------------------------

  afterIndex(server: ServerEntry, diff: { added: string[]; changed: string[] }): boolean {
    const tools = this.deps.index.list(server.id);
    if (!this.pins.isPinned(server.id)) this.pins.pin(server.id, tools);
    const touched = new Set([...diff.added, ...diff.changed]);
    for (const t of tools) {
      if (!touched.has(t.name)) continue;
      const flags = scanTool(t);
      if (flags.length) {
        this.audit.append({ action: 'flag', server: server.name, tool: t.name, detail: { flags } });
      }
    }
    return isDrifted(this.pins.drift(server.id, tools));
  }

  async aroundCall(
    server: ServerEntry,
    tool: string,
    args: Record<string, unknown> | undefined,
    next: (meta: Record<string, string>) => Promise<CallResult>,
  ): Promise<CallResult> {
    const start = Date.now();
    let isError = true;
    try {
      const result = await this.telemetry.clientCall(
        { server: server.name, tool, transport: server.transport, url: server.url },
        next,
      );
      isError = 'isError' in result && result.isError === true;
      return result;
    } finally {
      this.audit.append({
        action: 'call_tool',
        server: server.name,
        tool,
        duration_ms: Date.now() - start,
        is_error: isError,
        ...(this.deps.config.auditArgs
          ? { detail: { arguments: this.maskedArgs(server, args) } }
          : {}),
      });
    }
  }

  private maskedArgs(server: ServerEntry, args: Record<string, unknown> | undefined): unknown {
    const secrets = [
      ...Object.values(this.deps.secrets.getEnvForServer(server)),
      ...Object.values(server.env),
    ];
    return maskArgs(args ?? {}, secrets);
  }

  approve(server: ServerEntry, hashes: string[]): void {
    const tools = this.deps.index.list(server.id);
    if (hashSetDigest(hashes) !== hashSetDigest(tools.map((t) => t.tool_hash))) {
      throw new ConflictError(
        `The tools of "${server.name}" changed since they were reviewed; review the current set and approve again`,
      );
    }
    this.pins.pin(server.id, tools);
  }

  inspect(server: ServerEntry): TrustReport {
    const tools = this.deps.index.list(server.id);
    const drift = this.pins.drift(server.id, tools);
    const hashes = tools.map((t) => t.tool_hash);
    return {
      ...(isDrifted(drift) ? { drift } : {}),
      flagged_tools: tools.flatMap((t) => {
        const flags = scanTool(t);
        return flags.length ? [{ tool: t.name, flags }] : [];
      }),
      hashes,
      digest: hashSetDigest(hashes),
    };
  }

  record(event: AuditEvent): void {
    this.audit.append(event);
  }
}
