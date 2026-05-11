/**
 * Per-workspace kopia repo. One instance per workspace; constructor is
 * cheap (paths only), real work happens in `ensureRepo` and `snapshot`.
 *
 * The class is a thin wrapper around the kopia CLI — every method shells
 * out, parses --json output, and writes a PG row in the same transaction
 * as the kopia side-effect. Kopia is the source of truth for snapshot
 * contents; PG is the source of truth for settings + metadata + UI state.
 *
 * Phase 1 implements: ensureRepo, snapshot, list, stats, verify, settings
 * read/write. Restore + maintenance + mount + stream are stubbed for
 * Phase 2/3/5.
 */

import { spawn } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getOrgPg } from '@restart/db-org';
import { deriveRepoPassword } from './password';
import { runPreSnapshotHook } from './hook';
import { decryptDestConfig, syncArgsFor, type DestinationType } from './destinations';
import {
  type BackupSettings,
  type RepoStats,
  type RetentionPolicy,
  type SnapshotInfo,
  type SnapshotResult,
  type SnapshotTriggerReason,
  type VerifyResult,
  RETENTION_PRESETS,
} from './types';

const KOPIA_BIN = process.env.KOPIA_BIN ?? 'kopia';

const IGNORE_PATTERNS = [
  'node_modules', '.next', 'out', 'target', 'dist', 'build', '.turbo', '.cache',
  '.svelte-kit', '.nuxt', '.angular', '.vite', '.parcel-cache',
  '.yarn/cache', '.pnpm-store', '.bun',
  'coverage', '.nyc_output',
  '__pycache__', '*.pyc', '.venv', 'venv', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.gradle', '.terraform',
  'tmp', '.tmp', '*.swp', '*.swo', '.DS_Store', 'Thumbs.db',
  'proc-macro-srv*', '*.log',
];

export interface WorkspaceBackupOpts {
  workspaceId: string;
  /** Override workspace root; defaults to ~/.papercusp-workspaces/<id>. */
  workspaceRoot?: string;
}

export class WorkspaceBackup {
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly repoPath: string;

  constructor(opts: WorkspaceBackupOpts) {
    this.workspaceId = opts.workspaceId;
    this.workspaceRoot = opts.workspaceRoot
      ?? join(homedir(), '.papercusp-workspaces', opts.workspaceId);
    this.repoPath = join(this.workspaceRoot, 'backups', 'kopia-repo');
  }

  async ensureRepo(): Promise<void> {
    // Defensive: make sure the backup PG tables exist before the kopia
    // dance, in case the operator's pre-warm didn't run them yet.
    try {
      const { ensureBackupTables } = await import('../ensure-schema');
      await ensureBackupTables();
    } catch { /* tables already exist or PG not ready; non-fatal */ }
    await mkdir(this.repoPath, { recursive: true });
    const password = await deriveRepoPassword(this.workspaceId);

    const env = this.envWithPassword(password);
    const connected = await this.kopiaTry(['repository', 'status'], { env });
    if (connected.ok) return;

    // Not connected. Try to connect (existing repo) before creating one.
    const connect = await this.kopiaTry(
      ['repository', 'connect', 'filesystem', '--path', this.repoPath],
      { env },
    );
    if (connect.ok) {
      await this.applyGlobalPolicy(env);
      return;
    }

    // Doesn't exist yet — create it.
    await this.kopia(
      ['repository', 'create', 'filesystem', '--path', this.repoPath],
      { env },
    );
    await this.applyGlobalPolicy(env);
  }

