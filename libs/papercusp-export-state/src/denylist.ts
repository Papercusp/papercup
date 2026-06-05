/**
 * §15.4 — filesystem denylist.
 *
 * Files matching any of these patterns are silently excluded from the
 * snapshot tarball. The list is split into:
 *
 *   1. `DEFAULT_DENY` — always excluded; no opt-in.
 *   2. `OPT_IN_INCLUDE` — excluded by default, but the user can include via
 *      capture options (subjects each one to a tier-B secret rescan).
 *
 * Patterns are matched against the path *relative to projectDir*, with
 * forward slashes only.
 */

export interface DenyMatcher {
  /** Forward-slash glob OR exact filename. Bare names match anywhere; with `/` matches the prefix-relative path. */
  pattern: string;
  /** Reason rendered in the manifest's `excluded[]`. */
  reason: string;
}

export const DEFAULT_DENY: DenyMatcher[] = [
  // Re-derivable build outputs
  { pattern: 'node_modules/', reason: 'denylist:re-derivable' },
  { pattern: '.next/', reason: 'denylist:re-derivable' },
  { pattern: 'dist/', reason: 'denylist:re-derivable' },
  { pattern: 'build/', reason: 'denylist:re-derivable' },
  { pattern: 'target/', reason: 'denylist:re-derivable' },
  { pattern: '.cache/', reason: 'denylist:re-derivable' },
  { pattern: '.turbo/', reason: 'denylist:re-derivable' },
  // Python build/test caches
  { pattern: '__pycache__/', reason: 'denylist:re-derivable' },
  { pattern: '.mypy_cache/', reason: 'denylist:re-derivable' },
  { pattern: '.pytest_cache/', reason: 'denylist:re-derivable' },
  { pattern: '.ruff_cache/', reason: 'denylist:re-derivable' },
  { pattern: '.tox/', reason: 'denylist:re-derivable' },
  { pattern: '.venv/', reason: 'denylist:re-derivable' },
  { pattern: 'venv/', reason: 'denylist:re-derivable' },
  // Test/automation residue
  { pattern: '.playwright-mcp/', reason: 'denylist:per-machine-ephemeral' },
  { pattern: 'test-results/', reason: 'denylist:re-derivable' },
  { pattern: 'playwright-report/', reason: 'denylist:re-derivable' },
  { pattern: 'coverage/', reason: 'denylist:re-derivable' },

  // Per-machine ephemeral
  { pattern: 'worktrees/', reason: 'denylist:per-machine-ephemeral' },
  { pattern: 'lanes.json', reason: 'denylist:per-machine-ephemeral' },
  { pattern: 'runs/', reason: 'denylist:per-machine-ephemeral' },

  // jco WASM transpile cache — regenerable per-plugin output (rev3 G+4).
  // Plugin work-dirs aren't in the harness tree today, but this entry
  // is defensive: if a plugin author accidentally puts an `_jco/` dir
  // somewhere in the harness tree, we still skip it. Real prevention
  // for plugin work-dirs is the default-strip rule when capture
  // eventually walks `~/.papercusp/plugins/<id>/_work/`.
  { pattern: '_jco/', reason: 'denylist:re-derivable' },

  // Snapshot-system reflexive paths — must be excluded or every capture
  // restages prior snapshots into the new one. Especially:
  //   .papercusp/snapshots/        previous snapshot tarballs (huge, multiplicative)
  //   .papercusp/snapshot-staging/ in-progress capture's own scratch dir
  //   .papercusp/logs/             agent_runs JSONL — derived; PG-canonical via harness_agent_runs
  //   .papercusp/pi-sessions/      local terminal state; not portable
  //   .papercusp/screenshots/      operator-captured PNGs; large + machine-local
  { pattern: '.papercusp/snapshots/', reason: 'denylist:reflexive-snapshot-output' },
  { pattern: '.papercusp/snapshot-staging/', reason: 'denylist:reflexive-snapshot-staging' },
  { pattern: '.papercusp/logs/', reason: 'denylist:re-derivable' },
  { pattern: '.papercusp/pi-sessions/', reason: 'denylist:per-machine-ephemeral' },
  { pattern: '.papercusp/screenshots/', reason: 'denylist:per-machine-ephemeral' },
  // Autonomous expert runtime state — per-run logs and dispatch locks.
  // Per-machine and rebuilt on the next dispatch; never useful to a
  // forker. The role definitions live in the harness package's
  // `prompts/` (which DOES ride). Manual chat-driven expert directories
  // `.papercusp/experts/EXP-NNN/` are NOT excluded — those carry authored
  // content (identity.json, SPEC.md, feedback rounds).
  { pattern: '.papercusp/experts/runs/', reason: 'denylist:per-machine-ephemeral' },
  { pattern: '.papercusp/expert-prompts/', reason: 'denylist:per-machine-ephemeral' },
  // Branch-action runtime state — per-run logs and metadata for the
  // /actions UI. Re-derivable on next run; not portable.
  { pattern: '.papercusp/action-runs/', reason: 'denylist:per-machine-ephemeral' },

  // Secrets — never
  { pattern: '.env', reason: 'denylist:secret' },
  { pattern: '.env.local', reason: 'denylist:secret' },
  { pattern: '.env.development', reason: 'denylist:secret' },
  { pattern: '.env.production', reason: 'denylist:secret' },
  { pattern: '.env.test', reason: 'denylist:secret' },
  { pattern: '*.pem', reason: 'denylist:secret' },
  { pattern: '*.key', reason: 'denylist:secret' },
  { pattern: '*.p12', reason: 'denylist:secret' },
  { pattern: '*.pfx', reason: 'denylist:secret' },
  { pattern: 'id_rsa', reason: 'denylist:secret' },
  { pattern: 'id_rsa.pub', reason: 'denylist:secret' },
  { pattern: 'id_ed25519', reason: 'denylist:secret' },
  { pattern: 'id_ed25519.pub', reason: 'denylist:secret' },

  // Substrate-machine secrets
  { pattern: '.papercusp/credentials.json', reason: 'denylist:substrate-secret' },
  { pattern: '.papercusp/publish-credentials.json', reason: 'denylist:substrate-secret' },
  { pattern: '.papercusp/marketplace-secrets.env', reason: 'denylist:substrate-secret' },

  // Git hooks — substrate may invoke; stripped even when .git/ is included
  { pattern: '.git/hooks/', reason: 'denylist:executable-hook' },

  // OS chrome
  { pattern: '.DS_Store', reason: 'denylist:os' },
  { pattern: 'Thumbs.db', reason: 'denylist:os' },
];

