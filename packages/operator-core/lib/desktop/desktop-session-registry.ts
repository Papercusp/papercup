/**
 * desktop-session-registry — the cross-process DesktopSession inventory
 * (agent-virtual-desktops-2026-08-23 P-003 / WI-40829; D-004, D-005, D-006).
 *
 * READ D-004 BEFORE EXTENDING THIS. The registry is a durable PG RECORD of
 * desktop sessions PLUS the existing in-process handles — it is deliberately NOT
 * a relocation of live desktop state into Postgres:
 *
 *   PG row     = identity, kind, scope, owner, geometry, viewer binding,
 *                lifecycle timestamps, MEASURED host capability.
 *   In-process = the ChildProcess handles and the release() closure, which stay
 *                exactly where they are (desktop-lease.ts, display-allocator.ts).
 *
 * Both of those modules cite the storage policy's carve-out that a per-process
 * resource lease — a live child of THIS loop, which dies when the loop dies — is
 * legitimately non-PG. That reasoning is still correct and is preserved. What the
 * carve-out never covered is a cross-process, cross-machine INVENTORY: today
 * `computer:list_desktops` can only enumerate one process's Map, so a frame-slot
 * display or a VM guest desktop is invisible to it. That gap is what this closes.
 *
 * ⚠ THE ONE INVARIANT THAT MATTERS: a row without a live handle in its owning
 * process is DEAD. LIVENESS IS NEVER INFERRED FROM THE ROW ALONE — a row is a
 * claim about a process, not proof of one. `reconcileLocalDesktopSessions()` is
 * what makes that true again at operator start; see its own doc comment for why
 * it is scoped the way it is.
 *
 * Every function takes an optional `sql` so integration tests can pass a
 * per-file schema, and carries an explicit `workspace_id` predicate (RLS is the
 * backstop, not the guard) — the convention shared with hive-membership-store.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

export type DesktopKind = 'xvfb-local' | 'frame-slot' | 'vm-guest' | 'bwrap' | 'microvm';
export type DesktopScope = 'pot' | 'agent' | 'workspace';
export type DesktopState = 'provisioning' | 'ready' | 'idle' | 'frozen' | 'released' | 'dead';
export type DesktopViewerMode = 'none' | 'watch' | 'takeover';

/** States in which a session no longer holds its display. Mirrors the SQL CHECK
 *  and the partial-index predicate in migration 900 — see the drift guard in the
 *  registry's integration test, which pins these two definitions together. */
export const TERMINAL_DESKTOP_STATES: readonly DesktopState[] = ['released', 'dead'] as const;

export function isTerminalDesktopState(state: DesktopState): boolean {
  return TERMINAL_DESKTOP_STATES.includes(state);
}

/**
 * D-006: what the AGENT is served, independent of what the X server runs at.
 *
 * Claude meters an image at roughly (w*h)/750 tokens, so 1920x1080 (~2,765) costs
 * about 2.6x 1024x768 (~1,050) for every observation — and a computer-use loop
 * pays that per step, so it compounds. A frame legitimately RUNS at 1920x1080
 * because the human live view wants the real thing; serving those pixels to the
 * model as well is the accidental 2.6x this default exists to stop.
 */
export const DEFAULT_CAPTURE_GEOMETRY = { width: 1024, height: 768 } as const;

export interface DesktopCapabilities {
  gl?: boolean;
  wayland?: boolean;
  kvm?: boolean;
  a11y?: boolean;
}

export interface DesktopSessionRecord {
  id: string;
  workspaceId: string;
  harnessSlug: string | null;
  kind: DesktopKind;
  scope: DesktopScope;
  scopeRef: string;
  hostRef: string | null;
  ownerPid: number | null;
  ownerBootId: string | null;
  display: string;
  displayGeometry: { width: number; height: number; depth: number };
  captureGeometry: { width: number; height: number };
  state: DesktopState;
  leaseHolder: string | null;
  viewerMode: DesktopViewerMode;
  viewerActor: string | null;
  capabilities: DesktopCapabilities;
  ttlSec: number | null;
  createdAt: Date;
  lastActiveAt: Date;
  releasedAt: Date | null;
}

export interface RegisterDesktopSessionInput {
  workspaceId: string;
  harnessSlug?: string | null;
  kind: DesktopKind;
  scope: DesktopScope;
  scopeRef: string;
  display: string;
  displayGeometry: { width: number; height: number; depth?: number };
  /** Omit to take the D-006 default. Raise it deliberately when an agent
   *  genuinely needs the detail and is willing to pay the tokens. */
  captureGeometry?: { width: number; height: number };
  hostRef?: string | null;
  leaseHolder?: string | null;
  capabilities?: DesktopCapabilities;
  ttlSec?: number | null;
  /** Defaults to this process. Pass explicitly for a remote-owned session. */
  ownerPid?: number | null;
  ownerBootId?: string | null;
  id?: string;
}

