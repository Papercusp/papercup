/**
 * composition-rig.ts — the hermetic 2-swarm COMPOSITION rig for
 * `shared-hive-loop-e2e-testing-2026-06-10` Phase 1 (P-001..P-007).
 *
 * Two Swarm cells of ONE shared Hive run in one process, each with its OWN
 * Postgres database and its OWN Hypercore log, composed exactly as production
 * composes them (plan D-001 — test the loop as a system, never a layer alone):
 *
 *   steering   — a SCRIPTED Queen turn reads the federated backlog from its
 *                cell's PG and steers with the REAL `setWorkItemPriority`
 *                (`feature_order`, the column claim_next orders by);
 *   dispatch   — the REAL `claimNextWorkItem` (SKIP LOCKED, priority-ordered,
 *                affinity/redundancy-aware: the flags-ON shape, D-003) runs
 *                against each cell's own PG via the `cell-scope` ALS seam,
 *                then the per-Hive AUTHORITY lease is acquired through the
 *                REAL `routeToAuthorityForHive` + `HttpPeerRpcTransport` over
 *                loopback (authority = argmin pubkey = cell A), exactly the
 *                claim-agent / two-instance shape;
 *   execution  — a FAKE pipeline (zero LLM) stands in for the DBOS
 *                featurePipelineWorkflow: per-cell idempotency keyed on the
 *                real workflow-id shape (`pipeline:<slug>:<item>:e<epoch>`),
 *                an EXTERNAL side-effect ledger row (the stand-in for git
 *                commits/spawns — deliberately NOT federated), and status
 *                writes on the cell's own PG. The DBOS durability axis itself
 *                is hive-loop-e2e's lane (D-006) — inherited, not re-tested;
 *   convergence— the REAL CDC chain end to end: migration-102 capture trigger
 *                → substrate_outbox → `drainOutboxOnce` → own Hypercore log →
 *                real Hyperswarm replication (local testnet DHT) → peer
 *                read-merge → the REAL PG projections (EI-117 skipOwnOps +
 *                LWW-guard shape) + the migration-214 local-stamp trigger;
 *   redundancy — the work_item_replicas store (migration 195) on the
 *                authority's PG for the BOINC fan-out scenarios (P-007).
 *
 * Claim-store persistence note: each cell's Hive-lease store is the
 * `InMemoryWorkItemClaimStore` (the documented coordinator seam — semantics
 * proven identical to the SQL store by work-item-claim-mem-store tests; the
 * SQL store's authority-fronted serialization is proven on real PG by
 * work-item-claims-two-instance). The local SKIP-LOCKED claim layer
 * (`taken_by`) runs on REAL per-cell PG here, so the lease axis loses no
 * coverage while the rig keeps an injectable clock — which is what lets the
 * lease-expiry (P-004) and authority-staleness (P-003) windows compress from
 * hours/90s to milliseconds.
 *
 * Chaos knobs: `killAuthority()` (HTTP endpoint dies; presence freezes so the
 * staleness window — compressed via `staleMs` — drives re-election),
 * `setPartitioned(true)` (authority RPC becomes unreachable → fail-open local
 * leases; heal + `converge()` + `reconcileAll` resolves), `advanceClock(ms)`
 * (lease expiry / staleness, without wall-clock sleeps).
 *
 * Test-file wiring (required once per test file — vi.mock hoists per-file):
 *
 *   vi.mock('@papercusp/db-org', async () => {
 *     const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
 *     const { currentCellSql } = await import('./cell-scope');
 *     return {
 *       ...actual,
 *       getOrgPg: () => {
 *         const sql = currentCellSql();
 *         if (!sql) throw new Error('getOrgPg outside cell scope — wrap in rig.runAsCell()');
 *         return { sql };
 *       },
 *     };
 *   });
 */
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import { bootHarnessSubstrate, type BootedHarnessHandle } from '../sync/hyperbee/boot';
import { type HyperswarmLike } from '../sync/hyperbee/swarm';
import type { OpEnvelope } from '../sync/hyperbee/op-envelope-types';
import { _resetBootHistoryForTests } from '../sync/hyperbee/boot-history';
import { _resetCacheForTests, closeHarnessStore } from '../sync/hyperbee/corestore';
import { drainOutboxOnce } from '../sync/hyperbee/outbox-drain';
import { applyOpVia, type ProjectionLookup, type TableProjection } from '../sync/hyperbee/projection';
import { buildHarnessFeaturesProjection } from '../sync/hyperbee/projections/harness-features';
import { buildIssuesProjection } from '../sync/hyperbee/projections/issues';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  WORK_ITEM_CLAIM_OP_KINDS,
  type AcquireOpts,
  type AcquireResult,
  type WorkItemClaim,
} from '../work-item-claims';
import { InMemoryWorkItemClaimStore } from '../work-item-claim-mem-store';
import { HlcClock } from '@papercusp/locks-core';
import { registerWorkItemClaimAuthorityOps } from '../work-item-claim-authority-ops';
import {
  handleAuthorityRpc,
  __resetAuthorityOpsForTests,
  type AuthorityRpcEnvelope,
} from '../authority/authority-op-registry';
import {
  routeToAuthorityForHive,
  lockAuthorityForHive,
  type LockAuthorityDeps,
} from '../authority/lock-authority';
import { setPeerRpcTransport, __resetPeerRpcTransportForTests } from '../authority/peer-rpc-transport';
import { HttpPeerRpcTransport } from '../authority/http-peer-rpc-transport';
import { __resetRemotePeersCacheForTests } from '../authority/remote-peers-cache';
import {
  claimNextWorkItem,
  releaseWorkItem,
  setWorkItemPriority,
  setWorkItemSwarmAffinity,
  type WorkItem,
} from '../work-items';
import { runWithCellSql } from './cell-scope';
import type { BacklogRow, SideEffectRow } from './composition-oracles';

