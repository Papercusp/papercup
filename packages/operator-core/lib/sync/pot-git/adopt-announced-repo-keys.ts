/**
 * pot-git/adopt-announced-repo-keys — adopt the POT OWNER's announced repoKey
 * for a locally-minted pot home (A3, EI-18788176839043286).
 *
 * WHY A SECOND PASS EXISTS AT ALL. `join-hive.ts` already adopts the owner's key
 * from the member join link, which covers every pot a device JOINED. It does not
 * cover a pot home this device minted ITSELF — and that is not an edge case: the
 * canonical `papercusp` pot is minted independently on EVERY install by
 * `ensure-papercusp-hive`, with no upstream coords, so it derives the bare slug.
 * The day the OTHER device's twin gains a GitHub binding, that device re-keys to
 * `gh-<id>` and the two silently stop talking — which is exactly the live
 * rig/tower split this whole work-item is about.
 *
 * WHY IT KEYS ON `homeRepoKey` AND NOT `memberRepos`/`memberLinks`. Those carry
 * the member's UPSTREAM GitHub coords, so a peer can only adopt from them if it
 * already holds the same coords to match on. The pot home is precisely the entry
 * that frequently has NONE (that is why it derives the bare slug in the first
 * place), so it can correlate against nothing — the correlation key and the
 * missing data are the same thing. `homeRepoKey` sidesteps it: the announce's
 * `hive_id` IS the correlator, so a device whose local pot home carries that slug
 * adopts directly.
 *
 * WHY OVERRIDING A PIN HERE IS SAFE. `adoptRepoKey` only overrides a pin stamped
 * `pot_repo_key_source: 'local'` (or an unstamped legacy pin, treated as local) —
 * a value this device GUESSED. A key already adopted from a peer is never
 * re-derived. That stamp is written by `pin-repo-keys.ts` for exactly this
 * reason, which is also why this pass must run AFTER it: the backfill writes the
 * guess down, this pass corrects it against the owner.
 *
 * ⚠ WHAT ADOPTION ALONE DOES NOT FIX. Re-keying makes this device ASK for the
 * right repo; it does not stop a peer from serving a SUPERSEDED store under the
 * old key. The live incident stayed invisible for 7 days precisely because the
 * abandoned `papercusp.git` kept answering fetches, so a fully-disconnected
 * joiner reported `ok:true`. Detection is tracked separately (a superseded store
 * must stop answering; bootstrap `ok:true` must mean "converged with the pot").
 *
 * Fail-soft by contract: this runs on the boot path and never throws — a failure
 * leaves keys exactly as they are and the next boot retries.
 */

import {
  loadHarnessRegistry,
  saveHarnessRegistry,
  type HarnessRegistry,
  type ProjectEntry,
} from '../../harness-registry';
import { adoptRepoKey } from './repo-identity';

/** The only shape this needs from a discovered hive (hive-directory.ts). */
export interface AnnouncedHomeKey {
  potId: string;
  /** Set when the announce is a LOCAL GUESS at the slug rather than the owner's
   *  authored one — never adopt from it (see DiscoveredHive.potIdSynthetic). */
  potIdSynthetic?: boolean;
  homeRepoKey?: string;
}

export interface AdoptAnnouncedRepoKeysDeps {
  loadRegistry?: (workspaceId?: string) => Promise<HarnessRegistry>;
  saveRegistry?: (reg: HarnessRegistry, workspaceId?: string) => Promise<unknown>;
  /** The verified discovered-hive set (default: the live directory's). */
  listAnnounced?: () => Promise<AnnouncedHomeKey[]> | AnnouncedHomeKey[];
}

export interface AdoptAnnouncedRepoKeysResult {
  /** Entries whose key changed to the owner's announced value. */
  adopted: { slug: string; from: string | undefined; to: string }[];
  /** Entries already carrying the announced key (or already peer-adopted). */
  unchanged: number;
  wrote: boolean;
  error?: string;
}

/**
 * A pot HOME this device owns locally — the only entries this pass touches. A
 * joiner-side VIEW (`remote_hive`) is excluded: it is materialized by join-hive,
 * which already adopts from the link, and it owns no store of its own.
 */
function isLocalPotHome(p: ProjectEntry): boolean {
  if (p.remote_hive === true) return false;
  return p.harness_kind === 'hive' || p.self_repo === true;
}

/**
 * Reconcile every locally-minted pot home in `workspaceId` against the owner's
 * announced `homeRepoKey`. Idempotent: once a key is adopted it is stamped
 * `'peer'` and a second pass changes nothing.
 */
export async function adoptAnnouncedRepoKeysForWorkspace(
  workspaceId: string,
  deps: AdoptAnnouncedRepoKeysDeps = {},
): Promise<AdoptAnnouncedRepoKeysResult> {
  const load = deps.loadRegistry ?? loadHarnessRegistry;
  const save = deps.saveRegistry ?? saveHarnessRegistry;
  try {
    const listAnnounced =
      deps.listAnnounced ??
      (async () => {
        // Lazily imported so this module stays usable without the directory (and
        // so a boot with none wired is a clean no-op, not a throw) — the same
        // lazy-`await import` seam hive-membership-store.ts uses for this.
        const { getHiveDirectory } = await import('../../hive-directory-deps');
        return getHiveDirectory().listDiscoveredHives({ includeExpired: true });
      });

    let announced: AnnouncedHomeKey[];
    try {
      announced = await listAnnounced();
    } catch {
      return { adopted: [], unchanged: 0, wrote: false };
    }

    // Only announces that actually carry a home key and a TRUSTWORTHY slug.
    const byPotId = new Map<string, string>();
    for (const h of announced) {
      if (!h.homeRepoKey || h.potIdSynthetic) continue;
      byPotId.set(h.potId, h.homeRepoKey);
    }
    if (byPotId.size === 0) return { adopted: [], unchanged: 0, wrote: false };

    const reg = await load(workspaceId);
    const adopted: { slug: string; from: string | undefined; to: string }[] = [];
    let unchanged = 0;

    for (const entry of reg.projects) {
      if (!isLocalPotHome(entry)) continue;
      const announcedKey = byPotId.get(entry.slug);
      if (!announcedKey) continue;

      const before = entry.pot_repo_key;
      const next = adoptRepoKey(entry, announcedKey);
      if (next.key === before && entry.pot_repo_key_source === next.source) {
        unchanged += 1;
        continue;
      }
      entry.pot_repo_key = next.key;
      entry.pot_repo_key_source = next.source;
      if (next.key === before) {
        unchanged += 1;
        continue;
      }
      adopted.push({ slug: entry.slug, from: before, to: next.key });
    }

    if (adopted.length === 0) {
      // A source-only restamp still needs persisting, but says nothing useful.
      if (unchanged > 0) await save(reg, workspaceId).catch(() => {});
      return { adopted, unchanged, wrote: false };
    }

    await save(reg, workspaceId);
    for (const a of adopted) {
      console.log(
        `[pot-git] ${a.slug}: adopted the pot owner's announced repoKey '${a.to}'` +
          `${a.from ? ` (was '${a.from}')` : ''} — this device was federating under a ` +
          `key no peer shares; its old bare store is abandoned and the repo will ` +
          `cold-join the pot under the new key (EI-18788176839043286).`,
      );
    }
    return { adopted, unchanged, wrote: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn(
      `[pot-git] workspace '${workspaceId}': announced-repoKey adoption failed (${error}) — ` +
        `keys are unchanged and the next boot retries.`,
    );
    return { adopted: [], unchanged: 0, wrote: false, error };
  }
}
