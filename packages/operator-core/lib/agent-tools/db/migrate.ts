/**
 * db:migrate — the blessed path to apply a schema migration, coordinated (P-027).
 *
 * Acquires exclusive(db-schema) with a drain so in-flight schema-dependent
 * work finishes before destructive DDL runs, then applies the migration,
 * then releases. Use this instead of a raw `psql -f` so peers are coordinated.
 *
 * Safe by default: no `confirm` → DRY RUN (no lock, no psql). With confirm it
 * acquires + drains, and applies the file ONLY if PAPERCUSP_ALLOW_DB_MIGRATE=1.
 */

import { z } from 'zod';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { readIdentity } from '../locks/identity';
import { resolveAgentIdentity } from '../coordination/identity';
import { guardResource } from '../locks/resource-lock-guard';
import { inWorkspaceTxn } from '../locks/in-workspace-txn';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import {
  checkResourceAction,
  recordResourceAction,
  getTxPool,
  type ResourceHolder,
} from '../locks/su-lock-store';

const MAX_DRAIN_SEC = 300;
const DEFAULT_DRAIN_SEC = 60;

const SU_ROLES = [
  'scoper', 'architect', 'worker', 'validator', 'reviewer',
  'debugger', 'operator', 'documenter', 'curator',
] as const;

const json = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

const holderJson = (h: ResourceHolder) => ({
  owner: h.owner, owner_label: h.owner_label, mode: h.mode, status: h.status,
});

export default defineTool({
  name: 'db:migrate',
  description:
    'Apply a SQL migration file, coordinated. DRY RUN unless confirm:true. With confirm, acquires exclusive(db-schema) and drains schema-dependent work (wait:{max_drain_sec}) before running psql -f <file>, then releases. The real apply also requires PAPERCUSP_ALLOW_DB_MIGRATE=1. Prefer this over a raw psql -f.',
  guidance: {
    when: 'Applying a migration / destructive DDL that could disrupt in-flight queries. Dry-run to see holders; confirm to drain + apply.',
    notWhen: 'Read-only SQL needs no lock. Never apply migrations casually on a shared box.',
    chaining: 'db:migrate { file } (dry) → review → db:migrate { file, confirm: true }.',
  },
  capability: 'locks:write',
  timeoutSec: MAX_DRAIN_SEC + 60,
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    file: z.string().min(1).describe('Absolute path to the .sql migration file to apply.'),
    confirm: z.boolean().optional(),
    max_drain_sec: z.number().int().nonnegative().max(MAX_DRAIN_SEC).optional(),
  }),
  async handler(args, ctx) {
    if (!args.confirm) {
      return json({
        ok: true,
        dry_run: true,
        would_run: `psql <admin-url> -v ON_ERROR_STOP=1 -f ${args.file}`,
        note: 'Pass confirm:true to acquire exclusive(db-schema), drain, then apply. The real apply also requires PAPERCUSP_ALLOW_DB_MIGRATE=1.',
      });
    }

    const { ownerId, ownerLabel, coordinationDomain } = readIdentity(ctx);
    const coordIdentity = resolveAgentIdentity(ctx);
    const enabled = process.env.PAPERCUSP_ALLOW_DB_MIGRATE === '1';

    const outcome = await guardResource(
      {
        coordinationDomain,
        ownerId,
        ownerLabel,
        coordIdentity,
        resource: 'db-schema',
        mode: 'exclusive',
        maxDrainSec: args.max_drain_sec ?? DEFAULT_DRAIN_SEC,
        reason: `apply migration ${args.file}`,
      },
      async (fence) => {
        if (!enabled) {
          return json({
            ok: true,
            drained: true,
            applied: false,
            note: 'Drain complete, but apply WITHHELD — set PAPERCUSP_ALLOW_DB_MIGRATE=1 to enable the real psql apply.',
          });
        }
        // D-001 fencing: re-verify we still hold the effective exclusive at our
        // fence before the irreversible DDL apply. A paused/zombie holder whose
        // lease lapsed and was re-granted is rejected — no merge un-corrupts a
        // double-migrate, so this is correctness-class.
        const fc = await fence.assertCurrent();
        if (!fc.current) {
          return json({
            ok: false,
            applied: false,
            reason: `stale_fence_${fc.reason}`,
            fence_seq: fence.seq,
            live_fence_seq: fc.live_fence_seq,
            note: 'Migration ABORTED — our exclusive(db-schema) lease was superseded while we held it. Re-acquire before retrying.',
          });
        }
        // D-001 resource-side idempotency: make the su_meta migration-name check
        // EXPLICIT. A retried / zombie re-apply of the SAME file short-circuits
        // here as a checked no-op even if fencing were somehow bypassed.
        const actionKey = `migrate:${path.basename(args.file)}`;
        const prior = await checkResourceAction(getTxPool(), coordinationDomain, actionKey);
        if (prior.applied) {
          return json({
            ok: true,
            applied: false,
            already_applied: true,
            action_key: actionKey,
            prior_fence_seq: prior.fence_seq,
            note: 'This migration file was already applied (resource-side idempotency ledger) — no-op.',
          });
        }
        const url = getHarnessAdminUrl();
        // perf:allow A4 — this tool IS the sanctioned dev-only migration
        // applier: `psql -f` runs full .sql files (dollar-quoted functions,
        // DO blocks, COPY, \meta-commands) that postgres-js can't, and it's
        // gated behind PAPERCUSP_ALLOW_DB_MIGRATE + the db-schema lock. Not
        // runtime/shipped data-plane code. Mirrored in @papercusp/export-state's
        // no-psql-shellout ALLOW set.
        const r = spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-f', args.file], {
          encoding: 'utf8',
        });
        if (r.status !== 0) {
          return json({ ok: false, applied: false, exit_code: r.status, stderr: (r.stderr ?? '').slice(-2000) });
        }
        // Record only on a successful apply (first writer wins).
        await inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
          recordResourceAction(tx, coordinationDomain, actionKey, fence.seq),
        );
        return json({ ok: true, drained: true, applied: true, file: args.file, fence_seq: fence.seq });
      },
    );

    if (outcome.acquired) return outcome.result;
    return json({
      ok: false,
      reason: `resource_${outcome.reason}`,
      resource: 'db-schema',
      holders: outcome.holders.map(holderJson),
    });
  },
});