  async getSettings(): Promise<BackupSettings> {
    try {
      const { ensureBackupTables } = await import('../ensure-schema');
      await ensureBackupTables();
    } catch { /* tables already exist or PG not ready; non-fatal */ }
    const { sql } = getOrgPg();
    const rows = await sql<{
      enabled: boolean;
      cadence_mode: string;
      cadence_minutes: number;
      retention_preset: string;
      retention_custom_json: unknown;
      event_triggers_json: unknown;
      excluded_paths_json: unknown;
      destination_type: string;
      destination_config_encrypted: string | null;
    }[]>`
      SELECT enabled, cadence_mode, cadence_minutes, retention_preset,
             retention_custom_json, event_triggers_json, excluded_paths_json,
             destination_type, destination_config_encrypted
      FROM harness_shared.workspace_backup_settings
      WHERE workspace_id = ${this.workspaceId}
      LIMIT 1
    `;
    if (rows.length === 0) {
      await sql`
        INSERT INTO harness_shared.workspace_backup_settings (workspace_id)
        VALUES (${this.workspaceId})
        ON CONFLICT (workspace_id) DO NOTHING
      `;
      return this.getSettings();
    }
    const r = rows[0]!;
    return {
      workspaceId: this.workspaceId,
      enabled: r.enabled,
      cadenceMode: r.cadence_mode as BackupSettings['cadenceMode'],
      cadenceMinutes: r.cadence_minutes,
      retentionPreset: r.retention_preset as BackupSettings['retentionPreset'],
      retentionCustom: r.retention_custom_json as RetentionPolicy | null,
      eventTriggers: (r.event_triggers_json as SnapshotTriggerReason[]) ?? [],
      excludedPaths: (r.excluded_paths_json as string[]) ?? [],
      destinationType: (r.destination_type as BackupSettings['destinationType']) ?? 'local',
      destinationConfigured: !!r.destination_config_encrypted,
    };
  }

  /**
   * Persist a destination config. The cleartext config never touches
   * disk or PG in unencrypted form. Pass null to clear the destination.
   */
  async setDestination(
    type: BackupSettings['destinationType'],
    config: unknown | null,
  ): Promise<void> {
    const { sql } = getOrgPg();
    let encrypted: string | null = null;
    if (type !== 'local' && config) {
      const { encryptDestConfig } = await import('./destinations');
      encrypted = await encryptDestConfig(
        this.workspaceId,
        config as Parameters<typeof encryptDestConfig>[1],
      );
    }
    await sql`
      UPDATE harness_shared.workspace_backup_settings
      SET destination_type             = ${type},
          destination_config_encrypted = ${encrypted},
          updated_at                   = now()
      WHERE workspace_id = ${this.workspaceId}
    `;
  }

