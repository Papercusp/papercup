/**
 * join-hive — "Join the HIVE", not N harnesses
 * (hive-from-repo-hardening-2026-06-11 P-007 / D-007: joiner symmetry).
 *
 * Before this, joining a discovered hive ran the per-member-link join N times
 * and left the joiner with N loose harnesses — federation worked, but the hive
 * was a first-class entity ONLY on the creator's side (no grouping, no rail,
 * no strip). This composes:
 *
 *   1. the EXISTING per-link join (handleJoinLink — attestation, read-only
 *      clone, gist binding, federation boot, admission) for every member link;
 *   2. a LOCAL registry VIEW: a `kind:'hive'` entry flagged `remote_hive`
 *      (empty state dir under ~/.papercusp/remote-hives — no identity mint, no
 *      owned meta, never announces) + `hive_slug` stamped on each joined
 *      member, plus the member's upstream coords parsed from its join link —
 *      so the Harnesses tab's grouping/rail/strip work for the joiner, and the
 *      fork-PR context chain (P-013 of the parent plan) has registry coords;
 *   3. best-effort `system:git-sync` SEEDING for every joined member clone
 *      (git-sync-any-hive-2026-06-12 P-003): inactive + push:false joiner rows
 *      via B-01's seedGitSyncRoutineForMember — without this, shared hives only
 *      sync on the creator's machine. Never fails the join.
 *
 * Deliberately the SMALLEST model that fixes the asymmetry (D-007): a fuller
 * co-owned hive (shared identity, multi-writer listing) is out of scope.
 * Idempotent: re-joining updates the view + skips already-registered members.
 */

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join as joinPath } from 'node:path';

import {
  loadHarnessRegistry,
  mutateHarnessRegistry,
  type HarnessRegistry,
  type ProjectEntry,
} from '../harness-registry';
import { parseHarnessLink, type HarnessLink } from './url-scheme';
import {
  handleJoinLink,
  realJoinLinkDeps,
  type JoinLinkDeps,
} from '../endpoint-route/routes/harness/join-link';
import {
  seedGitSyncRoutineForMember,
  type SeedGitSyncRoutineOpts,
  type SeedGitSyncRoutineOutcome,
} from './git-sync/git-sync-routine';
import { insertHiveIfAbsent } from '../hive-store';

// ── Shapes ─────────────────────────────────────────────────────────────────────

export interface JoinHiveOpts {
  /** The discovered hive's id (becomes the local view slug, collision-suffixed). */
  hiveId: string;
  /** Display title (defaults to hiveId). */
  title?: string;
  /** The announce's full per-member join links. */
  memberLinks: string[];
  workspaceId: string;
}

export interface JoinedMember {
  slug: string;
  link: string;
  ok: boolean;
  /** 'joined' | 'already_registered' | the failure detail. Successful joins
   *  additionally carry the git-sync seed outcome appended as
   *  `; git_sync:<seeded|ineligible|routine_exists|error>` (B-03 P-003). */
  detail: string;
}

export interface JoinHiveResult {
  ok: boolean;
  /** The local view's slug (may be suffixed on collision). */
  hiveSlug?: string;
  members: JoinedMember[];
  error?: string;
}

