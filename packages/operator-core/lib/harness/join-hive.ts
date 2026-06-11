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
 *      fork-PR context chain (P-013 of the parent plan) has registry coords.
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
} from '../harness-registry';
import { parseHarnessLink, type HarnessLink } from './url-scheme';
import {
  handleJoinLink,
  realJoinLinkDeps,
  type JoinLinkDeps,
} from '../endpoint-route/routes/harness/join-link';

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
  /** 'joined' | 'already_registered' | the failure detail. */
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
  await mutateRegistry((cur: HarnessRegistry) => {
    const hasView = cur.projects.some((p) => p.slug === hiveSlug);
    const projects = cur.projects.map((p) => {
      const link = linkBySlug.get(p.slug);
      if (!link) return p;
      return {
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

  return { ok: true, hiveSlug, members };
}