function db(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

let cachedBootId: string | undefined;

/**
 * A per-BOOT identity, so a recycled pid cannot make a stale row alias a live
 * unrelated process. Pids wrap roughly daily on this box under fleet load, which
 * is frequent enough that pid-only ownership would mis-reconcile in practice
 * rather than in theory.
 */
export function currentBootId(): string {
  if (cachedBootId !== undefined) return cachedBootId;
  try {
    cachedBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    // Non-Linux or a locked-down /proc: fall back to a per-process id. That
    // degrades reconciliation to "this process only", which is SAFE — it never
    // reaps another process's row — rather than wrong.
    cachedBootId = `pid-${process.pid}-${Date.now()}`;
  }
  return cachedBootId;
}

export function _resetBootIdForTests(): void {
  cachedBootId = undefined;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toRecord(r: any): DesktopSessionRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug ?? null,
    kind: r.kind,
    scope: r.scope,
    scopeRef: r.scope_ref,
    hostRef: r.host_ref ?? null,
    ownerPid: r.owner_pid ?? null,
    ownerBootId: r.owner_boot_id ?? null,
    display: r.display,
    displayGeometry: {
      width: Number(r.display_width),
      height: Number(r.display_height),
      depth: Number(r.display_depth),
    },
    captureGeometry: { width: Number(r.capture_width), height: Number(r.capture_height) },
    state: r.state,
    leaseHolder: r.lease_holder ?? null,
    viewerMode: r.viewer_mode,
    viewerActor: r.viewer_actor ?? null,
    capabilities: (r.capabilities ?? {}) as DesktopCapabilities,
    ttlSec: r.ttl_sec ?? null,
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
    releasedAt: r.released_at ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Record a new desktop session. The row starts in `provisioning`: the caller
 * flips it to `ready` via `markDesktopReady` once the display actually answers
 * and its capabilities have been MEASURED. Registering as `ready` up front would
 * publish a session that nothing has yet proven works — exactly the blank-screen
 * class P-002 fixed.
 *
 * Uniqueness is enforced by the database, not here: a second live session for one
 * (workspace, scope, scope_ref), or a second live session on one host+display,
 * raises. Callers that legitimately race (ensureHiveDesktop) should coalesce
 * in-process AND treat the unique violation as "someone else won", not as a bug.
 */
export async function registerDesktopSession(
  input: RegisterDesktopSessionInput,
  sql?: Sql,
): Promise<DesktopSessionRecord> {
  const id = input.id ?? randomUUID();
  const capture = input.captureGeometry ?? DEFAULT_CAPTURE_GEOMETRY;
  const rows = await db(sql)`
    INSERT INTO harness_shared.desktop_sessions (
      id, workspace_id, harness_slug, kind, scope, scope_ref, host_ref,
      owner_pid, owner_boot_id, display,
      display_width, display_height, display_depth,
      capture_width, capture_height,
      state, lease_holder, capabilities, ttl_sec
    ) VALUES (
      ${id}, ${input.workspaceId}, ${input.harnessSlug ?? null}, ${input.kind},
      ${input.scope}, ${input.scopeRef}, ${input.hostRef ?? null},
      ${input.ownerPid ?? process.pid}, ${input.ownerBootId ?? currentBootId()},
      ${input.display},
      ${input.displayGeometry.width}, ${input.displayGeometry.height},
      ${input.displayGeometry.depth ?? 24},
      ${capture.width}, ${capture.height},
      'provisioning', ${input.leaseHolder ?? null},
      ${db(sql).json((input.capabilities ?? {}) as never)}, ${input.ttlSec ?? null}
    )
    RETURNING *`;
  return toRecord(rows[0]);
}

/**
 * Promote a provisioning session to `ready`, stamping the capabilities that were
 * MEASURED while standing it up (D-004: measured, never assumed — this is what
 * gates the microVM tier per D-001, and where P-002's GL ladder verdict lands so
 * every downstream consumer reads it instead of re-probing).
 */
export async function markDesktopReady(
  id: string,
  patch: { capabilities?: DesktopCapabilities; display?: string } = {},
  sql?: Sql,
): Promise<DesktopSessionRecord | undefined> {
  const client = db(sql);
  const rows = await client`
    UPDATE harness_shared.desktop_sessions
       SET state          = 'ready',
           last_active_at = now(),
           display        = COALESCE(${patch.display ?? null}, display),
           capabilities   = CASE
                              WHEN ${patch.capabilities ? 1 : 0} = 1
                                THEN ${client.json((patch.capabilities ?? {}) as never)}
                              ELSE capabilities
                            END
     WHERE id = ${id}
       AND state NOT IN ('released', 'dead')
    RETURNING *`;
  return rows[0] ? toRecord(rows[0]) : undefined;
}

/** Bump the activity clock — what an idle reaper and P-014 cost attribution read. */
export async function touchDesktopSession(id: string, sql?: Sql): Promise<void> {
  await db(sql)`
    UPDATE harness_shared.desktop_sessions
       SET last_active_at = now()
     WHERE id = ${id} AND state NOT IN ('released', 'dead')`;
}

/**
 * Mark a session terminal. `released` is an orderly teardown; `dead` is "the
 * owning process is gone". Both stamp released_at, which the SQL CHECK requires —
 * a terminal row without one would read as fresh to the reaper.
 *
 * Idempotent, and deliberately so: teardown races (pot:dissolve firing while an
 * operator shutdown sweeps) must not throw.
 */
export async function closeDesktopSession(
  id: string,
  state: 'released' | 'dead' = 'released',
  sql?: Sql,
): Promise<boolean> {
  const rows = await db(sql)`
    UPDATE harness_shared.desktop_sessions
       SET state = ${state}, released_at = now()
     WHERE id = ${id} AND state NOT IN ('released', 'dead')
    RETURNING id`;
  return rows.length > 0;
}

export interface ListDesktopSessionsFilter {
  workspaceId: string;
  harnessSlug?: string | null;
  scope?: DesktopScope;
  /** Include released/dead rows. Off by default: the common question is "what is
   *  live right now", and a terminal row answering it is the bug this guards. */
  includeTerminal?: boolean;
  limit?: number;
}

/**
 * Enumerate sessions for a tenant — EVERY kind, which is the point: this is what
 * lets `computer:list_desktops` see a frame slot or a VM guest that never existed
 * in the local process Map.
 */
export async function listDesktopSessions(
  filter: ListDesktopSessionsFilter,
  sql?: Sql,
): Promise<DesktopSessionRecord[]> {
  const client = db(sql);
  const rows = await client`
    SELECT * FROM harness_shared.desktop_sessions
     WHERE workspace_id = ${filter.workspaceId}
       ${filter.harnessSlug ? client`AND harness_slug = ${filter.harnessSlug}` : client``}
       ${filter.scope ? client`AND scope = ${filter.scope}` : client``}
       ${filter.includeTerminal ? client`` : client`AND state NOT IN ('released', 'dead')`}
     ORDER BY created_at DESC
     LIMIT ${Math.min(filter.limit ?? 200, 1000)}`;
  return rows.map(toRecord);
}

/**
 * The live session for one scope, or undefined. This is the resolver
 * capability:computer sits on: `scope:'pot'` keyed by the caller's harness slug
 * reproduces today's behaviour exactly, and `scope:'agent'` keyed by ownerId
 * reproduces the frame path's exclusivity.
 *
 * ⚠ Returns the RECORD, never a liveness verdict (D-004). A caller that needs a
 * drivable display must still hold — or resolve — the in-process handle.
 */
export async function resolveDesktopForScope(
  args: { workspaceId: string; scope: DesktopScope; scopeRef: string },
  sql?: Sql,
): Promise<DesktopSessionRecord | undefined> {
  const rows = await db(sql)`
    SELECT * FROM harness_shared.desktop_sessions
     WHERE workspace_id = ${args.workspaceId}
       AND scope        = ${args.scope}
       AND scope_ref    = ${args.scopeRef}
       AND state NOT IN ('released', 'dead')
     LIMIT 1`;
  return rows[0] ? toRecord(rows[0]) : undefined;
}

/**
 * Operator-start reconciliation (D-004). Marks DEAD every non-terminal LOCAL row
 * that this process cannot vouch for with a live handle.
 *
 * SCOPING, and why it is narrow on purpose. It reaps exactly two populations:
 *   1. rows stamped with a DIFFERENT boot id — the machine rebooted, so every
 *      local X server they describe is definitionally gone;
 *   2. rows stamped with THIS boot AND this pid, whose id is not in `liveIds` —
 *      this process owns them and knows it has no handle.
 *
 * It deliberately does NOT reap a row owned by a different pid on the same boot:
 * that may be a SIBLING operator process very much alive, and reaping its
 * sessions would tear down working desktops. Being narrow means a stale row can
 * survive until the next reboot; that is the safe direction of error, because the
 * cost of a surviving stale row is a misleading list entry, while the cost of an
 * over-eager reap is killing a peer's live desktop.
 *
 * Remote-owned rows (host_ref NOT NULL) are never touched here — their owner
 * reconciles them.
 */
export async function reconcileLocalDesktopSessions(
  args: { workspaceId: string; liveIds: readonly string[]; bootId?: string; pid?: number },
  sql?: Sql,
): Promise<{ reaped: number; reapedIds: string[] }> {
  const bootId = args.bootId ?? currentBootId();
  const pid = args.pid ?? process.pid;
  // An EMPTY array is the correct value here, not a sentinel: `NOT (id = ANY('{}'))`
  // is true for every row, which is exactly "this process vouches for nothing".
  // A `['']` placeholder instead raises `invalid input syntax for type uuid: ""`,
  // turning the most important reconciliation case (a process that came back
  // holding no handles) into a hard error. Caught by the reconciliation tests.
  const live = [...args.liveIds];
  const rows = await db(sql)`
    UPDATE harness_shared.desktop_sessions
       SET state = 'dead', released_at = now()
     WHERE workspace_id = ${args.workspaceId}
       AND host_ref IS NULL
       AND state NOT IN ('released', 'dead')
       AND (
             owner_boot_id IS DISTINCT FROM ${bootId}
             OR (owner_pid = ${pid} AND NOT (id = ANY(${live as string[]}::uuid[])))
           )
    RETURNING id`;
  return { reaped: rows.length, reapedIds: rows.map((r) => r.id as string) };
}