export interface JoinHiveDeps {
  /** The per-link join (default: the real route core + its real deps). */
  joinLink?: (input: { slug: string; link: HarnessLink }) => Promise<{ ok: boolean; detail: string }>;
  loadRegistry?: typeof loadHarnessRegistry;
  mutateRegistry?: typeof mutateHarnessRegistry;
  /** mkdir -p for the view's empty state dir. */
  ensureDir?: (path: string) => Promise<void>;
  /** Root for remote-hive view dirs (default ~/.papercusp/remote-hives). */
  remoteHivesRoot?: string;
  /** Best-effort per-member git-sync routine seeding (git-sync-any-hive P-003;
   *  default B-01's seedGitSyncRoutineForMember). NEVER fails the join — every
   *  outcome folds into the member's `detail`. */
  seedGitSync?: (opts: SeedGitSyncRoutineOpts) => Promise<SeedGitSyncRoutineOutcome>;
  /** Resolve the discovered Hive's raw-32 base64 Ed25519 pubkey (default: the
   *  directory's listDiscoveredHives). EI-681: the joiner needs the OWNER's HIVE
   *  pubkey to re-key its joined harnesses onto the SAME federation topic the
   *  owner uses — a member-link carries only the topic HASH, not the pubkey. */
  resolveHivePubkey?: (workspaceId: string, hiveId: string) => Promise<string | null>;
  /** Get-or-create the remote Hive's identity row (default: insertHiveIfAbsent).
   *  Best-effort — a missing pubkey or a write failure NEVER fails the join. */
  upsertHiveIdentity?: (input: {
    workspaceId: string;
    homeSlug: string;
    pubkeyBase64: string;
    keychainId: string;
  }) => Promise<unknown>;
  /** Re-key a joined member's substrate IN PLACE so it re-resolves its swarm
   *  binding (default: boot-all's rekeyHarness, lazily imported). EI-681 step 2c
   *  — the per-member joins booted each substrate on the gh:<repo_id> topic
   *  BEFORE the Hive identity/hive_slug existed; re-keying after materialization
   *  moves them onto the OWNER's Hive-pubkey topic WITHOUT a reboot (a reboot
   *  breaks the owner's corestore serving of its own log). Never fails the join. */
  rekeyHarness?: (workspaceId: string, harnessSlug: string) => Promise<unknown>;
}

/** Resolve a discovered Hive's HIVE-identity pubkey from the local directory's
 *  discovered set (the announce carries it; the member-link only carries the
 *  topic hash). Returns null when absent — the caller skips the identity write. */
async function defaultResolveHivePubkey(
  _workspaceId: string,
  hiveId: string,
): Promise<string | null> {
  try {
    const { getHiveDirectory } = await import('../hive-directory-deps');
    const hives = await getHiveDirectory().listDiscoveredHives({ includeExpired: true });
    return hives.find((h) => h.hiveId === hiveId)?.hivePubkey ?? null;
  } catch {
    return null;
  }
}

async function defaultJoinLink(input: {
  slug: string;
  link: HarnessLink;
}): Promise<{ ok: boolean; detail: string }> {
  const res = await handleJoinLink(
    { slug: input.slug, link: input.link },
    realJoinLinkDeps as JoinLinkDeps,
  );
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (res.ok && body.ok) return { ok: true, detail: 'joined' };
  return { ok: false, detail: body.error ?? `HTTP ${res.status}` };
}

/** kebab slug from a repo name (matches the create path's derivation). */
function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-');
}