export const OPT_IN_INCLUDE: DenyMatcher[] = [
  { pattern: '.git/', reason: 'opt-in:git-history' },
  // agent_chats.transcript lives under `.papercusp/agent_chats/` typically
  { pattern: 'agent_chats.transcript', reason: 'opt-in:agent-transcripts' },
  { pattern: '.papercusp/notes/', reason: 'opt-in:operator-notes' },
];

/** Returns the matching DenyMatcher (or null) for a given relative path. */
export function matchDeny(
  relPath: string,
  list: DenyMatcher[],
): DenyMatcher | null {
  const norm = relPath.replace(/\\/g, '/');
  for (const m of list) {
    if (matches(norm, m.pattern)) return m;
  }
  return null;
}

function matches(path: string, pattern: string): boolean {
  // Directory pattern (ends with /) — match the directory itself AND
  // anything under it. The directory-itself match is essential: walk()
  // visits the dir entry first; if we don't return skip there, it'll
  // recurse into 100s of MB of node_modules even though every individual
  // file inside would later match. That makes saves take minutes.
  if (pattern.endsWith('/')) {
    const bare = pattern.slice(0, -1);          // 'node_modules' or '.papercusp/snapshots'
    // "Anchored" if pattern has internal '/' (a path-prefix shape).
    const isAnchored = bare.includes('/');
    if (isAnchored) {
      // '.papercusp/snapshots/' — match exact path-prefix only.
      return path === bare || path.startsWith(pattern);
    }
    // Bare name like 'node_modules/' — match anywhere in the tree, including
    // the directory itself when it's deep (apps/web/node_modules).
    return (
      path === bare ||
      path.startsWith(pattern) ||
      path.endsWith('/' + bare) ||
      path.includes('/' + pattern)
    );
  }
  // Exact match anywhere in the path
  if (!pattern.includes('*') && !pattern.includes('/')) {
    if (path === pattern) return true;
    if (path.endsWith('/' + pattern)) return true;
    return false;
  }
  // Path-prefix exact
  if (pattern.includes('/') && !pattern.includes('*')) {
    return path === pattern || path.startsWith(pattern + '/');
  }
  // Simple `*.ext` glob — just convert to suffix
  if (pattern.startsWith('*')) {
    const suffix = pattern.slice(1);
    return path.endsWith(suffix);
  }
  return false;
}

export interface CaptureOptions {
  /** Include `.git/`. Substrate runs git-filter-repo on a copy; never touches the real .git/. */
  includeGit?: boolean;
  /** Include agent transcripts (subject to a second-tier secret rescan). */
  includeAgentTranscripts?: boolean;
  /** Include operator notes. */
  includeOperatorNotes?: boolean;
}

/**
 * Returns the effective denylist given user capture options. Anything in
 * `OPT_IN_INCLUDE` that is NOT opted into stays in the deny list.
 */
export function effectiveDenylist(opts: CaptureOptions = {}): DenyMatcher[] {
  const out = [...DEFAULT_DENY];
  for (const m of OPT_IN_INCLUDE) {
    if (m.pattern === '.git/' && opts.includeGit) continue;
    if (m.pattern === 'agent_chats.transcript' && opts.includeAgentTranscripts) continue;
    if (m.pattern === '.papercusp/notes/' && opts.includeOperatorNotes) continue;
    out.push(m);
  }
  return out;
}
