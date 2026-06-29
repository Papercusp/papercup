/**
 * papercusp-hive-join — the JOIN-the-canonical-hive path for the dogfood bootstrap
 * (the cross-account pivot: an install JOINS the ONE canonical `papercusp` hive
 * rather than CREATING its own per-owner one — see
 * agent-insights/papercusp-shared-hive-per-owner).
 *
 * When the build bakes the canonical hive's INVITE (pubkey + invite secret — NEVER
 * a private key), `bootstrapPapercuspHive` calls `joinCanonicalPapercuspHive`
 * instead of the clone+create+Solution-C path:
 *   1. subscribe to the invite topic (so the owner's announce is ingested),
 *   2. bounded-wait for the owner's hive to actually announce (owner must be online),
 *   3. `joinHiveAsView` over the announced member-links — which read-only-clones each
 *      member repo (the CODE) AND re-keys the joined harnesses onto the owner's
 *      federation topic (so the owner's plans/work-items federate IN).
 *
 * Best-effort + non-fatal: no gh auth, an offline owner (no announce yet), or a
 * wiring failure all return a `skipped` result and the NEXT boot retries — exactly
 * like the clone path's auth_required handling, so a fresh launch is never broken.
 *
 * Admission: the joiner receives the owner's hive-scoped content only once the OWNER
 * admits it (the owner's allowlist policy / membership) — a one-time owner-side
 * setup, NOT something this path can do.
 */

import { resolveLocalGithubIdentity } from '../identity/resolve-local-github-identity';
import { PAPERCUSP_WORKSPACE_ID } from './papercusp-workspace';
import { PAPERCUSP_HIVE_SLUG } from './ensure-papercusp-hive';
import { AWAITING_GH_SIGNIN_DETAIL } from './bootstrap-papercusp-hive-detail';

/** The baked canonical-hive invite — pubkey + secret only (no private key). */
export interface CanonicalHiveInvite {
  /** Raw-32 Ed25519 PUBLIC key, base64 — the hive's federation-topic identity. */
  pubkeyBase64: string;
  /** Directory invite secret (hex) — the discovery topic for the owner's announce. */
  inviteSecret: string;
}

/**
 * Resolve the baked canonical invite from `--define`'d env (build-desktop-sidecar.sh
 * bakes PAPERCUP_DOGFOOD_HIVE_PUBKEY + PAPERCUP_DOGFOOD_HIVE_INVITE_SECRET, mirroring
 * PAPERCUP_DOGFOOD_REPO_REF). Returns null when unset (dev builds / the per-owner
 * fallback). `explicit` overrides for tests.
 */
export function bakedCanonicalHiveInvite(explicit?: CanonicalHiveInvite | null): CanonicalHiveInvite | null {
  if (explicit) return explicit;
  const pubkeyBase64 = process.env.PAPERCUP_DOGFOOD_HIVE_PUBKEY?.trim();
  const inviteSecret = process.env.PAPERCUP_DOGFOOD_HIVE_INVITE_SECRET?.trim();
  if (pubkeyBase64 && inviteSecret) return { pubkeyBase64, inviteSecret };
  return null;
}

export type JoinProgressStep = 'clone' | 'submodules';
export type JoinProgressStatus = 'running' | 'done' | 'error' | 'skipped';

export interface JoinCanonicalResult {
  state: 'joined' | 'skipped';
  slug: string | null;
  reason?: string;
}

/** Injectable seams (lib/ DI-for-tests). Production defaults to the real impls. */
export interface JoinCanonicalDeps {
  resolveGithub?: typeof resolveLocalGithubIdentity;
  /** Wire the hive directory transport + return the invite/announce seam. Default:
   *  hive-directory-boot ensureHiveDirectoryWired. */
  ensureWired?: (workspaceId: string) => Promise<{
    joinInviteTopic: (secret: string) => Promise<unknown>;
    confirmInviteAnnounce?: (secret: string, opts?: { timeoutMs?: number }) => Promise<{
      found?: boolean;
      peersOnTopic?: number;
      hive?: { hiveId?: string; memberLinks?: string[]; hivePubkey?: string } | null;
    } | null>;
  } | null>;
  /** List discovered hives (fallback memberLinks source if the confirm omits them).
   *  Default: hive-directory listDiscoveredHives. */
  listDiscovered?: () => Promise<Array<{ hiveId: string; hivePubkey?: string; memberLinks?: string[] }>>;
  /** The hive join. Default: harness/join-hive joinHiveAsView. */
  joinHive?: (opts: { hiveId: string; title?: string; memberLinks: string[]; workspaceId: string }) => Promise<{
    ok: boolean;
    hiveSlug?: string;
    error?: string;
  }>;
  setHomeWorkspace?: (ws: string) => void;
  record?: (step: JoinProgressStep, status: JoinProgressStatus, extra?: { percent?: number; detail?: string }) => void;
  /** confirmInviteAnnounce bounded-wait budget (ms). Default 25s. */
  confirmTimeoutMs?: number;
}

async function defaultEnsureWired(workspaceId: string) {
  const { ensureHiveDirectoryWired } = await import('../hive-directory-boot');
  return ensureHiveDirectoryWired(workspaceId) as ReturnType<NonNullable<JoinCanonicalDeps['ensureWired']>>;
}

async function defaultListDiscovered(): Promise<
  Array<{ hiveId: string; hivePubkey?: string; memberLinks?: string[] }>
> {
  const { getHiveDirectory } = await import('../hive-directory-deps');
  return getHiveDirectory().listDiscoveredHives({ includeExpired: true });
}