function freeSlug(base: string, taken: ReadonlySet<string>): string | null {
  for (let i = 0; i < 9; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

// ── The composition ────────────────────────────────────────────────────────────

export async function joinHiveAsView(
  opts: JoinHiveOpts,
  deps: JoinHiveDeps = {},
): Promise<JoinHiveResult> {
  const joinLink = deps.joinLink ?? defaultJoinLink;
  const loadRegistry = deps.loadRegistry ?? loadHarnessRegistry;
  const mutateRegistry = deps.mutateRegistry ?? mutateHarnessRegistry;
  const ensureDir = deps.ensureDir ?? (async (p: string) => void (await mkdir(p, { recursive: true })));
  const remoteHivesRoot =
    deps.remoteHivesRoot ?? joinPath(homedir(), '.papercusp', 'remote-hives');

  const links = opts.memberLinks.map((raw) => ({ raw, parsed: parseHarnessLink(raw) }));
  if (links.length === 0 || links.some((l) => !l.parsed)) {
    return { ok: false, members: [], error: 'invalid_member_links' };
  }

  const reg = await loadRegistry(opts.workspaceId);

  // The view slug: reuse an EXISTING remote view for this hive (idempotent
  // re-join); otherwise pick a free slug (a LOCAL harness owning the name is
  // never clobbered — suffix instead).
  const existingView = reg.projects.find(
    (p) => p.remote_hive === true && (p.slug === opts.hiveId || p.slug.startsWith(`${opts.hiveId}-`)),
  );
  const taken = new Set(reg.projects.map((p) => p.slug));
  const hiveSlug = existingView?.slug ?? freeSlug(kebab(opts.hiveId) || 'remote-hive', taken);
  if (!hiveSlug) {
    return { ok: false, members: [], error: 'view_slug_exhausted' };
  }

  // 1 — per-member joins (the existing path, unchanged mechanics). A member
  //     whose repo is already registered locally is skipped, not re-joined.
  const members: JoinedMember[] = [];
  const memberTaken = new Set(taken);
  for (const { raw, parsed } of links) {
    const link = parsed!;
    const already = reg.projects.find(
      (p) => typeof p.github_repository_id === 'number' && p.github_repository_id === link.repoId,
    );
    if (already) {
      members.push({ slug: already.slug, link: raw, ok: true, detail: 'already_registered' });
      continue;
    }
    const slug = freeSlug(kebab(link.repoName) || 'member', memberTaken);
    if (!slug) {
      members.push({ slug: '', link: raw, ok: false, detail: 'member_slug_exhausted' });
      continue;
    }
    memberTaken.add(slug);
    const res = await joinLink({ slug, link }).catch((e) => ({
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    }));
    members.push({ slug, link: raw, ok: res.ok, detail: res.detail });
  }

  const joinedAny = members.some((m) => m.ok);
  if (!joinedAny) {
    return { ok: false, members, error: 'no_member_joined' };
  }

  // 2 — materialize the registry VIEW: the remote home + hive_slug + upstream
  //     coords on every successfully-joined member (one atomic mutate).
  const viewPath = joinPath(remoteHivesRoot, hiveSlug);
  await ensureDir(viewPath).catch(() => {});
  const linkBySlug = new Map(
    members.filter((m) => m.ok).map((m) => [m.slug, links.find((l) => l.raw === m.link)?.parsed]),
  );
  // Post-mutate member entries (hive_slug + upstream coords stamped) — the
  // git-sync seeding below feeds these to the eligibility/seed composition.
  const memberEntries = new Map<string, ProjectEntry>();
  await mutateRegistry((cur: HarnessRegistry) => {
    const hasView = cur.projects.some((p) => p.slug === hiveSlug);
    const projects = cur.projects.map((p) => {
      const link = linkBySlug.get(p.slug);
      if (!link) return p;
      const next = {
        ...p,
        hive_slug: hiveSlug,
        // Upstream coords from the join link (the fork-PR context + future
        // member_repos derivation read these — P-002/P-013 of the parent plan).
        ...(p.github_remote
          ? {}
          : { github_remote: `https://github.com/${link.repoOwner}/${link.repoName}.git` }),
        ...(typeof p.github_repository_id === 'number'
          ? {}
          : { github_repository_id: link.repoId }),
      };
      memberEntries.set(next.slug, next);
      return next;
    });
    return {
      ...cur,
      projects: hasView
        ? projects
        : [
            ...projects,
            {
              slug: hiveSlug,
              path: viewPath,
              harness_kind: 'hive',
              remote_hive: true,
            },
          ],
    };
  }, opts.workspaceId);

  // 2b — EI-681: materialize the remote Hive's IDENTITY (the OWNER's HIVE pubkey)
  //      so the joiner re-keys its joined harnesses onto the SAME Hive-pubkey
  //      federation topic the owner uses. resolveHiveSwarmBinding needs
  //      getHiveBySlug(home) to resolve a pubkey for the remote view home;
  //      without this the joiner falls through to the gh:<repo_id> topic and the
  //      two peers sit on DIFFERENT topics → a write never federates. The
  //      member-link carries only the topic HASH, so the pubkey comes from the
  //      discovery announce. Best-effort: a missing pubkey or a write failure
  //      NEVER fails the join (the view + member joins already succeeded). The
  //      keychain_id is a NON-SIGNING placeholder — a joiner never signs or
  //      announces a Hive it does not own (this remote view "never announces",
  //      per the §2 contract above), so the keypair-less identity is correct.
  //      insertHiveIfAbsent is ON CONFLICT DO NOTHING, so a real OWNED identity
  //      for this slug (if one ever exists) always wins.
  const resolveHivePubkey = deps.resolveHivePubkey ?? defaultResolveHivePubkey;
  const upsertHiveIdentity =
    deps.upsertHiveIdentity ??
    ((input: { workspaceId: string; homeSlug: string; pubkeyBase64: string; keychainId: string }) =>
      insertHiveIfAbsent({ ...input, title: opts.title ?? opts.hiveId }));
  try {
    const pubkeyBase64 = await resolveHivePubkey(opts.workspaceId, opts.hiveId).catch(() => null);
    console.log(`[ei681-diag] join 2b: hiveId='${opts.hiveId}' hiveSlug(home)='${hiveSlug}' resolveHivePubkey=${pubkeyBase64 ? pubkeyBase64.slice(0, 12) + '…' : 'NULL'}`);
    if (pubkeyBase64) {
      await upsertHiveIdentity({
        workspaceId: opts.workspaceId,
        homeSlug: hiveSlug,
        pubkeyBase64,
        keychainId: `remote:${opts.hiveId}`,
      });
      console.log(`[ei681-diag] join 2b: wrote hives identity home='${hiveSlug}'`);
    }
  } catch (e) {
    console.log(`[ei681-diag] join 2b: identity write THREW: ${e instanceof Error ? e.message : e}`);
    /* identity-view write is best-effort; never fail the join over it */
  }

  // 2c — EI-681: re-key the joined members onto the Hive-pubkey topic. The
  //      per-member joins (step 1) booted each substrate BEFORE the hive_slug +
  //      Hive identity existed (steps 2/2b), so resolveSwarmBinding resolved the
  //      gh:<repo_id> topic and the member sat on a DIFFERENT topic than the
  //      owner's Hive-pubkey topic → a write never federated. Now that the view +
  //      identity are materialized, RE-KEY each joined member IN PLACE so it
  //      re-resolves onto the SAME Hive-pubkey topic the owner uses — in place
  //      (NOT a reboot), because a reboot breaks the owner's corestore serving of
  //      its own log core. Best-effort — a re-key failure must NEVER fail an
  //      otherwise-successful join.
  const rekeyHarness =
    deps.rekeyHarness ??
    (async (ws: string, slug: string) =>
      (await import('../sync/hyperbee/boot-all')).rekeyHarness(ws, slug));
  for (const m of members) {
    if (!m.ok || !m.slug) continue;
    console.log(`[ei681-diag] join 2c: re-keying member '${m.slug}' onto hive topic in place (hive_slug='${hiveSlug}')`);
    try {
      const result = await rekeyHarness(opts.workspaceId, m.slug);
      console.log(`[ei681-diag] join 2c: rekey('${m.slug}') result=${JSON.stringify(result)}`);
    } catch (e) {
      console.log(`[ei681-diag] join 2c: rekey('${m.slug}') THREW: ${e instanceof Error ? e.message : e}`);
      /* a re-key failure must NEVER fail an otherwise-successful join */
    }
  }

  // 3 — best-effort git-sync seeding per joined member clone (git-sync-any-hive
  //     P-003): joiner-side rows seed ACTIVE (D-008) + push:false (so a local
  //     commit+fetch+merge mirror only) via the seeder, non-clobber idempotent
  //     (re-join reports routine_exists), and the
  //     remote_hive VIEW is never a member here (eligibility would refuse it
  //     anyway). The cron jitter key is salted per-install — on a shared hive the
  //     same member slug exists on N peer boxes. A failure NEVER fails the join;
  //     the outcome lands in the member's `detail`.
  const seedGitSync = deps.seedGitSync ?? seedGitSyncRoutineForMember;
  for (const m of members) {
    if (!m.ok) continue;
    const entry = memberEntries.get(m.slug);
    if (!entry) continue;
    const outcome = await seedGitSync({
      workspaceId: opts.workspaceId,
      installSlug: m.slug,
      entry,
      joinerSide: true,
      cronKey: `${m.slug}:${opts.workspaceId}`,
    }).catch(
      (e): SeedGitSyncRoutineOutcome => ({
        seeded: false,
        reason: 'error',
        message: e instanceof Error ? e.message : String(e),
      }),
    );
    m.detail = `${m.detail}; git_sync:${outcome.seeded ? 'seeded' : outcome.reason}`;
  }

  return { ok: true, hiveSlug, members };
}
