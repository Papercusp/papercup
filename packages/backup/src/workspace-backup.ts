/**
 * Per-workspace kopia repo. One instance per workspace; constructor is
 * cheap (paths only), real work happens in `ensureRepo` and `snapshot`.
 *
 * The class is a thin wrapper around the kopia CLI — every method shells
 * out, parses --json output, and records the result in PG. PG access is the
 * raw org handle with NO transaction wrapping the kopia side-effect (it's a
 * discrete INSERT → kopia → UPDATE; a CLI shell-out can't share a SQL txn).
 * Kopia is the source of truth for snapshot contents; PG is the source of
 * truth for settings + metadata + UI state.
 *
 * Implements the full kopia lifecycle: ensureRepo, snapshot, list, stats,
 * verify, maintenance, restore (to-clone + in-place), promote/rollback of a
 * restore, and settings read/write. (Earlier revisions stubbed restore +
 * maintenance for a later phase; they are implemented now.)
 */

import { spawn } from 'node:child_process';
import { mkdir, access, rename, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { backupHost, backupStepRunner } from './config';
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
import { IGNORE_PATTERNS, SELF_EXCLUSION_RULES, diffPolicyIgnores } from './policy';

const KOPIA_BIN = process.env.KOPIA_BIN ?? 'kopia';

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
      ?? join(backupHost().workspacesRoot(), opts.workspaceId);
    this.repoPath = join(this.workspaceRoot, 'backups', 'kopia-repo');
  }

  async ensureRepo(): Promise<void> {
    // Defensive: make sure the backup PG tables exist before the kopia
    // dance, in case the operator's pre-warm didn't run them yet.
    try {
      await backupHost().ensureSchema();
    } catch { /* tables already exist or PG not ready; non-fatal */ }
    await mkdir(this.repoPath, { recursive: true });
    const password = await deriveRepoPassword(this.workspaceId);

    const env = this.envWithPassword(password);
    const connected = await this.kopiaTry(['repository', 'status'], { env });
    if (connected.ok) {
      // Warm repo. Re-apply the global policy so retention/excludedPaths
      // changes made via updateSettings since the last snapshot reach
      // kopia — updateSettings only writes PG, nothing else syncs the
      // kopia policy. Best-effort: a transient `policy set` failure must
      // not skip the snapshot; assertSelfExclusionPolicy still backstops
      // the recursion guard and the next ensureRepo retries.
      await this.applyGlobalPolicy(env, { fatal: false });
      return;
    }

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
      await backupHost().ensureSchema();
    } catch { /* tables already exist or PG not ready; non-fatal */ }
    const sql = backupHost().getSql();
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
    const sql = backupHost().getSql();
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
    const sql = backupHost().getSql();
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
    const sql = backupHost().getSql();
    // Durability seam (D-010 / P-011). Pass-through unless a host injects a
    // runner, so this is behaviorally identical to the un-stepped flow when no
    // DBOS host is wired — and gains crash-resume when invoked inside the
    // operator's `backupSnapshot` workflow. Each `runStep` body below is
    // idempotent (snapshot create is content-addressed; the row INSERT is the
    // ONE non-idempotent side effect and is itself a step so a resume returns
    // the cached id instead of inserting a duplicate row).
    const steps = backupStepRunner();
    await this.ensureRepo();
    const password = await deriveRepoPassword(this.workspaceId);
    const env = this.envWithPassword(password);

    const sources = [this.workspaceRoot];
    // Step 1 — create the tracking row. Must be a step: re-running it on a
    // resume would insert a SECOND snapshot row. The cached return (id +
    // start time) is what every later step keys off, keeping bookkeeping +
    // durationMs stable across a resume.
    const { id: snapshotRowId, startedAtMs } = await steps.runStep('backup-insert-row', async () => {
      const insertRows = await sql<{ id: number }[]>`
        INSERT INTO harness_shared.backup_snapshots
          (workspace_id, trigger_reason, trigger_context, sources_json)
        VALUES
          (${this.workspaceId}, ${reason}, ${context ? JSON.stringify(context) : null}::jsonb, ${JSON.stringify(sources)}::jsonb)
        RETURNING id
      `;
      return { id: insertRows[0]!.id, startedAtMs: Date.now() };
    });

    await this.event(snapshotRowId, 'progress', { phase: 'started', sources });

    // Step 2 — pre-snapshot DB dump hook. Failures are logged inside the hook
    // and do not abort the snapshot — the file tree is still useful even if
    // the dump didn't land. The hook overwrites its dump files atomically, so
    // re-running it on a resume is idempotent.
    await this.event(snapshotRowId, 'progress', { phase: 'pre_snapshot_hook' });
    await steps.runStep('backup-pre-snapshot-hook', () =>
      runPreSnapshotHook({
        workspaceId: this.workspaceId,
        workspaceRoot: this.workspaceRoot,
      }).then(() => this.event(snapshotRowId, 'hook_pg_dump', { ok: true }))
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn(`[backup] pre-snapshot hook for ${this.workspaceId} failed:`, err);
          return this.event(snapshotRowId, 'hook_pg_dump', { ok: false, error: String(err) });
        }),
    );

    try {
      await this.event(snapshotRowId, 'progress', { phase: 'kopia_snapshot' });
      // Step 3 — the kopia snapshot create (the expensive, non-PG side effect).
      // Content-addressed, so a re-run on resume only re-dedups; caching the
      // parsed result lets a resume skip the work entirely. The self-exclusion
      // guard runs inside the step so the recursion check + the create are
      // checkpointed together. durationMs is measured here so it's stable when
      // the step result is replayed on resume.
      const parsed = await steps.runStep('backup-kopia-create', async () => {
        // Defense-in-depth: refuse to snapshot if the active policy doesn't
        // self-exclude the repo dir. Without this guard the snapshot would
        // recursively include kopia-repo/ and balloon toward 1TB.
        await this.assertSelfExclusionPolicy(env);
        const out = await this.kopia(['snapshot', 'create', ...sources, '--json'], { env });
        const p = parseKopiaSnapshotJson(out);
        return { ...p, durationMs: Date.now() - startedAtMs };
      });

      // Step 4 — record the result. Idempotent UPDATE keyed by the row id.
      await steps.runStep('backup-record-result', async () => {
        await sql`
          UPDATE harness_shared.backup_snapshots
          SET kopia_snapshot_id = ${parsed.snapshotId},
              finished_at       = now(),
              status            = 'ok',
              bytes_added       = ${parsed.bytesAdded},
              bytes_total       = ${parsed.bytesTotal}
          WHERE id = ${snapshotRowId}
        `;
      });
      await this.event(snapshotRowId, 'progress', { phase: 'done', bytesAdded: parsed.bytesAdded, durationMs: parsed.durationMs });

      // After-snapshot offsite replication (non-fatal). Local stays the
      // source of truth; if sync fails the snapshot is still safe.
      void this.syncToOffsite(env, snapshotRowId).catch(() => { /* logged inside */ });

      return {
        snapshotId: snapshotRowId,
        kopiaSnapshotId: parsed.snapshotId,
        bytesAdded: parsed.bytesAdded,
        durationMs: parsed.durationMs,
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
    const sql = backupHost().getSql();
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
    const sql = backupHost().getSql();
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
    const sql = backupHost().getSql();
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
    const sql = backupHost().getSql();
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
    const sql = backupHost().getSql();
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
    // Push the new retention/excludedPaths to kopia now instead of
    // waiting for the next snapshot's ensureRepo — e.g. a manual
    // `maintenance run` triggered right after a retention change
    // should prune against the fresh values. ensureRepo re-applies the
    // global policy on every path. Fire-and-forget + best-effort: the
    // PG write above is the source of truth and the next snapshot
    // re-applies the policy anyway, so a kopia hiccup here is harmless.
    // Skipped when backups are disabled — no need to create/touch a
    // repo for a workspace that isn't backing up.
    if (next.enabled) {
      void this.ensureRepo().catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`[backup] updateSettings: kopia policy refresh for ${this.workspaceId} failed:`, err);
      });
    }
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

  /**
   * Restore-in-place: snapshot live first (so the user can undo), then
   * overwrite the target with the snapshot. The plan called for this
   * as an "advanced" alternative to restore-to-clone — it's destructive
   * but faster.
   *
   * Always takes a fresh `pre_destructive` snapshot first; the user can
   * find the path to recover from in the resulting `prevSnapshotId`.
   */
  async restoreInPlace(opts: {
    kopiaSnapshotId: string;
    target?: string;
    skipSafetySnapshot?: boolean;
  }): Promise<{ targetPath: string; prevSnapshotId: string | null }> {
    // P-012: route through the durability seam so a crash mid-restore resumes
    // from the last completed step. Both phases are repeatable — the safety
    // snapshot is content-addressed, and `kopia snapshot restore` is a
    // deterministic overwrite — so this needs no rename surgery, only stepping
    // (no opId / deterministic-name work, unlike promote/rollback).
    const steps = backupStepRunner();
    const target = opts.target ?? this.workspaceRoot;
    let prevSnapshotId: string | null = null;
    if (!opts.skipSafetySnapshot) {
      // The safety snapshot as one durable step → a resume won't re-snapshot.
      // (snapshot()'s own runStep calls are nested under this step, so the
      // injected runner passes them through — fine, snapshot is ~idempotent.)
      prevSnapshotId = await steps.runStep('restore-safety-snapshot', async () => {
        const safety = await this.snapshot('pre_destructive', { op: 'restore_in_place_safety' });
        return safety.kopiaSnapshotId;
      });
    }
    const password = await deriveRepoPassword(this.workspaceId);
    const env = this.envWithPassword(password);
    await this.detachedEvent('restore', { phase: 'started', mode: 'in_place', kopiaSnapshotId: opts.kopiaSnapshotId, target, prevSnapshotId });
    try {
      await steps.runStep('restore-kopia-apply', async () => {
        await this.kopia(['snapshot', 'restore', opts.kopiaSnapshotId, target], { env });
      });
      await this.detachedEvent('restore', { phase: 'done', mode: 'in_place', target });
    } catch (err) {
      await this.detachedEvent('restore', { phase: 'failed', mode: 'in_place', error: String(err) });
      throw err;
    }
    return { targetPath: target, prevSnapshotId };
  }

  private async detachedEvent(kind: string, payload: Record<string, unknown>): Promise<void> {
    const sql = backupHost().getSql();
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
   * Promote a restored clone to live by renaming the current live workspace
   * to `.broken-<tag>-<name>/` and the clone into its place. Reversible via
   * `rollbackPromote`.
   *
   * Safety:
   * - Only promotes paths under <workspaceRoot> — refuses anything
   *   outside (no path-traversal, no clobbering siblings).
   * - The "live" target is derived from the clone's basename so the
   *   slug round-trip is unambiguous.
   * - Writes a marker `<brokenDir>.meta.json` (deterministic path) recording
   *   the original layout so `rollbackPromote` recovers the live target
   *   without parsing the dir name.
   *
   * Crash-resumable (P-012): the `<tag>` is derived from `opId` (deterministic
   * across a resume), and the rename pair runs as a single idempotent,
   * self-undoing `promote-swap` step — so a crash mid-promote resumes to a
   * consistent state instead of stranding the workspace live-less.
   */
  async promoteRestore(opts: { restoredPath: string; liveTarget?: string; opId?: string }): Promise<{ broken: string; live: string }> {
    const { resolve, dirname, basename } = await import('node:path');
    const steps = backupStepRunner();
    const root = resolve(this.workspaceRoot);
    const clone = resolve(opts.restoredPath);
    if (!clone.startsWith(root + '/.restored/')) {
      throw new Error(`refusing to promote: ${clone} is not under <workspace>/.restored/`);
    }
    // Default live target is the workspace root itself (the only source
    // we snapshot today). For multi-source workspaces, the caller must
    // pass `liveTarget` explicitly.
    const liveTarget = resolve(opts.liveTarget ?? root);
    // Prefix check must include a path separator — a bare startsWith(root) would
    // let a SIBLING like `<root>-evil` pass. Allow liveTarget === root (the
    // default; multi-source workspaces pass an explicit sub-path under root).
    if (liveTarget !== root && !liveTarget.startsWith(root + '/')) {
      throw new Error(`refusing to promote: ${liveTarget} escapes workspace`);
    }
    // P-012: the broken-dir name must be DETERMINISTIC for a crash-resume to
    // find the same path — derive it from the op id when hosted (stable across
    // a resume), else a timestamp for standalone calls (no resume → moot).
    const tag = sanitizeOpTag(opts.opId ?? new Date().toISOString().replace(/[:.]/g, '-'));
    const brokenDir = join(dirname(liveTarget), `.broken-${tag}-${basename(liveTarget)}`);

    // The swap is ONE step on purpose: DBOS checkpoints a step only on SUCCESS,
    // so this all-or-nothing rename pair must NOT be split — a split could
    // strand the workspace live-less between two cached steps. The step is
    // internally idempotent (it inspects the live FS and finishes from wherever
    // a prior crash stopped) and self-undoing if the second move fails.
    await steps.runStep('promote-swap', async () => {
      const [liveExists, brokenExists, cloneExists] = await Promise.all([
        this.pathExists(liveTarget),
        this.pathExists(brokenDir),
        this.pathExists(clone),
      ]);
      // Resume: step 1 (live→broken) done, step 2 (clone→live) not yet.
      if (brokenExists && !liveExists && cloneExists) {
        await this.idempotentMove(clone, liveTarget);
        return;
      }
      // Already fully swapped (broken holds the old live, clone consumed).
      if (brokenExists && liveExists && !cloneExists) return;
      // Fresh: move live aside, then the clone into place; undo step 1 if the
      // second move fails so a non-resumed failure leaves live intact.
      await this.idempotentMove(liveTarget, brokenDir);
      try {
        await this.idempotentMove(clone, liveTarget);
      } catch (err) {
        await this.idempotentMove(brokenDir, liveTarget).catch(() => {});
        throw err;
      }
    });

    // Marker sidecar at a DETERMINISTIC path (so rollback recovers the live
    // target without parsing the dir name). Idempotent overwrite.
    await steps.runStep('promote-write-meta', async () => {
      await writeFile(
        `${brokenDir}.meta.json`,
        JSON.stringify({ broken: brokenDir, live: liveTarget, promotedFrom: clone }, null, 2),
      );
    });
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
  async rollbackPromote(opts: { brokenPath: string; opId?: string }): Promise<{ liveBefore: string; liveAfter: string }> {
    const { resolve, basename, dirname } = await import('node:path');
    const steps = backupStepRunner();
    const root = resolve(this.workspaceRoot);
    const broken = resolve(opts.brokenPath);
    if (broken !== root && !broken.startsWith(root + '/')) {
      throw new Error(`refusing to rollback: ${broken} is outside workspace`);
    }
    // Resolve the live target. Prefer the deterministic meta sidecar that
    // promote writes (robust — no dir-name parsing); fall back to the legacy
    // `.broken-<ts>-<name>` regex for pre-P-012 dirs that have no sidecar.
    let liveTarget: string;
    try {
      const meta = JSON.parse(await readFile(`${broken}.meta.json`, 'utf8')) as { live?: string };
      if (!meta.live) throw new Error('meta has no live');
      liveTarget = resolve(meta.live);
    } catch {
      const m = /^\.broken-([0-9T:.\-Z]+)-(.+)$/.exec(basename(broken));
      if (!m) {
        throw new Error(
          `refusing to rollback: ${basename(broken)} has no .meta.json sidecar and doesn't match .broken-<ts>-<name>`,
        );
      }
      liveTarget = join(dirname(broken), m[2]!);
    }
    if (liveTarget !== root && !liveTarget.startsWith(root + '/')) {
      throw new Error(`refusing to rollback: resolved live ${liveTarget} escapes workspace`);
    }
    const tag = sanitizeOpTag(opts.opId ?? new Date().toISOString().replace(/[:.]/g, '-'));
    const stash = join(dirname(broken), `.rolled-back-${tag}-${basename(liveTarget)}`);

    // One step, same all-or-nothing reasoning as promote-swap: stash the
    // current live (the promoted clone), then bring the broken dir back to
    // live; undo the stash if that fails. Idempotent across a resume.
    await steps.runStep('rollback-swap', async () => {
      const [liveExists, brokenExists, stashExists] = await Promise.all([
        this.pathExists(liveTarget),
        this.pathExists(broken),
        this.pathExists(stash),
      ]);
      // Resume: live→stash done, broken→live not yet.
      if (stashExists && !liveExists && brokenExists) {
        await this.idempotentMove(broken, liveTarget);
        return;
      }
      // Already fully rolled back.
      if (stashExists && liveExists && !brokenExists) return;
      await this.idempotentMove(liveTarget, stash);
      try {
        await this.idempotentMove(broken, liveTarget);
      } catch (err) {
        await this.idempotentMove(stash, liveTarget).catch(() => {});
        throw err;
      }
    });

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
    const sql = backupHost().getSql();
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

  private async pathExists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Move `from` → `to`, idempotent on a crash-resume replay:
   *   - from exists, to doesn't → the move (the normal case);
   *   - from gone, to exists     → a prior attempt already completed it (no-op);
   *   - neither exists           → data lost — throw rather than continue blindly;
   *   - both exist               → ambiguous — refuse rather than clobber `to`.
   * With deterministic op-id-derived names this makes the destructive renames
   * safe to replay, which is what lets the StepRunner buy them crash-resume.
   */
  private async idempotentMove(from: string, to: string): Promise<void> {
    const fromExists = await this.pathExists(from);
    const toExists = await this.pathExists(to);
    if (!fromExists && toExists) return;
    if (!fromExists && !toExists) {
      throw new Error(`idempotentMove: neither source (${from}) nor target (${to}) exists`);
    }
    if (fromExists && toExists) {
      throw new Error(`idempotentMove: both source (${from}) and target (${to}) exist — refusing to clobber`);
    }
    await rename(from, to);
  }

  private envWithPassword(password: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      KOPIA_PASSWORD: password,
      KOPIA_CONFIG_PATH: join(this.workspaceRoot, 'backups', 'repository.config'),
      KOPIA_LOG_DIR: join(this.workspaceRoot, 'backups', 'logs'),
      KOPIA_CACHE_DIRECTORY: join(this.workspaceRoot, 'backups', 'cache'),
    };
  }

  /**
   * Sync the kopia global policy (retention + ignore rules) to current
   * settings. Called from ensureRepo on every path — including the
   * warm/already-connected one — so retention and excludedPaths changes
   * made via updateSettings actually reach kopia.
   *
   * `fatal` (default true): on the repo create/connect path a failure
   * here MUST abort — a new repo without the ignore policy would
   * snapshot its own kopia-repo recursively. On the warm path the
   * caller passes `fatal: false`: a transient `policy set` hiccup must
   * not skip the snapshot, and assertSelfExclusionPolicy still
   * backstops the recursion guard.
   */
  private async applyGlobalPolicy(
    env: NodeJS.ProcessEnv,
    opts: { fatal?: boolean } = {},
  ): Promise<void> {
    const fatal = opts.fatal ?? true;
    try {
      const settings = await this.getSettings();
      const retention =
        settings.retentionPreset === 'custom' && settings.retentionCustom
          ? settings.retentionCustom
          : RETENTION_PRESETS[settings.retentionPreset === 'custom' ? 'default' : settings.retentionPreset];
      const ignores = [...IGNORE_PATTERNS, ...settings.excludedPaths];

      // `kopia policy set --add-ignore` only appends — it never drops a
      // rule. Read the policy back and `--remove-ignore` anything stale
      // (e.g. an excludedPath the user removed in the UI). Best-effort
      // read: a brand-new repo has no policy yet — treat as empty.
      let current: string[] = [];
      try {
        const raw = await this.kopia(['policy', 'show', '--global', '--json'], { env });
        const parsed = JSON.parse(raw) as { files?: { ignore?: string[] } };
        current = parsed.files?.ignore ?? [];
      } catch {
        // No readable policy yet.
      }
      const { toAdd, toRemove } = diffPolicyIgnores(current, ignores);

      const args = [
        'policy', 'set', '--global',
        `--keep-latest=${retention.keepLatest}`,
        `--keep-hourly=${retention.keepHourly}`,
        `--keep-daily=${retention.keepDaily}`,
        `--keep-weekly=${retention.keepWeekly}`,
        `--keep-monthly=${retention.keepMonthly}`,
        ...toRemove.map((p) => `--remove-ignore=${p}`),
        ...toAdd.map((p) => `--add-ignore=${p}`),
      ];
      await this.kopia(args, { env });
    } catch (err) {
      if (fatal) throw err;
      // eslint-disable-next-line no-console
      console.warn(`[backup] applyGlobalPolicy (best-effort) for ${this.workspaceId} failed:`, err);
    }
  }

  /**
   * Read the global policy and assert that `backups` is in the ignore
   * rules. We snapshot workspaceRoot, which contains the kopia repo
   * itself at backups/kopia-repo — without this rule each snapshot
   * recursively re-includes the previous repo and the store balloons.
   * If the rule is missing we reapply the policy and re-check; if still
   * missing we fail loudly rather than silently producing a recursive
   * snapshot.
   */
  private async assertSelfExclusionPolicy(env: NodeJS.ProcessEnv): Promise<void> {
    // Verify the live kopia policy still excludes EVERY load-bearing
    // self-exclusion rule — not just 'backups'. `.restored` / `.broken-*` /
    // `.rolled-back-*` also live inside the workspace root and would be
    // snapshotted recursively if dropped.
    const missingRules = async (): Promise<string[]> => {
      const raw = await this.kopia(['policy', 'show', '--global', '--json'], { env });
      const parsed = JSON.parse(raw) as { files?: { ignore?: string[] } };
      const rules = parsed.files?.ignore ?? [];
      return SELF_EXCLUSION_RULES.filter((r) => !rules.includes(r));
    };
    if ((await missingRules()).length === 0) return;
    await this.applyGlobalPolicy(env);
    const stillMissing = await missingRules();
    if (stillMissing.length === 0) return;
    throw new Error(
      `[backup] refusing to snapshot ${this.workspaceId}: global policy is missing self-exclusion ` +
      `rule(s) [${stillMissing.join(', ')}]. This would include the kopia repo / restore scratch ` +
      `dirs at ${this.repoPath} recursively in its own snapshot.`,
    );
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

  /**
   * Same as kopia() but always returns the full command transcript
   * (cmd, stdout, stderr, exit, durationMs) instead of throwing.
   * Used by the /dev terminal so developers can see exactly what ran.
   */
  async kopiaTraced(args: string[]): Promise<{
    command: string; exitCode: number; stdout: string; stderr: string; durationMs: number;
  }> {
    const password = await deriveRepoPassword(this.workspaceId);
    const env = this.envWithPassword(password);
    const start = Date.now();
    return new Promise((resolve) => {
      const child = spawn(KOPIA_BIN, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = []; const err: Buffer[] = [];
      child.stdout.on('data', (d) => out.push(d));
      child.stderr.on('data', (d) => err.push(d));
      child.on('error', (e) => resolve({
        command: `${KOPIA_BIN} ${args.join(' ')}`,
        exitCode: -1, stdout: '', stderr: String(e), durationMs: Date.now() - start,
      }));
      child.on('close', (code) => resolve({
        command: `${KOPIA_BIN} ${args.join(' ')}`,
        exitCode: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        durationMs: Date.now() - start,
      }));
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
 * Make an op id / timestamp safe + bounded for use inside a `.broken-*` /
 * `.rolled-back-*` directory name. Non-`[A-Za-z0-9._-]` chars (path separators,
 * spaces) collapse to `_` so the tag can never inject a path segment, and the
 * length is capped so a long id can't blow past filesystem name limits.
 */
function sanitizeOpTag(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'op';
}

/**
 * Kopia's `snapshot create --json` emits one JSON object per source on
 * success. We back up one source per call, so we expect one object.
 *
 * Exported for unit testing (Gap 3): the parser is pure and is the only
 * place the bytesAdded/bytesTotal fallback chain + missing-id guard live.
 */
export function parseKopiaSnapshotJson(stdout: string): {
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
