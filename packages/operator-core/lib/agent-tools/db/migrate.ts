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
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
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
    seeAlso: [
      'db:check_drift (verify schema drift first)',
      'db:next-migration (scaffold a new migration)',
      'db:migrate-policy (deploy-migration lock policy)',
    ],
  },
  capability: 'locks:write',
  timeoutSec: MAX_DRAIN_SEC + 60,
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
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
          // EI-6879: PAPERCUSP_ALLOW_DB_MIGRATE is a deliberate host-level opt-in
          // (same rail as PAPERCUSP_ALLOW_DEV_RESTART) — an agent cannot set it
          // remotely, so on a dev box without it configured this withheld branch
          // is the ONLY path every migration takes. Every agent that hit this
          // previously had to reverse-engineer the sanctioned fallback (a raw
          // `psql -f` + a same-transaction schema_migrations INSERT, mirroring
          // embedded-postgres-server's migration-runner.js) from scratch — the
          // note below spells it out inline so that rediscovery cost is zero.
          // CAUTION per CLAUDE.md § storage policy: a bare `psql -f` WITHOUT the
          // same-txn INSERT leaves schema_migrations un-recorded, so every future
          // deploy re-runs the file (a lock-contending re-run can trip a
          // deploy's lock_timeout) — always include the INSERT in the same BEGIN/COMMIT.
          const url = getHarnessAdminUrl();
          return json({
            ok: true,
            drained: true,
            applied: false,
            note: 'Drain complete, but apply WITHHELD — set PAPERCUSP_ALLOW_DB_MIGRATE=1 on the operator host to enable the real psql apply.',
            fallback: {
              why: 'PAPERCUSP_ALLOW_DB_MIGRATE is a deliberate owner-authority safety rail (like PAPERCUSP_ALLOW_DEV_RESTART) — it cannot be set by an agent call, only by the host operator process env.',
              caution:
                'You already hold exclusive(db-schema) + the drain completed, so applying by hand here is coordinated and safe AS LONG AS you record the schema_migrations row in the SAME transaction as the DDL — a bare `psql -f` without it leaves the migration unrecorded, so every future deploy/boot re-applies the file (a lock-contending re-run can trip a deploy lock_timeout).',
              command: `psql "${url}" -v ON_ERROR_STOP=1 <<'SQL'\nBEGIN;\nSET LOCAL statement_timeout = 0;\n\\i ${args.file}\nINSERT INTO harness_shared.schema_migrations (filename, sha256) VALUES ('${path.basename(args.file)}', '<sha256 of the file bytes, e.g. sha256sum ${args.file}>');\nCOMMIT;\nSQL`,
              note: 'sha256 must match createHash(\'sha256\').update(<raw file text>).digest(\'hex\') (embedded-postgres-server/src/migration-runner.js) — `sha256sum <file>` on the exact file bytes gives the same value.',
            },
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
        // EI-6962: the previous version ran the file bare (`psql -f <file>`)
        // and only recorded success in the su_meta coordination-domain
        // idempotency ledger (recordResourceAction below) — NEVER in
        // harness_shared.schema_migrations, the table every deploy/boot
        // actually reads to decide what's already applied. That left the
        // enabled path (this branch) exactly as unsafe as the withheld
        // path's own fallback warns against: a future deploy/boot re-runs
        // the "applied" file, and a lock-contending re-run can trip the
        // deploy's lock_timeout (the 2026-06-09 ~1h wedge this tool exists
        // to prevent). Fix: wrap the file in the SAME BEGIN/COMMIT as the
        // schema_migrations INSERT, mirroring both the withheld-branch's own
        // documented fallback command above and
        // embedded-postgres-server/src/migration-runner.js's boot-apply path
        // — `\i` (not `-f`) so the file still runs through psql's full
        // meta-command interpreter (dollar-quotes, DO blocks, COPY), keeping
        // the perf:allow A4 rationale below intact.
        const sha256 = createHash('sha256').update(readFileSync(args.file, 'utf8')).digest('hex');
        const filenameLiteral = path.basename(args.file).replace(/'/g, "''");
        const script =
          `BEGIN;\n` +
          `SET LOCAL statement_timeout = 0;\n` +
          `\\i ${args.file}\n` +
          `INSERT INTO harness_shared.schema_migrations (filename, sha256) VALUES ('${filenameLiteral}', '${sha256}');\n` +
          `COMMIT;\n`;
        // perf:allow A4 — this tool IS the sanctioned dev-only migration
        // applier: psql's meta-command interpreter runs full .sql files
        // (dollar-quoted functions, DO blocks, COPY, \meta-commands) that
        // postgres-js can't, and it's gated behind PAPERCUSP_ALLOW_DB_MIGRATE
        // + the db-schema lock. Not runtime/shipped data-plane code. Mirrored
        // in @papercusp/export-state's no-psql-shellout ALLOW set.
        const r = spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1'], {
          input: script,
          encoding: 'utf8',
        });
        if (r.status !== 0) {
          return json({ ok: false, applied: false, exit_code: r.status, stderr: (r.stderr ?? '').slice(-2000) });
        }
        // Record only on a successful apply (first writer wins). This is the
        // su_meta coordination-domain idempotency ledger (a DIFFERENT record
        // from the schema_migrations row the script above just committed) —
        // it backstops a retried/zombie re-apply of the SAME file even when
        // this tool's own fencing were somehow bypassed (D-001 above).
        await inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
          recordResourceAction(tx, coordinationDomain, actionKey, fence.seq),
        );
        return json({
          ok: true,
          drained: true,
          applied: true,
          file: args.file,
          fence_seq: fence.seq,
          schema_migrations_recorded: true,
          sha256,
        });
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
