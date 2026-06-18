/**
 * git-sync-attribution — derive per-agent commit groups from the dirty file set +
 * a live path→agent attribution map (git-sync-dx-hardening-2026-06-17 P-004).
 *
 * DERIVED, never authored (the plan's hard constraint): the attribution map is built
 * by the caller from data agents ALREADY emit — coord:declare-intent `current_files`
 * + the file-lock holder — so agents stay 100% git-free. This module is PURE: no git,
 * no PG, just partitioning + commit-message shaping, so the grouping is unit-testable
 * in isolation. The caller (syncOneRepo) does the actual `git add`/`commit` + applies
 * git-sync's CI-skip marker; this only decides WHAT goes in each commit and WHY.
 */

/** Who a dirty file is attributed to (resolved by the caller from declare-intent / locks). */
export interface FileAttribution {
  /** Stable owner id — the grouping key + the Co-Authored-By identity. */
  agent: string;
  /** Human label for the trailer name (falls back to `agent`). */
  agentLabel?: string;
  /** The agent's declared intent — becomes the commit subject. */
  intent?: string;
  /** Co-Authored-By email (best-effort; a synthetic agents address if unknown). */
  email?: string;
}

/** One commit git-sync will make this tick. */
export interface AttributedCommitGroup {
  /** Owner id, or null for the catch-all (unattributable remainder). */
  agent: string | null;
  /** Repo-relative paths to `git add --` for this commit. */
  files: string[];
  /** Commit subject (the agent's intent, or the default for the catch-all). */
  subject: string;
  /** "Name <email>" for a Co-Authored-By trailer, or null (catch-all / unknown). */
  coAuthor: string | null;
}

/** The git-sync default subject (unchanged from today's single-commit message stem). */
export const DEFAULT_GIT_SYNC_SUBJECT = 'chore(git-sync): auto-commit';

/** Sanitize a free-text intent into a single-line commit subject (clamped). */
export function intentToSubject(intent: string | undefined, agentLabel: string | undefined): string {
  const line = (intent ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return DEFAULT_GIT_SYNC_SUBJECT;
  const who = agentLabel ? ` (${agentLabel.trim()})` : '';
  return `${line}${who}`.slice(0, 72);
}

/** "Name <email>" for a Co-Authored-By trailer (best-effort), or null when no identity. */
export function coAuthorTrailer(a: FileAttribution): string | null {
  const name = (a.agentLabel ?? a.agent ?? '').trim();
  if (!name) return null;
  const email = (a.email ?? `${a.agent}@agents.papercusp`).trim();
  return `${name} <${email}>`;
}

/**
 * Partition `dirtyFiles` into per-agent commit groups + a catch-all remainder.
 *
 * - Files present in `attribution` group under their agent; the rest fall to the
 *   catch-all (agent=null) — exactly what gets committed as a single lump today.
 * - Deterministic: agent groups sorted by id, files sorted within each, catch-all LAST.
 * - The catch-all group is ALWAYS appended (even with zero files — the caller skips an
 *   empty `git add`), so the unattributable remainder is committed just as today.
 *
 * When `attribution` is empty, the only group is the catch-all over ALL dirty files —
 * i.e. the flag-OFF / no-data behavior degrades to today's single commit.
 */
export function groupFilesForAttribution(
  dirtyFiles: string[],
  attribution: Map<string, FileAttribution>,
  opts: { defaultSubject?: string } = {},
): AttributedCommitGroup[] {
  const defaultSubject = opts.defaultSubject ?? DEFAULT_GIT_SYNC_SUBJECT;
  const byAgent = new Map<string, { attr: FileAttribution; files: string[] }>();
  const remainder: string[] = [];
  for (const f of dirtyFiles) {
    const a = attribution.get(f);
    if (!a) {
      remainder.push(f);
      continue;
    }
    let g = byAgent.get(a.agent);
    if (!g) {
      g = { attr: a, files: [] };
      byAgent.set(a.agent, g);
    }
    g.files.push(f);
  }
  const groups: AttributedCommitGroup[] = [...byAgent.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agent, g]) => ({
      agent,
      files: g.files.slice().sort(),
      subject: intentToSubject(g.attr.intent, g.attr.agentLabel),
      coAuthor: coAuthorTrailer(g.attr),
    }));
  groups.push({ agent: null, files: remainder.slice().sort(), subject: defaultSubject, coAuthor: null });
  return groups;
}

/**
 * Derive a per-repo attribution map from the live presence roster + this repo's path.
 *
 * Presence `current_files` are workspace-root-relative (superproject paths). For the
 * SUPERPROJECT (`repoRelPrefix=''`) they match the dirty paths directly; for a SUBMODULE
 * we strip the submodule prefix so they match the submodule-relative dirty paths (the
 * pathspec mismatch the audits flagged). Files outside this repo are dropped. When two
 * agents claim the same path (rare — file locks serialize edits), first-declared wins
 * (stable by the input order the caller passes).
 */
/** One active agent's declared work, as the caller resolves it from presence/declare-intent. */
export interface AttributionRosterEntry {
  agent: string;
  agentLabel?: string;
  intent?: string;
  email?: string;
  /** Workspace-root-relative paths the agent is working on (coord:declare-intent current_files). */
  files: string[];
}

export function attributionMapForRepo(
  roster: AttributionRosterEntry[],
  repoRelPrefix: string,
): Map<string, FileAttribution> {
  const prefix = repoRelPrefix ? repoRelPrefix.replace(/\/?$/, '/') : '';
  const map = new Map<string, FileAttribution>();
  for (const a of roster) {
    for (const raw of a.files ?? []) {
      const f = raw.replace(/^\.?\//, '');
      let rel: string | null;
      if (!prefix) {
        // Superproject: keep the path as-is. A submodule's INNER file (libs/x/foo.ts) simply
        // won't match the superproject's gitlink-level dirty paths (which see `libs/x` modified,
        // not its contents), so it harmlessly fails to attribute here — no need to pre-drop it.
        rel = f;
      } else if (f.startsWith(prefix)) {
        rel = f.slice(prefix.length);
      } else {
        rel = null;
      }
      if (rel == null || rel === '') continue;
      if (!map.has(rel)) {
        map.set(rel, { agent: a.agent, agentLabel: a.agentLabel, intent: a.intent, email: a.email });
      }
    }
  }
  return map;
}