const __dirname = dirname(fileURLToPath(import.meta.url));
// lib/shared-hive-loop → packages/operator-core → repo root is four levels up.
const REPO_ROOT = resolve(__dirname, '../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Identity / swarm helpers (mirror feature-content-federation Stage 6) ─────

function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.subarray(-32).toString('base64');
}

function makeIdentityOverride(login: string, userId: number, keychainId: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = rawPubkeyBase64(publicKey);
  return {
    devicePubkey,
    userId,
    override: {
      resolveOpts: {
        keychainId,
        resolveGithubUser: async () => ({ id: userId, login }),
        loadKeypair: async (id: string) => ({ keychainId: id, pubkeyBase64: devicePubkey }),
        resolveAttestationGistId: async () => `gist-${login}`,
      },
      sign: async (_keychainId: string, bytes: Buffer) => nodeSign(null, bytes, privateKey),
    },
  };
}

/** Cluster-global framework roles the migration GRANTs reference (idempotent). */
const FRAMEWORK_ROLES_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
      CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
      CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN
      CREATE ROLE harness_zero LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd';
    END IF;
  END $pg$;
`;

/**
 * Build the minimal-but-faithful schema in one cell's DB: the consolidated
 * feature/issue tables with the FULL dispatch column set (item_kind,
 * feature_order, swarm_affinity, assignee_rank — migrations 136/178; redundancy
 * arrives via 195 verbatim), then the REAL migration files verbatim for every
 * load-bearing trigger/table: 102 (outbox + capture), 103 (workspace fill),
 * 188 (work_item_claims), 195 (redundancy replicas), 214's local-stamp
 * function (attached to the two tables present here), and the 181-shape
 * fed_ts-masked UPDATE capture guards. Mirrors (and extends) the proven
 * Stage-6 federation-test schema.
 */
async function setupCellSchema(sql: postgres.Sql, opts: { workspaceId: string; harnessSlug: string }): Promise<void> {
  await sql.unsafe(FRAMEWORK_ROLES_DDL);

  await sql.unsafe(`
    CREATE TABLE harness_shared.harness_features_consolidated (
      workspace_id        TEXT NOT NULL DEFAULT '',
      harness_slug        TEXT NOT NULL,
      feature_id          TEXT NOT NULL,
      title               TEXT,
      summary             TEXT,
      status              TEXT,
      attempts            INT,
      claims              TEXT,
      notes               TEXT,
      metadata            JSONB,
      kind                TEXT,
      project_id          TEXT,
      expected_cost_cents INT,
      tags                JSONB,
      needs_human_review  BOOLEAN,
      ts                  BIGINT,
      created_ts          BIGINT,
      updated_ts          BIGINT,
      parent_id           TEXT,
      goal_id             TEXT,
      taken_by            TEXT,
      taken_at            TIMESTAMPTZ,
      expires_at          TIMESTAMPTZ,
      author_pubkey       TEXT,
      origin              TEXT NOT NULL DEFAULT 'local',
      -- G2 admission gate columns the claim/place paths reference via
      -- autoPickableWhereSql (audit_verdict: P-005; verified_author_github_user_id:
      -- the P-008/P-010 trust leg, read whenever a workspaceId is passed).
      audit_verdict       TEXT,
      verified_author_github_user_id BIGINT,
      fed_ts              BIGINT,
      -- migration 136: the work-item family discriminator claim_next filters on
      item_kind           TEXT NOT NULL DEFAULT 'feature',
      -- migration 136-era payload column FEATURE_COLS returns
      payload             JSONB,
      -- decentralized-dispatch (D-003/D-009): the Queen's backlog steering column
      feature_order       INT,
      -- hive-coordination-model P-002: the Queen's co-location lever
      swarm_affinity      TEXT,
      -- migration 178: the per-assignee post-claim queue rank
      assignee_rank       INT,
      rank_writer         TEXT,
      rank_updated_at     TIMESTAMPTZ,
      PRIMARY KEY (harness_slug, feature_id)
    );
    -- G2 trust leg (P-010): the claim/place paths' autoPickableWhereSql(sql, ws)
    -- consult this table; the real claimNextWorkItem the rig drives needs it.
    CREATE TABLE harness_shared.user_trust_list (
      workspace_id text NOT NULL,
      trusted_github_user_id bigint NOT NULL,
      note text,
      created_ts bigint NOT NULL,
      PRIMARY KEY (workspace_id, trusted_github_user_id)
    );
    -- P-008 producer side: the harness-features projection resolves a REMOTE
    -- row's author_pubkey → verified_author_github_user_id via a verified,
    -- non-revoked hive_members device attestation (resolveVerifiedAuthorGithubId).
    -- Only the columns that resolver reads (the real table has more); seedTrust()
    -- attests each peer cell so cross-swarm federated work is trust-admissible.
    CREATE TABLE harness_shared.hive_members (
      workspace_id        text NOT NULL,
      hive_home_slug      text,
      github_user_id      bigint,
      binding_status      text,
      device_attestations jsonb,
      revoked_pubkeys     text[],
      author_pubkey       text,
      origin              text NOT NULL DEFAULT 'local',
      fed_ts              bigint,
      PRIMARY KEY (workspace_id, github_user_id)
    );
    CREATE TABLE harness_shared.harness_issues_consolidated (
      harness_slug      TEXT NOT NULL,
      issue_id          TEXT NOT NULL,
      title             TEXT NOT NULL,
      severity          TEXT NOT NULL,
      source            TEXT NOT NULL,
      status            TEXT NOT NULL,
      found_at          TIMESTAMPTZ NOT NULL,
      found_during      TEXT,
      repro             TEXT,
      evidence          TEXT,
      suggested_fix     TEXT,
      code_pointer      TEXT,
      linked_feature_id TEXT,
      attempts          INT NOT NULL DEFAULT 0,
      notes             JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_ts        BIGINT NOT NULL,
      updated_ts        BIGINT NOT NULL,
      author_pubkey     TEXT,
      origin            TEXT NOT NULL DEFAULT 'local',
      fed_ts            BIGINT,
      PRIMARY KEY (harness_slug, issue_id)
    );
    CREATE TABLE harness_shared.projects (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      status       TEXT NOT NULL,
      slug         TEXT,
      workspace_id TEXT,
      created_ts   BIGINT NOT NULL,
      updated_ts   BIGINT NOT NULL
    );
    -- The rig's EXTERNAL side-effect ledger: the stand-in for the duplicable,
    -- non-federated actions a real pipeline performs (git commits, spawns).
    -- Deliberately NO capture trigger — it must NOT converge across cells.
    CREATE TABLE harness_shared.rig_side_effects (
      work_item_id   TEXT NOT NULL,
      executed_by    TEXT NOT NULL,
      executed_at_ms BIGINT NOT NULL,
      note           TEXT
    );
  `);

  // Map the harness slug → the workspace_id the booted handle drains on (the
  // migration-103 fill trigger stamps it on projection inserts).
  await sql`
    INSERT INTO harness_shared.projects (id, name, status, slug, workspace_id, created_ts, updated_ts)
    VALUES ('p-shl', 'SharedHiveLoop', 'active', ${opts.harnessSlug}, ${opts.workspaceId}, 0, 0)
  `;

  // The REAL migration files, verbatim — minus psql meta-commands (`\set …`)
  // and the standalone BEGIN;/COMMIT; wrappers, both of which the embedded-pg
  // migration runner handles and raw pooled sql.unsafe rejects. (plpgsql BEGIN
  // bodies are indented/inline — the line-anchored match never touches them.)
  for (const file of [
    'archive/102-substrate-outbox.sql',
    'archive/103-issues-workspace-id-fill-trigger.sql',
    '131-engineer-issues.sql',
    '188-work-item-claims.sql',
    '195-work-item-redundancy.sql',
    // Signal provenance (frontier P-002, migration 241): ISSUE_COLS selects signal_origin.
    '241-signal-provenance-origin.sql',
  ]) {
    const text = readFileSync(join(SQL_DIR, file), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('\\') && !/^(BEGIN|COMMIT);\s*$/i.test(l))
      .join('\n');
    await sql.unsafe(text);
  }

  // The unified work-item lookup probes the issue family too (getIssue's
  // ISSUE_COLS) — columns later migrations (136/142/152/178) added to the
  // mig-131 table, condensed here since those migrations touch tables this
  // schema doesn't carry. The rig never writes issue-family rows; the columns
  // only need to exist for the SELECT.
  await sql.unsafe(`
    ALTER TABLE harness_shared.engineer_issues
      ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'bug',
      ADD COLUMN IF NOT EXISTS assigned_by text,
      ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
      ADD COLUMN IF NOT EXISTS payload jsonb,
      ADD COLUMN IF NOT EXISTS assignee_rank integer,
      ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz;
  `);

  // Migration 214's stamp_local_federated_write function VERBATIM (sliced
  // before its 11-table attach loop — this schema has two of the eleven), then
  // attached to the two tables present here.
  const mig214 = readFileSync(join(SQL_DIR, '214-federated-fed-ts-local-stamp.sql'), 'utf8');
  const fnEnd = mig214.indexOf('DO $body$');
  if (fnEnd < 0) throw new Error('composition-rig: migration 214 shape changed — update the slice point');
  await sql.unsafe(mig214.slice(0, fnEnd));
  await sql.unsafe(`
    CREATE TRIGGER stamp_local_federated_write_trg
      BEFORE INSERT OR UPDATE ON harness_shared.harness_features_consolidated
      FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write();
    CREATE TRIGGER stamp_local_federated_write_trg
      BEFORE INSERT OR UPDATE ON harness_shared.harness_issues_consolidated
      FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write();
  `);

  // The 181-shape UPDATE capture guards: mask fed_ts so an own-log merge-back
  // settling pass cannot re-enqueue forever (the Stage-6 convergence guard).
  await sql.unsafe(`
    CREATE OR REPLACE TRIGGER capture_substrate_outbox_upd_trg
      AFTER UPDATE ON harness_shared.harness_features_consolidated
      FOR EACH ROW WHEN ((to_jsonb(OLD.*) - 'fed_ts') IS DISTINCT FROM (to_jsonb(NEW.*) - 'fed_ts'))
      EXECUTE FUNCTION harness_shared.capture_substrate_outbox('feature_id');
    CREATE OR REPLACE TRIGGER capture_substrate_outbox_upd_trg
      AFTER UPDATE ON harness_shared.harness_issues_consolidated
      FOR EACH ROW WHEN ((to_jsonb(OLD.*) - 'fed_ts') IS DISTINCT FROM (to_jsonb(NEW.*) - 'fed_ts'))
      EXECUTE FUNCTION harness_shared.capture_substrate_outbox('issue_id');
  `);
}

/** Per-peer projection apply bound to THIS cell's sql (the Stage-6 seam). */
function buildCellApply(
  sql: postgres.Sql,
  ownLogKeyHex: string,
  opts: { workspaceId: string; harnessSlug: string },
  extraProjections?: CompositionRigOpts['extraProjections'],
  hlcClock?: HlcClock,
): (op: OpEnvelope) => Promise<boolean> {
  const popts = { workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug, sql };
  const scoped = new Map<string, TableProjection<unknown>>();
  const projections = [
    buildHarnessFeaturesProjection(popts),
    buildIssuesProjection(popts),
    ...(extraProjections ? extraProjections(popts) : []),
  ] as TableProjection<unknown>[];
  for (const p of projections) {
    scoped.set(p.tableTag, p);
  }
  const lookup: ProjectionLookup = (tag) => scoped.get(tag) ?? null;
  // hlcClock: this cell's OWN HLC (the RECV seam advances it on remote ops) — NOT
  // the process-global one, so two cells in one process don't share a clock.
  return (op: OpEnvelope) => applyOpVia(lookup, op, { ownLogKeyHex, hlcClock });
}

// ── The rig ──────────────────────────────────────────────────────────────────

export type CellName = 'a' | 'b';

export interface SwarmCell {
  name: CellName;
  /** Injected ELECTION identity (argmin ⇒ cell a is the authority). */
  electionPubkey: string;
  /** The substrate ANNOUNCE identity (Ed25519 device pubkey) — what
   *  `handle.revoke(devicePubkey)` takes and what op provenance carries. */
  announcePubkey: string;
  githubUserId: number;
  /** Claim owner string (distinct per cell — two Swarms are distinct holders). */
  owner: string;
  sql: postgres.Sql;
  handle: BootedHarnessHandle;
  /** This cell's Hive-lease store (the coordinator seam; clock-injected). */
  store: InMemoryWorkItemClaimStore;
  deps: LockAuthorityDeps;
  /** Per-cell pipeline idempotency ledger — the DBOS workflow-id dedup analog. */
  pipelineRuns: Map<string, FakePipelineResult>;
}

export interface ClaimNextOutcome {
  item: WorkItem;
  via: 'local-authority' | 'remote-authority' | 'fail-open';
  /** false ⇒ the Hive lease is held by the other Swarm; the local claim was released. */
  leased: boolean;
  claim: WorkItemClaim | null;
}

export interface FakePipelineResult {
  ok: boolean;
  workItemId: string;
  executedBy: CellName;
  /** True when this call was deduped by the per-cell idempotency ledger. */
  deduped: boolean;
}

export interface CompositionRigOpts {
  workspaceId?: string;
  harnessSlug?: string;
  hiveSlug?: string;
  /** Authority-election presence staleness window (compressed in chaos tests). */
  staleMs?: number;
  /** Hive-lease TTL for claim_next-style claims (seconds). */
  claimTtlSec?: number;
  /** Authority RPC timeout — short so a dead/partitioned authority fails open fast. */
  rpcTimeoutMs?: number;
  log?: (m: string) => void;
  /**
   * Extra per-cell DDL run after `setupCellSchema` — for tests federating
   * surfaces beyond the work-item family (e.g. coord-e2e P-005 adds the
   * coord_event_log + its migration-147 capture triggers per cell).
   */
  extraCellSetup?: (sql: postgres.Sql, opts: { workspaceId: string; harnessSlug: string }) => Promise<void>;
  /**
   * Extra projections registered into each cell's apply chain alongside the
   * feature/issue ones (same `popts` contract as the production builders).
   */
  extraProjections?: (popts: { workspaceId: string; harnessSlug: string; sql: postgres.Sql }) => TableProjection<unknown>[];
}

export class CompositionRig {
  readonly workspaceId: string;
  readonly harnessSlug: string;
  readonly hiveSlug: string;
  readonly staleMs: number;
  readonly claimTtlSec: number;
  cells!: { a: SwarmCell; b: SwarmCell };

  /** Injectable clock: advanceClock() compresses lease/staleness windows. */
  private clockOffsetMs = 0;
  readonly now = (): number => Date.now() + this.clockOffsetMs;

  private partitioned = false;
  private server: Server | null = null;
  private serverUrl = '';
  private authorityKilled = false;
  /** Announce/device pubkeys the AUTHORITY cell has revoked — mirrored off cell
   *  A's handle.revoke so the EI-284 caller-standing gate sees the same view
   *  the substrate's announce-time refusal does. */
  private readonly revokedByAuthority = new Set<string>();
  /** Frozen presence timestamps for killed cells (live cells read the clock). */
  private frozenLastSeen = new Map<string, number>();
  private cleanups: Array<() => void | Promise<void>> = [];
  private priorWorkspaceEnv: string | undefined;
  private readonly log: (m: string) => void;

  constructor(opts: CompositionRigOpts = {}) {
    this.workspaceId = opts.workspaceId ?? 'ws-shl-comp';
    this.harnessSlug = opts.harnessSlug ?? 'shl';
    this.hiveSlug = opts.hiveSlug ?? 'shl-hive';
    this.staleMs = opts.staleMs ?? 10 * 60_000;
    this.claimTtlSec = opts.claimTtlSec ?? 300;
    this.rpcTimeoutMs = opts.rpcTimeoutMs ?? 1_500;
    this.log = opts.log ?? (() => {});
    this.extraCellSetup = opts.extraCellSetup;
    this.extraProjections = opts.extraProjections;
  }
  private readonly rpcTimeoutMs: number;
  private readonly extraCellSetup?: CompositionRigOpts['extraCellSetup'];
  private readonly extraProjections?: CompositionRigOpts['extraProjections'];

  advanceClock(ms: number): void {
    this.clockOffsetMs += ms;
  }

  /** Run `fn` with this cell's PG as the production `getOrgPg()` target. */
  runAsCell<T>(cell: SwarmCell, fn: () => Promise<T>): Promise<T> {
    return runWithCellSql(cell.sql, fn);
  }

  // ── Boot / teardown ────────────────────────────────────────────────────────

  async boot(): Promise<this> {
    // Pin the workspace claimNextWorkItem filters on (env wins over registry).
    this.priorWorkspaceEnv = process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_WORKSPACE_ID = this.workspaceId;

    const dbA: FreshPgDb = await createFreshPgDb('shlA');
    this.cleanups.push(() => dbA.cleanup());
    const dbB: FreshPgDb = await createFreshPgDb('shlB');
    this.cleanups.push(() => dbB.cleanup());
    const schemaOpts = { workspaceId: this.workspaceId, harnessSlug: this.harnessSlug };
    // Per-cell HLC clocks (NOT the process-global processHlc()): two real Swarms
    // are separate processes with independent clocks, so each simulated cell gets
    // its own — both SEND (boot's stampOpHlc) and RECV (apply's observeRemoteHlc)
    // seams use it. Driven by the rig's injectable `now()` so advanceClock() moves
    // the causal frontier deterministically. Without this, both cells share one
    // global clock and their concurrent drains race the same counter — deciding
    // cross-swarm LWW by drain-interleave rather than causal order.
    const hlcA = new HlcClock({ physical: () => this.now() });
    const hlcB = new HlcClock({ physical: () => this.now() });
    await setupCellSchema(dbA.sql, schemaOpts);
    await setupCellSchema(dbB.sql, schemaOpts);
    if (this.extraCellSetup) {
      await this.extraCellSetup(dbA.sql, schemaOpts);
      await this.extraCellSetup(dbB.sql, schemaOpts);
    }

    const testnet = await createTestnet(3);
    this.cleanups.push(async () => {
      try {
        await testnet.destroy();
      } catch {
        /* ignore */
      }
    });

    const idA = makeIdentityOverride('swarm-a', 4201, 'kc-shl-a');
    const idB = makeIdentityOverride('swarm-b', 4202, 'kc-shl-b');
    const mkSwarm = (): HyperswarmLike => {
      const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap }) as unknown as HyperswarmLike & {
        destroy(): Promise<void>;
      };
      this.cleanups.push(async () => {
        try {
          await swarm.destroy();
        } catch {
          /* ignore */
        }
      });
      return swarm;
    };
    const mkRoot = (prefix: string): string => {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      this.cleanups.push(() => {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      });
      return dir;
    };

    const binding = { kind: 'local' as const, workspace_id: this.workspaceId, harness_slug: this.harnessSlug };
    const rootA = mkRoot('shl-A-');
    const rootB = mkRoot('shl-B-');

    let handleA: BootedHarnessHandle | undefined;
    let handleB: BootedHarnessHandle | undefined;
    let applyA: ((op: OpEnvelope) => Promise<boolean>) | undefined;
    let applyB: ((op: OpEnvelope) => Promise<boolean>) | undefined;

    handleA = await bootHarnessSubstrate({
      workspaceRoot: rootA,
      workspaceId: this.workspaceId,
      harnessSlug: this.harnessSlug,
      swarmBinding: binding,
      swarmOverride: mkSwarm(),
      verifyBindingOverride: async (_pk, _login, userId) => (userId === idB.userId ? 'verified' : 'fail'),
      applyOverride: (op) => {
        applyA ??= buildCellApply(dbA.sql, handleA!.ownLog.keyHex, schemaOpts, this.extraProjections, hlcA);
        return applyA(op);
      },
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      announceIdentityOverride: idA.override,
      hlcClock: hlcA,
    });
    this.cleanups.push(async () => {
      await handleA?.close();
      await closeHarnessStore({ workspaceRoot: rootA, harnessSlug: this.harnessSlug });
    });

    handleB = await bootHarnessSubstrate({
      workspaceRoot: rootB,
      workspaceId: this.workspaceId,
      harnessSlug: this.harnessSlug,
      swarmBinding: binding,
      swarmOverride: mkSwarm(),
      verifyBindingOverride: async (_pk, _login, userId) => (userId === idA.userId ? 'verified' : 'fail'),
      applyOverride: (op) => {
        applyB ??= buildCellApply(dbB.sql, handleB!.ownLog.keyHex, schemaOpts, this.extraProjections);
        return applyB(op);
      },
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      announceIdentityOverride: idB.override,
    });
    this.cleanups.push(async () => {
      await handleB?.close();
      await closeHarnessStore({ workspaceRoot: rootB, harnessSlug: this.harnessSlug });
    });

    if (!handleA.swarm || !handleB.swarm || handleA.swarm.topicHex !== handleB.swarm.topicHex) {
      throw new Error('composition-rig: cells failed to join the same swarm topic');
    }

    // ── Hive-lease stores + the authority endpoint (cell a = argmin). ──
    // Election pubkeys are INJECTED (deterministic) — distinct from the
    // substrate's Ed25519 announce identities, exactly like claim-agent.
    const ELECT_A = 'aaaa-shl-authority-election-pubkey';
    const ELECT_B = 'mmmm-shl-peer-election-pubkey';
    const storeA = new InMemoryWorkItemClaimStore({ now: this.now });
    const storeB = new InMemoryWorkItemClaimStore({ now: this.now });

    const roster = [
      { pubkey: ELECT_A, uid: 4201, label: 'shl-cell-a' },
      { pubkey: ELECT_B, uid: 4202, label: 'shl-cell-b' },
    ];
    const presenceRows = async () =>
      roster.map((r) => ({
        device_pubkey: r.pubkey,
        github_user_id: r.uid,
        machine_label: r.label,
        last_seen_ms: this.frozenLastSeen.get(r.pubkey) ?? this.now(),
      }));
    const mkDeps = (selfPubkey: string, uid: number): LockAuthorityDeps => ({
      now: this.now,
      staleMs: this.staleMs,
      resolveSelf: async () => ({ githubUserId: uid, devicePubkey: selfPubkey }),
      fetchHivePresenceRows: presenceRows,
    });
    const depsA = mkDeps(ELECT_A, 4201);
    const depsB = mkDeps(ELECT_B, 4202);

    // The authority's RPC ops run against the AUTHORITY cell's store, with the
    // EI-284 caller-standing gate wired to the authority instance's revocation
    // view: claims carry the caller's ELECTION pubkey while revocation operates
    // on ANNOUNCE/device pubkeys, so the rig's checker bridges the domains via
    // its cell table + the revocations mirrored off cell A's handle.revoke
    // (production bridges the same way: holder_pubkey is the device pubkey, and
    // the default check reads contributors.revoked_pubkeys).
    __resetAuthorityOpsForTests();
    registerWorkItemClaimAuthorityOps(storeA.asCoordinator(), {
      isCallerRevoked: async (holderPubkey) => {
        const cells = Object.values(this.cells ?? {});
        const announce =
          cells.find((c) => c.electionPubkey === holderPubkey)?.announcePubkey ?? holderPubkey;
        return this.revokedByAuthority.has(announce);
      },
    });
    this.cleanups.push(() => __resetAuthorityOpsForTests());

    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        try {
          const env = JSON.parse(raw) as AuthorityRpcEnvelope;
          const result = await handleAuthorityRpc(env, {
            verifyIsAuthority: async (slug) => (await lockAuthorityForHive(slug, depsA)).isSelf,
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'handler_error', message: String(err) }));
        }
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    const port = (this.server.address() as { port: number }).port;
    this.serverUrl = `http://127.0.0.1:${port}`;
    this.cleanups.push(
      () =>
        new Promise<void>((r) => {
          // killAuthority() may already have closed + nulled the server — an
          // optional-chained close would never fire its callback (a hang).
          if (!this.server) return r();
          this.server.closeAllConnections?.();
          this.server.close(() => r());
          this.server = null;
        }),
    );

    // One process-global transport (the production seam): the authority's URL
    // for cell a's pubkey; a partition swaps in a fast-refusing address.
    setPeerRpcTransport(
      new HttpPeerRpcTransport({
        resolveAddress: (peer) => {
          if (this.partitioned) return 'http://127.0.0.1:9'; // discard port — refused fast
          return peer.devicePubkey === ELECT_A ? this.serverUrl : null;
        },
        timeoutMs: this.rpcTimeoutMs,
      }),
    );
    this.cleanups.push(() => {
      __resetPeerRpcTransportForTests();
      __resetRemotePeersCacheForTests();
    });
    this.cleanups.push(() => {
      _resetCacheForTests();
      _resetBootHistoryForTests();
      if (this.priorWorkspaceEnv === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
      else process.env.PAPERCUSP_WORKSPACE_ID = this.priorWorkspaceEnv;
    });

    // Mirror cell A's revocations into the authority's standing view (EI-284):
    // the test revokes via the substrate handle; the claim-op gate must see it.
    {
      const origRevoke = handleA.revoke.bind(handleA);
      handleA.revoke = async (devicePubkey: string) => {
        this.revokedByAuthority.add(devicePubkey);
        await origRevoke(devicePubkey);
      };
    }

    this.cells = {
      a: {
        name: 'a',
        electionPubkey: ELECT_A,
        announcePubkey: idA.devicePubkey,
        githubUserId: 4201,
        owner: 'shl-swarm-a',
        sql: dbA.sql,
        handle: handleA,
        store: storeA,
        deps: depsA,
        pipelineRuns: new Map(),
      },
      b: {
        name: 'b',
        electionPubkey: ELECT_B,
        announcePubkey: idB.devicePubkey,
        githubUserId: 4202,
        owner: 'shl-swarm-b',
        sql: dbB.sql,
        handle: handleB,
        store: storeB,
        deps: depsB,
        pipelineRuns: new Map(),
      },
    };
    // P-008/P-010 trust precondition (the gate landed in 674bd0fcd): each cell
    // ADMITS its peer Hive members' federated work. A remote row's author_pubkey
    // is the SENDING cell's own-log identity (`handle.ownLog.keyHex` — exactly
    // what log-snapshot stamps as op provenance, a hex log key, NOT the base64
    // announce device pubkey); the harness-features projection resolves it →
    // verified_author_github_user_id via a verified, non-revoked hive_members
    // device attestation, and the claim's trust leg (autoPickableWhereSql) then
    // admits it because that github id is in the local trust list. WITHOUT this,
    // autoPickableWhereSql CORRECTLY refuses cross-swarm work (remote +
    // un-admitted) and a peer's claim_next returns nothing — modeling a
    // legitimately-trusted shared Hive is the happy path's precondition.
    const allCells = [this.cells.a, this.cells.b];
    for (const self of allCells) {
      for (const peer of allCells) {
        if (peer === self) continue;
        const peerProvenancePubkey = peer.handle.ownLog.keyHex;
        await self.sql`
          INSERT INTO harness_shared.hive_members
            (workspace_id, github_user_id, binding_status, device_attestations, revoked_pubkeys)
          VALUES (${this.workspaceId}, ${peer.githubUserId}, 'verified',
                  ${JSON.stringify([{ device_pubkey: peerProvenancePubkey }])}::text::jsonb,
                  ARRAY[]::text[])
          ON CONFLICT (workspace_id, github_user_id) DO NOTHING`;
        await self.sql`
          INSERT INTO harness_shared.user_trust_list (workspace_id, trusted_github_user_id, created_ts)
          VALUES (${this.workspaceId}, ${peer.githubUserId}, ${this.now()})
          ON CONFLICT (workspace_id, trusted_github_user_id) DO NOTHING`;
      }
    }
    this.log(`rig up — topic ${handleA.swarm.topicHex.slice(0, 12)}…, authority ${this.serverUrl}`);
    return this;
  }

  async close(): Promise<void> {
    while (this.cleanups.length) {
      try {
        await this.cleanups.pop()!();
      } catch {
        /* best-effort — a thrown assertion must not leak a swarm/db/server */
      }
    }
  }

  // ── Chaos knobs ────────────────────────────────────────────────────────────

  /** The authority Swarm dies: its RPC endpoint closes and its presence FREEZES
   *  (so once `staleMs` passes — advance the clock — the survivor re-elects). */
  async killAuthority(): Promise<void> {
    this.authorityKilled = true;
    this.frozenLastSeen.set(this.cells.a.electionPubkey, this.now());
    this.server?.closeAllConnections?.();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
    this.log('authority (cell a) killed — endpoint closed, presence frozen');
  }

  /** Partition the swarms: authority RPC unreachable (fail-open path). The CDC
   *  convergence "pause" is modeled by simply not calling converge() while
   *  partitioned — merge/drain are rig-driven (mergePollMs 0). */
  setPartitioned(on: boolean): void {
    this.partitioned = on;
    __resetRemotePeersCacheForTests();
    this.log(on ? 'partitioned — authority RPC now refused' : 'partition healed');
  }

  get isAuthorityKilled(): boolean {
    return this.authorityKilled;
  }

  // ── The composition verbs ──────────────────────────────────────────────────

  /** Seed backlog items on a cell (status todo, origin local → they federate). */
  async seedBacklog(
    cell: SwarmCell,
    items: Array<{ id: string; title?: string; kind?: 'feature' | 'research-task' | 'chunk'; redundancy?: number }>,
  ): Promise<void> {
    const base = this.now();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      // Staggered created_ts — the claim path tiebreaks on created_ts ASC, so
      // seeded ties would make the no-steering claim order nondeterministic.
      const t = base + i;
      await cell.sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (workspace_id, harness_slug, feature_id, title, summary, status, attempts,
           item_kind, needs_human_review, ts, created_ts, updated_ts, redundancy)
        VALUES
          (${this.workspaceId}, ${this.harnessSlug}, ${it.id},
           ${it.title ?? `Item ${it.id}`}, ${'seeded by the composition rig'}, 'todo', 0,
           ${it.kind ?? 'feature'}, FALSE, ${t}, ${t}, ${t}, ${it.redundancy ?? null})
        ON CONFLICT (harness_slug, feature_id) DO NOTHING`;
    }
  }

  /** Acquire the per-Hive authority lease for one item from one cell — the
   *  REAL route (local when self is authority, RPC otherwise, fail-open on
   *  unreachability), each cell's local leg bound to ITS OWN store. */
  async acquireHiveLease(
    cell: SwarmCell,
    workItemId: string,
    opts: { owner?: string; ttlSec?: number; intent?: string } = {},
  ): Promise<{ via: ClaimNextOutcome['via']; value: AcquireResult }> {
    const payload: AcquireOpts = {
      workspaceId: this.workspaceId,
      harnessSlug: this.harnessSlug,
      workItemId,
      hiveSlug: this.hiveSlug,
      owner: opts.owner ?? cell.owner,
      ownerLabel: `shl-cell-${cell.name}`,
      holderPubkey: cell.electionPubkey,
      ttlSec: opts.ttlSec ?? this.claimTtlSec,
      intent: opts.intent ?? 'work-stealing claim (claim_next)',
    };
    const route = await routeToAuthorityForHive<AcquireResult>(
      this.hiveSlug,
      {
        local: () => cell.store.acquire(payload),
        remote: { kind: WORK_ITEM_CLAIM_OP_KINDS.acquire, payload, decode: (raw) => raw as AcquireResult },
      },
      cell.deps,
    );
    return { via: route.via, value: route.value };
  }

  /**
   * The production claim_next chain, flags-ON (D-003): the REAL
   * `claimNextWorkItem` (priority-ordered, affinity- and redundancy-aware
   * SKIP-LOCKED claim) on this cell's PG, then the per-Hive authority lease;
   * a lost lease releases the local claim (the loser's item returns to the
   * backlog) — byte-for-byte the work_items:claim_next tool's logic.
   */
  async claimNext(cell: SwarmCell): Promise<ClaimNextOutcome | null> {
    return this.runAsCell(cell, async () => {
      const wi = await claimNextWorkItem({
        harness: this.harnessSlug,
        assignee: cell.owner,
        swarmId: cell.electionPubkey,
        excludeRedundant: true,
      });
      if (!wi) return null;
      const lease = await this.acquireHiveLease(cell, wi.id);
      if (!lease.value.ok) {
        await releaseWorkItem(wi.id, { harness: this.harnessSlug });
        return { item: wi, via: lease.via, leased: false, claim: null };
      }
      return { item: wi, via: lease.via, leased: true, claim: lease.value.claim };
    });
  }

  /**
   * The FAKE pipeline — the DBOS featurePipelineWorkflow stand-in (zero LLM).
   * Per-cell idempotency on the real workflow-id shape (a re-run on the SAME
   * Swarm dedupes — DBOS dedup analog; a re-run on the OTHER Swarm does NOT —
   * idempotency keys are per-swarm, the P-004 edge). Writes one EXTERNAL
   * side-effect ledger row (non-federated, the duplication detector's input)
   * and flips the item's status on this cell's PG (origin re-stamped local by
   * the migration-214 trigger → the completion federates back).
   */
  async runFakePipeline(
    cell: SwarmCell,
    workItemId: string,
    opts: { epoch?: number; midRun?: () => Promise<void>; terminalStatus?: string } = {},
  ): Promise<FakePipelineResult> {
    const key = `pipeline:${this.harnessSlug}:${workItemId}:e${opts.epoch ?? 0}`;
    const prior = cell.pipelineRuns.get(key);
    if (prior) return { ...prior, deduped: true };

    const stamp = (status: string) => cell.sql`
      UPDATE harness_shared.harness_features_consolidated
         SET status = ${status}, updated_ts = ${this.now()}
       WHERE harness_slug = ${this.harnessSlug} AND feature_id = ${workItemId}`;

    await stamp('in-progress');
    await opts.midRun?.();
    // The EXTERNAL side effect — exactly once per (cell, item, epoch).
    await cell.sql`
      INSERT INTO harness_shared.rig_side_effects (work_item_id, executed_by, executed_at_ms, note)
      VALUES (${workItemId}, ${cell.name}, ${this.now()}, ${key})`;
    await stamp(opts.terminalStatus ?? 'passed');

    const result: FakePipelineResult = { ok: true, workItemId, executedBy: cell.name, deduped: false };
    cell.pipelineRuns.set(key, result);
    return result;
  }

  /**
   * The scripted Queen turn: read the federated backlog view from THIS cell's
   * PG, then steer with the REAL `setWorkItemPriority` (feature_order — the
   * exact column claim_next orders by). Returns the view it read (turn N+1's
   * view is the steering-monotonicity evidence).
   */
  async queenTurn(
    cell: SwarmCell,
    steer?: (view: BacklogRow[]) => Array<{ id: string; priority: number }>,
  ): Promise<{ view: BacklogRow[]; steered: Array<{ id: string; priority: number }> }> {
    const view = await this.readBacklog(cell);
    const steered = steer ? steer(view) : [];
    await this.runAsCell(cell, async () => {
      for (const s of steered) {
        const r = await setWorkItemPriority(s.id, s.priority, { harness: this.harnessSlug });
        if (!r || !r.applicable) throw new Error(`queenTurn: steering ${s.id} failed (${JSON.stringify(r)})`);
      }
    });
    return { view, steered };
  }

  /**
   * The Queen's CO-LOCATION lever (hive-coordination-model P-002): pin items
   * to swarms with the REAL `setWorkItemSwarmAffinity`. Under the lease flag,
   * claim_next SKIPS work affined to another swarm and PREFERS work affined
   * to the claimant — the production mechanism that makes concurrent
   * cross-swarm dispatch deterministic instead of a pure race.
   */
  async queenPinAffinity(cell: SwarmCell, pins: Array<{ id: string; swarmPubkey: string | null }>): Promise<void> {
    await this.runAsCell(cell, async () => {
      for (const p of pins) {
        const r = await setWorkItemSwarmAffinity(p.id, p.swarmPubkey, { harness: this.harnessSlug });
        if (!r) throw new Error(`queenPinAffinity: pinning ${p.id} failed`);
      }
    });
  }

  /**
   * Drive merge+drain to a HELD fixed point (the Stage-6 loop). `cells`
   * restricts which cells are driven — a killed swarm is modeled by simply
   * never driving it again (its replicated log stays readable to survivors).
   */
  async converge(opts: { maxPasses?: number; cells?: CellName[] } = {}): Promise<{ passes: number; fixedPoint: boolean }> {
    const max = opts.maxPasses ?? 12;
    const driven = (opts.cells ?? ['a', 'b']).map((n) => this.cells[n]);
    for (let pass = 1; pass <= max; pass++) {
      await Promise.all(driven.map((c) => c.handle.mergeNow()));
      const drains = await Promise.all(driven.map((c) => drainOutboxOnce(c.handle, c.sql)));
      if (drains.every((d) => d === 0)) {
        // Confirm the fixed point HOLDS across one more full cycle.
        await Promise.all(driven.map((c) => c.handle.mergeNow()));
        const again = await Promise.all(driven.map((c) => drainOutboxOnce(c.handle, c.sql)));
        if (again.every((d) => d === 0)) return { passes: pass, fixedPoint: true };
      }
      // Real swarm replication needs a beat between passes.
      await sleep(150);
    }
    return { passes: max, fixedPoint: false };
  }

  // ── Evidence readers ───────────────────────────────────────────────────────

  async readBacklog(cell: SwarmCell): Promise<BacklogRow[]> {
    return cell.sql<BacklogRow[]>`
      SELECT feature_id, status, taken_by, feature_order, item_kind, origin
        FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${this.harnessSlug}
       ORDER BY feature_id`;
  }

  async sideEffects(cell: SwarmCell): Promise<SideEffectRow[]> {
    return cell.sql<SideEffectRow[]>`
      SELECT work_item_id, executed_by, executed_at_ms
        FROM harness_shared.rig_side_effects
       ORDER BY executed_at_ms, work_item_id`;
  }

  async outboxDepth(cell: SwarmCell): Promise<number> {
    const rows = await cell.sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM harness_shared.substrate_outbox WHERE drained_at IS NULL`;
    return Number(rows[0]?.n ?? 0);
  }
}

/** Boot a fresh 2-swarm composition rig (call `close()` in afterEach). */
export async function bootCompositionRig(opts: CompositionRigOpts = {}): Promise<CompositionRig> {
  return new CompositionRig(opts).boot();
}