  async testDestination(): Promise<{ ok: boolean; error?: string }> {
    const { sql } = getOrgPg();
    const rows = await sql<{ destination_type: string; destination_config_encrypted: string | null }[]>`
      SELECT destination_type, destination_config_encrypted
      FROM harness_shared.workspace_backup_settings
      WHERE workspace_id = ${this.workspaceId}
      LIMIT 1
    `;
    const r = rows[0];
    if (!r || r.destination_type === 'local') return { ok: true };
    if (!r.destination_config_encrypted) return { ok: false, error: 'no config saved' };
    try {
      const cfg = await decryptDestConfig(this.workspaceId, r.destination_config_encrypted);
      const sync = syncArgsFor(r.destination_type as DestinationType, cfg);
      if (!sync) return { ok: true };
      const password = await deriveRepoPassword(this.workspaceId);
      const env = this.envWithPassword(password);
      // Use kopia's `repository sync-to <type> --dry-run` to verify
      // connectivity + credentials without writing.
      await this.kopia([...sync.args, '--dry-run'], { env: { ...env, ...sync.env } });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) };
    }
  }

  async snapshot(reason: SnapshotTriggerReason, context?: Record<string, unknown>): Promise<SnapshotResult> {
    const { sql } = getOrgPg();
    await this.ensureRepo();
    const password = await deriveRepoPassword(this.workspaceId);
    const env = this.envWithPassword(password);

    const sources = [this.workspaceRoot];
    const insertRows = await sql<{ id: number }[]>`
      INSERT INTO harness_shared.backup_snapshots
        (workspace_id, trigger_reason, trigger_context, sources_json)
      VALUES
        (${this.workspaceId}, ${reason}, ${context ? JSON.stringify(context) : null}::jsonb, ${JSON.stringify(sources)}::jsonb)
      RETURNING id
    `;
    const snapshotRowId = insertRows[0]!.id;
    const start = Date.now();

    await this.event(snapshotRowId, 'progress', { phase: 'started', sources });

    // Pre-snapshot DB dump hook. Failures are logged inside the hook
    // and do not abort the snapshot — the file tree is still useful
    // even if the dump didn't land.
    await this.event(snapshotRowId, 'progress', { phase: 'pre_snapshot_hook' });
    await runPreSnapshotHook({
      workspaceId: this.workspaceId,
      workspaceRoot: this.workspaceRoot,
    }).then(() => this.event(snapshotRowId, 'hook_pg_dump', { ok: true }))
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`[backup] pre-snapshot hook for ${this.workspaceId} failed:`, err);
        return this.event(snapshotRowId, 'hook_pg_dump', { ok: false, error: String(err) });
      });

    try {
      await this.event(snapshotRowId, 'progress', { phase: 'kopia_snapshot' });
      const out = await this.kopia(['snapshot', 'create', ...sources, '--json'], { env });
      const parsed = parseKopiaSnapshotJson(out);
      const durationMs = Date.now() - start;
      await sql`
        UPDATE harness_shared.backup_snapshots
        SET kopia_snapshot_id = ${parsed.snapshotId},
            finished_at       = now(),
            status            = 'ok',
            bytes_added       = ${parsed.bytesAdded},
            bytes_total       = ${parsed.bytesTotal}
        WHERE id = ${snapshotRowId}
      `;
      await this.event(snapshotRowId, 'progress', { phase: 'done', bytesAdded: parsed.bytesAdded, durationMs });

      // After-snapshot offsite replication (non-fatal). Local stays the
      // source of truth; if sync fails the snapshot is still safe.
      void this.syncToOffsite(env, snapshotRowId).catch(() => { /* logged inside */ });

      return {
        snapshotId: snapshotRowId,
        kopiaSnapshotId: parsed.snapshotId,
        bytesAdded: parsed.bytesAdded,
        durationMs,
      };
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      await sql`
        UPDATE harness_shared.backup_snapshots
        SET finished_at = now(),
            status      = 'failed',
            error_text  = ${msg}
        WHERE id = ${snapshotRowId}
      `;
      await this.event(snapshotRowId, 'progress', { phase: 'failed', error: msg });
      throw err;
    }
  }

  private async syncToOffsite(baseEnv: NodeJS.ProcessEnv, snapshotRowId: number): Promise<void> {
    const { sql } = getOrgPg();
    const rows = await sql<{ destination_type: string; destination_config_encrypted: string | null }[]>`
      SELECT destination_type, destination_config_encrypted
      FROM harness_shared.workspace_backup_settings
      WHERE workspace_id = ${this.workspaceId}
      LIMIT 1
    `;
    if (rows.length === 0) return;
    const r = rows[0]!;
    if (r.destination_type === 'local' || !r.destination_config_encrypted) return;
    try {
      const cfg = await decryptDestConfig(this.workspaceId, r.destination_config_encrypted);
      const sync = syncArgsFor(r.destination_type as DestinationType, cfg);
      if (!sync) return;
      await this.event(snapshotRowId, 'sync_started', { destination: r.destination_type });
      await this.kopia(sync.args, { env: { ...baseEnv, ...sync.env } });
      await this.event(snapshotRowId, 'sync_done', { destination: r.destination_type });
    } catch (err) {
      await this.event(snapshotRowId, 'sync_failed', { destination: r.destination_type, error: String(err) });
    }
  }

  private async event(snapshotId: number, kind: string, payload: Record<string, unknown>): Promise<void> {
    const { sql } = getOrgPg();
    try {
      await sql`
        INSERT INTO harness_shared.backup_events (workspace_id, snapshot_id, kind, payload_json)
        VALUES (${this.workspaceId}, ${snapshotId}, ${kind}, ${JSON.stringify(payload)}::jsonb)
      `;
    } catch {
      // Event log is best-effort.
    }
  }

  async list(limit = 100): Promise<SnapshotInfo[]> {
    const { sql } = getOrgPg();
    const rows = await sql<{
      id: number;
      kopia_snapshot_id: string | null;
      started_at: string ;
      finished_at: string  | null;
      status: string;
      trigger_reason: string;
      trigger_context: unknown;
      bytes_added: string | null;   // BIGINT comes back as string in some drivers
      bytes_total: string | null;
      sources_json: unknown;
      error_text: string | null;
    }[]>`
      SELECT id, kopia_snapshot_id, started_at, finished_at, status,
             trigger_reason, trigger_context, bytes_added, bytes_total,
             sources_json, error_text
      FROM harness_shared.backup_snapshots
      WHERE workspace_id = ${this.workspaceId}
      ORDER BY started_at DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      id: r.id,
      kopiaSnapshotId: r.kopia_snapshot_id,
      workspaceId: this.workspaceId,
      startedAt: tsIso(r.started_at) ?? new Date(0).toISOString(),
      finishedAt: tsIso(r.finished_at),
      status: r.status as SnapshotInfo['status'],
      triggerReason: r.trigger_reason as SnapshotTriggerReason,
      triggerContext: (r.trigger_context as Record<string, unknown> | null),
      bytesAdded: r.bytes_added == null ? null : Number(r.bytes_added),
      bytesTotal: r.bytes_total == null ? null : Number(r.bytes_total),
      sources: (r.sources_json as string[]) ?? [],
      error: r.error_text,
    }));
  }

  async stats(): Promise<RepoStats> {
    const { sql } = getOrgPg();
    const [agg] = await sql<{
      total: string;
      bytes_added_sum: string | null;
      bytes_total_sum: string | null;
      last_ok: string  | null;
      last_fail: string  | null;
    }[]>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'ok')::TEXT      AS total,
        SUM(bytes_added) FILTER (WHERE status = 'ok')::TEXT AS bytes_added_sum,
        SUM(bytes_total) FILTER (WHERE status = 'ok')::TEXT AS bytes_total_sum,
        MAX(finished_at) FILTER (WHERE status = 'ok')    AS last_ok,
        MAX(finished_at) FILTER (WHERE status = 'failed') AS last_fail
      FROM harness_shared.backup_snapshots
      WHERE workspace_id = ${this.workspaceId}
    `;
    const bytesOnDisk = agg.bytes_added_sum == null ? 0 : Number(agg.bytes_added_sum);
    const bytesRaw   = agg.bytes_total_sum == null ? 0 : Number(agg.bytes_total_sum);
    return {
      totalSnapshots: Number(agg.total),
      bytesOnDisk,
      bytesRaw,
      dedupRatio: bytesRaw === 0 ? 0 : 1 - bytesOnDisk / bytesRaw,
      lastSnapshotAt: tsIso(agg.last_ok),
      lastFailureAt:  tsIso(agg.last_fail),
    };
  }

  async verify(): Promise<VerifyResult> {
    const password = await deriveRepoPassword(this.workspaceId);
    const env = this.envWithPassword(password);
    const res = await this.kopiaTry(['snapshot', 'verify'], { env });
    return { ok: res.ok, errors: res.ok ? [] : [res.stderr] };
  }

  async maintenance(level: 'quick' | 'full' = 'quick'): Promise<void> {
    const password = await deriveRepoPassword(this.workspaceId);
    const env = this.envWithPassword(password);
    // kopia uses bool --full for full; no flag = quick.
    const args = level === 'full' ? ['maintenance', 'run', '--full'] : ['maintenance', 'run'];
    await this.kopia(args, { env });
  }

  async updateSettings(partial: Partial<Omit<BackupSettings, 'workspaceId'>>): Promise<BackupSettings> {
    const { sql } = getOrgPg();
    const current = await this.getSettings();
    const next: BackupSettings = { ...current, ...partial };
    await sql`
      INSERT INTO harness_shared.workspace_backup_settings (
        workspace_id, enabled, cadence_mode, cadence_minutes,
        retention_preset, retention_custom_json,
        event_triggers_json, excluded_paths_json, updated_at
      ) VALUES (
        ${this.workspaceId}, ${next.enabled}, ${next.cadenceMode}, ${next.cadenceMinutes},
        ${next.retentionPreset}, ${next.retentionCustom ? JSON.stringify(next.retentionCustom) : null}::jsonb,
        ${JSON.stringify(next.eventTriggers)}::jsonb,
        ${JSON.stringify(next.excludedPaths)}::jsonb,
        now()
      )
      ON CONFLICT (workspace_id) DO UPDATE SET
        enabled               = EXCLUDED.enabled,
        cadence_mode          = EXCLUDED.cadence_mode,
        cadence_minutes       = EXCLUDED.cadence_minutes,
        retention_preset      = EXCLUDED.retention_preset,
        retention_custom_json = EXCLUDED.retention_custom_json,
        event_triggers_json   = EXCLUDED.event_triggers_json,
        excluded_paths_json   = EXCLUDED.excluded_paths_json,
        updated_at            = now()
    `;
    return next;
  }

  /**
   * Restore-to-clone — never writes over live data. Target defaults to
   * `<workspaceRoot>/.restored/<kopiaSnapshotId>/<basename-of-source>`.
   * Caller diffs / promotes manually.
   */
  async restoreToClone(opts: {
    kopiaSnapshotId: string;
    source?: string;
    target?: string;
  }): Promise<{ targetPath: string }> {
    const password = await deriveRepoPassword(this.workspaceId);
    const env = this.envWithPassword(password);
    const source = opts.source ?? this.workspaceRoot;
    const slug = source.replace(/\W+/g, '_').replace(/^_+|_+$/g, '');
    const target = opts.target
      ?? join(this.workspaceRoot, '.restored', opts.kopiaSnapshotId, slug);
    await mkdir(target, { recursive: true });
    await this.detachedEvent('restore', { phase: 'started', kopiaSnapshotId: opts.kopiaSnapshotId, target });
    try {
      await this.kopia(['snapshot', 'restore', opts.kopiaSnapshotId, target], { env });
      await this.detachedEvent('restore', { phase: 'done', target });
    } catch (err) {
      await this.detachedEvent('restore', { phase: 'failed', error: String(err) });
      throw err;
    }
    return { targetPath: target };
  }

  private async detachedEvent(kind: string, payload: Record<string, unknown>): Promise<void> {
    const { sql } = getOrgPg();
    try {
      await sql`
        INSERT INTO harness_shared.backup_events (workspace_id, snapshot_id, kind, payload_json)
        VALUES (${this.workspaceId}, NULL, ${kind}, ${JSON.stringify(payload)}::jsonb)
      `;
    } catch {
      // best-effort
    }
  }

  /**
   * Promote a restored clone to live by atomically renaming the
   * current live workspace to `.broken-<ts>/` and the clone into its
   * place. Reversible: rename `.broken-<ts>/` back if the promotion
   * was wrong.
   *
   * Safety:
   * - Only promotes paths under <workspaceRoot> — refuses anything
   *   outside (no path-traversal, no clobbering siblings).
   * - The "live" target is derived from the clone's basename so the
   *   slug round-trip is unambiguous.
   * - Writes a marker `.promotion-meta.json` next to .broken-* so a
   *   future "rollback" tool knows the original layout.
   */
  async promoteRestore(opts: { restoredPath: string; liveTarget?: string }): Promise<{ broken: string; live: string }> {
    const { resolve, dirname, basename } = await import('node:path');
    const { rename, writeFile } = await import('node:fs/promises');
    const root = resolve(this.workspaceRoot);
    const clone = resolve(opts.restoredPath);
    if (!clone.startsWith(root + '/.restored/')) {
      throw new Error(`refusing to promote: ${clone} is not under <workspace>/.restored/`);
    }
    // Default live target is the workspace root itself (the only source
    // we snapshot today). For multi-source workspaces, the caller must
    // pass `liveTarget` explicitly.
    const liveTarget = resolve(opts.liveTarget ?? root);
    if (!liveTarget.startsWith(root)) {
      throw new Error(`refusing to promote: ${liveTarget} escapes workspace`);
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const brokenDir = join(dirname(liveTarget), `.broken-${ts}-${basename(liveTarget)}`);
    await rename(liveTarget, brokenDir);
    try {
      await rename(clone, liveTarget);
    } catch (err) {
      await rename(brokenDir, liveTarget).catch(() => {});
      throw err;
    }
    await writeFile(
      join(dirname(liveTarget), `.promotion-meta-${ts}.json`),
      JSON.stringify({ broken: brokenDir, live: liveTarget, promotedFrom: clone, at: new Date().toISOString() }, null, 2),
    );
    return { broken: brokenDir, live: liveTarget };
  }

  /**
   * Undo a promotion. Symmetric with `promoteRestore`: finds the
   * `.broken-<ts>-<name>/` dir and the current live, swaps them.
   *
   * `brokenPath` must be inside the workspace root and start with
   * `.broken-`. The current live target is inferred from `brokenPath`
   * (strip the `.broken-<ts>-` prefix from basename, prepend dirname).
   */
  async rollbackPromote(opts: { brokenPath: string }): Promise<{ liveBefore: string; liveAfter: string }> {
    const { resolve, basename, dirname } = await import('node:path');
    const { rename } = await import('node:fs/promises');
    const root = resolve(this.workspaceRoot);
    const broken = resolve(opts.brokenPath);
    if (!broken.startsWith(root)) {
      throw new Error(`refusing to rollback: ${broken} is outside workspace`);
    }
    const brokenBase = basename(broken);
    const m = /^\.broken-([0-9T:.\-Z]+)-(.+)$/.exec(brokenBase);
    if (!m) throw new Error(`refusing to rollback: ${brokenBase} doesn't match .broken-<ts>-<name>`);
    const liveBaseName = m[2];
    const liveTarget = join(dirname(broken), liveBaseName!);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    // Move current live (the promoted clone) aside, then bring broken back.
    const stash = join(dirname(broken), `.rolled-back-${ts}-${liveBaseName}`);
    await rename(liveTarget, stash);
    try {
      await rename(broken, liveTarget);
    } catch (err) {
      await rename(stash, liveTarget).catch(() => {});
      throw err;
    }
    await this.detachedEvent('rollback', { broken, liveTarget, stash });
    return { liveBefore: stash, liveAfter: liveTarget };
  }

  async kopiaContentStats(): Promise<{ totalSize: number; objectCount: number } | null> {
    const password = await deriveRepoPassword(this.workspaceId);
    const env = this.envWithPassword(password);
    try {
      const out = await this.kopia(['content', 'stats', '--raw'], { env });
      // `kopia content stats --raw` is human-readable, not key=value.
      // Format we parse:
      //   Count: 7095
      //   Total Bytes: 9021138605
      //   Total Packed: 9019861807 (compression 0.0%)
      const get = (re: RegExp): number | null => {
        const m = out.match(re);
        if (!m) return null;
        const v = Number(m[1]!.replace(/,/g, ''));
        return Number.isFinite(v) ? v : null;
      };
      const totalSize   = get(/^Total Packed:\s*(\d[\d,]*)/m) ?? get(/^Total Bytes:\s*(\d[\d,]*)/m) ?? 0;
      const objectCount = get(/^Count:\s*(\d[\d,]*)/m) ?? 0;
      return { totalSize, objectCount };
    } catch {
      return null;
    }
  }

  async recentFailures(limit = 50): Promise<SnapshotInfo[]> {
    const { sql } = getOrgPg();
    const rows = await sql<{
      id: number; kopia_snapshot_id: string | null; started_at: string ; finished_at: string  | null;
      status: string; trigger_reason: string; trigger_context: unknown;
      bytes_added: string | null; bytes_total: string | null;
      sources_json: unknown; error_text: string | null;
    }[]>`
      SELECT id, kopia_snapshot_id, started_at, finished_at, status,
             trigger_reason, trigger_context, bytes_added, bytes_total,
             sources_json, error_text
      FROM harness_shared.backup_snapshots
      WHERE workspace_id = ${this.workspaceId} AND status = 'failed'
      ORDER BY started_at DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      id: r.id,
      kopiaSnapshotId: r.kopia_snapshot_id,
      workspaceId: this.workspaceId,
      startedAt: tsIso(r.started_at) ?? new Date(0).toISOString(),
      finishedAt: tsIso(r.finished_at),
      status: r.status as SnapshotInfo['status'],
      triggerReason: r.trigger_reason as SnapshotTriggerReason,
      triggerContext: r.trigger_context as Record<string, unknown> | null,
      bytesAdded: r.bytes_added == null ? null : Number(r.bytes_added),
      bytesTotal: r.bytes_total == null ? null : Number(r.bytes_total),
      sources: (r.sources_json as string[]) ?? [],
      error: r.error_text,
    }));
  }

  // ---------- internals ----------

  private envWithPassword(password: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      KOPIA_PASSWORD: password,
      KOPIA_CONFIG_PATH: join(this.workspaceRoot, 'backups', 'repository.config'),
      KOPIA_LOG_DIR: join(this.workspaceRoot, 'backups', 'logs'),
      KOPIA_CACHE_DIRECTORY: join(this.workspaceRoot, 'backups', 'cache'),
    };
  }

  private async applyGlobalPolicy(env: NodeJS.ProcessEnv): Promise<void> {
    const settings = await this.getSettings();
    const retention =
      settings.retentionPreset === 'custom' && settings.retentionCustom
        ? settings.retentionCustom
        : RETENTION_PRESETS[settings.retentionPreset === 'custom' ? 'default' : settings.retentionPreset];
    const ignores = [...IGNORE_PATTERNS, ...settings.excludedPaths];
    const args = [
      'policy', 'set', '--global',
      `--keep-latest=${retention.keepLatest}`,
      `--keep-hourly=${retention.keepHourly}`,
      `--keep-daily=${retention.keepDaily}`,
      `--keep-weekly=${retention.keepWeekly}`,
      `--keep-monthly=${retention.keepMonthly}`,
      ...ignores.map((p) => `--add-ignore=${p}`),
    ];
    await this.kopia(args, { env });
  }

  private kopia(args: string[], opts: { env: NodeJS.ProcessEnv }): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(KOPIA_BIN, args, { env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (d) => out.push(d));
      child.stderr.on('data', (d) => err.push(d));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
        else reject(new Error(`kopia ${args.join(' ')} exited ${code}: ${Buffer.concat(err).toString('utf8')}`));
      });
    });
  }

  private async kopiaTry(
    args: string[],
    opts: { env: NodeJS.ProcessEnv },
  ): Promise<{ ok: true; stdout: string } | { ok: false; stderr: string }> {
    try {
      const stdout = await this.kopia(args, opts);
      return { ok: true, stdout };
    } catch (e) {
      return { ok: false, stderr: e instanceof Error ? e.message : String(e) };
    }
  }
}


function tsIso(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return new Date(v).toISOString();
  return null;
}

/**
 * Kopia's `snapshot create --json` emits one JSON object per source on
 * success. We back up one source per call, so we expect one object.
 */
function parseKopiaSnapshotJson(stdout: string): {
  snapshotId: string;
  bytesAdded: number;
  bytesTotal: number;
} {
  const lines = stdout.split('\n').filter((l) => l.trim().startsWith('{'));
  if (lines.length === 0) {
    throw new Error(`kopia snapshot create returned no JSON: ${stdout.slice(0, 200)}`);
  }
  const obj = JSON.parse(lines[lines.length - 1]!) as {
    id?: string;
    rootEntry?: { summ?: { size?: number; numFailedEntries?: number } };
    stats?: { totalBytes?: number; uploadedBytes?: number };
  };
  if (!obj.id) {
    throw new Error(`kopia snapshot create missing id: ${JSON.stringify(obj).slice(0, 200)}`);
  }
  return {
    snapshotId: obj.id,
    bytesAdded: obj.stats?.uploadedBytes ?? 0,
    bytesTotal: obj.stats?.totalBytes ?? obj.rootEntry?.summ?.size ?? 0,
  };
}