async function defaultJoinHive(opts: { hiveId: string; title?: string; memberLinks: string[]; workspaceId: string }) {
  const { joinHiveAsView } = await import('./join-hive');
  return joinHiveAsView(opts);
}

function defaultSetHome(ws: string): void {
  // Mirror bootstrap's defaultSetHomeWorkspace so the joined hive is the visible home.
  void (async () => {
    try {
      const { ensureWorkspaceEntry, writeRegistry } = await import('../workspace-registry');
      // REGISTER the workspace first (idempotent + provisions the dir), THEN make
      // it current. Setting `current` to an unlisted id left the registry in a
      // `current`-points-at-unknown state → unknown_workspace on git-identity save
      // + a greyed-out GitHub sign-in button on a fresh clean install. ensureWorkspaceEntry
      // re-reads + persists the entry; we mutate the returned registry to set current.
      const reg = ensureWorkspaceEntry(ws, 'Papercusp');
      if (reg.current !== ws) {
        reg.current = ws;
        writeRegistry(reg);
      }
    } catch {
      /* best-effort */
    }
  })();
}

/**
 * JOIN the canonical `papercusp` hive from its baked invite. Best-effort; the NEXT
 * boot retries on any skip (gh unauth / owner offline / no member-links yet).
 */
export async function joinCanonicalPapercuspHive(
  invite: CanonicalHiveInvite,
  deps: JoinCanonicalDeps = {},
): Promise<JoinCanonicalResult> {
  const resolveGithub = deps.resolveGithub ?? resolveLocalGithubIdentity;
  const ensureWired = deps.ensureWired ?? defaultEnsureWired;
  const listDiscovered = deps.listDiscovered ?? defaultListDiscovered;
  const joinHive = deps.joinHive ?? defaultJoinHive;
  const setHome = deps.setHomeWorkspace ?? defaultSetHome;
  const record = deps.record ?? (() => {});
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? 25_000;

  try {
    // 1. gh identity — the directory needs an announce identity to wire.
    const id = await resolveGithub();
    if (id.kind !== 'ok') {
      // No gh yet → park at 0% with the sign-in prompt (banner stays visible), retry.
      record('clone', 'running', { percent: 0, detail: AWAITING_GH_SIGNIN_DETAIL });
      return { state: 'skipped', slug: null, reason: 'join awaiting GitHub sign-in' };
    }

    // 2. Wire the directory + subscribe to the canonical invite topic.
    record('clone', 'running', { percent: 5, detail: 'connecting to the Papercusp hive' });
    const wiring = await ensureWired(PAPERCUSP_WORKSPACE_ID);
    if (!wiring) {
      record('clone', 'running', { percent: 0, detail: AWAITING_GH_SIGNIN_DETAIL });
      return { state: 'skipped', slug: null, reason: 'hive directory not wired (gh auth?)' };
    }
    await wiring.joinInviteTopic(invite.inviteSecret);

    // 3. Bounded-wait for the owner's hive to actually announce on the topic.
    const confirm = wiring.confirmInviteAnnounce
      ? await wiring.confirmInviteAnnounce(invite.inviteSecret, { timeoutMs: confirmTimeoutMs }).catch(() => null)
      : null;
    if (!confirm?.found) {
      record('clone', 'running', { percent: 10, detail: 'waiting for the Papercusp hive to come online' });
      return { state: 'skipped', slug: null, reason: 'canonical hive not announcing yet (owner offline)' };
    }

    // 4. Resolve the announced member-links (the per-member join targets).
    let memberLinks = confirm.hive?.memberLinks ?? [];
    let hiveId = confirm.hive?.hiveId ?? PAPERCUSP_HIVE_SLUG;
    if (memberLinks.length === 0) {
      const hives = await listDiscovered().catch(() => []);
      const match = hives.find((h) => h.hivePubkey === invite.pubkeyBase64) ?? hives.find((h) => h.hiveId === hiveId);
      if (match) {
        hiveId = match.hiveId;
        memberLinks = match.memberLinks ?? [];
      }
    }
    if (memberLinks.length === 0) {
      record('clone', 'running', { percent: 15, detail: 'Papercusp hive announced — waiting for member links' });
      return { state: 'skipped', slug: null, reason: 'announce has no member-links yet' };
    }

    // 5. JOIN — read-only-clones each member repo + re-keys onto the owner's topic.
    record('clone', 'running', { percent: 40, detail: 'joining + cloning the Papercusp hive' });
    const res = await joinHive({
      hiveId,
      title: 'Papercusp',
      // The canonical hive's identity == the baked pubkey (P-003 invariant); prefer the
      // announced pubkey when present. This keys the joiner's hives-row identity so the
      // P-005 fire-once latch (getHiveByPubkey on the baked pubkey) finds it next boot.
      hivePubkey: confirm.hive?.hivePubkey ?? invite.pubkeyBase64,
      memberLinks,
      workspaceId: PAPERCUSP_WORKSPACE_ID,
    });
    if (!res.ok) {
      record('clone', 'error', { detail: res.error ?? 'join failed' });
      return { state: 'skipped', slug: null, reason: `join failed: ${res.error ?? 'unknown'}` };
    }

    setHome(PAPERCUSP_WORKSPACE_ID);
    record('clone', 'done');
    // Member clones happen inside the join; mark the second phase terminal so the
    // setup-finish gate is satisfied (federation of the data is then ongoing).
    record('submodules', 'done');
    return { state: 'joined', slug: res.hiveSlug ?? hiveId };
  } catch (e) {
    record('clone', 'error', { detail: (e as Error)?.message?.slice(0, 120) ?? 'join error' });
    return { state: 'skipped', slug: null, reason: `join error: ${(e as Error)?.message ?? e}`.slice(0, 200) };
  }
}
