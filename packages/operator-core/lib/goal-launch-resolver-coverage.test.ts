/**
 * GUARD — no spawn site composes a launch AROUND the per-goal launch resolver
 * (goal-mode-hardening-2026-08-10 P-004, D-009).
 *
 * D-004 deleted the GOAL contract's capacity preflight and told the goal agent to
 * parallelize as hard as it can. D-005 made that safe by replacing the agent's
 * judgement with two machine-enforced ceilings. That trade only holds if EVERY
 * door that starts an agent goes through the resolver — a single door that
 * composes its own launch is not a small gap, it is the ceiling silently not
 * existing, and the owner would discover it as a goal quietly running far more
 * agents than they capped it at.
 *
 * Nothing about that is visible when reading a new spawn site: the code looks
 * complete, the launch works, and the ceiling's absence has no symptom until it
 * is breached. So the invariant is asserted mechanically rather than left to
 * review.
 *
 * WHY IT SCANS operator-core ONLY: every psu launch door in the tree lives under
 * packages/operator-core/lib (verified by the census this test performs — see the
 * "finds the known doors" case, which fails if the population collapses). A guard
 * here therefore runs precisely when someone adds one, without depending on the
 * repo-wide guard registry, whose entries silently no-op when the named npm
 * script is absent.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const LIB_ROOT = join(__dirname);

/**
 * Doors that legitimately compose a launch WITHOUT the resolver. Each needs a
 * reason that says why goal ceilings cannot apply — not why wiring it would be
 * inconvenient.
 */
const ALLOWLIST: Record<string, string> = {
  'endpoint-route/routes/adv/launch-su.ts':
    'The GUI "new session" door. Its launcher is a human clicking a button, not an agent, so there is ' +
    'no owner id to resolve goal context FROM — resolveGoalLaunch would return null on every call and ' +
    'the wiring would be ceremony. A GUI launch is not associated with a goal until it inherits one at ' +
    'bootstrap (D-008), and it is bounded by the ceiling from that point on.',
  'p2p/delegated-spawn-honor.ts':
    'The HONORING side of a cross-machine spawn request. The goal, its settings and its ceilings live ' +
    'with the REQUESTER on another host, and are enforced there when its goal agent calls the launch ' +
    'tool. This host holds no goal row and no session_briefs row for that remote owner, so a second ' +
    'check here could only ever resolve null; what it does enforce locally is seat accounting (Gate 4.6).',
};

const COMPOSERS = /\b(buildAgentLaunchCommand|memberLaunchCommand)\s*\(/;
/** A hand-rolled psu argv: the launcher flags every psu command carries. */
const HAND_BUILT_ARGV = /--no-picker/;
const RESOLVER = /\bresolveGoalLaunch(ForGoal)?\b/;

/** agent-launch-core DEFINES the composers; it is the floor, not a door. */
const NOT_A_DOOR = new Set(['agent-launch-core.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Every file that composes a psu launch, as repo-lib-relative POSIX paths. */
function spawnSites(): string[] {
  const sites: string[] = [];
  for (const file of walk(LIB_ROOT)) {
    const rel = relative(LIB_ROOT, file).split(sep).join('/');
    if (NOT_A_DOOR.has(rel)) continue;
    const src = readFileSync(file, 'utf8');
    if (COMPOSERS.test(src) || HAND_BUILT_ARGV.test(src)) sites.push(rel);
  }
  return sites.sort();
}

describe('every spawn site goes through the per-goal launch resolver (P-004/D-009)', () => {
  const sites = spawnSites();

  it('finds the known launch doors — a detector that matches nothing passes vacuously', () => {
    // The load-bearing case. Every other assertion below is `for (site of sites)`,
    // so a walker that returns [] or a regex that stops matching would turn this
    // whole guard green while enforcing nothing. Twice in one day this session a
    // check answered the question asked while the truth was the opposite, both
    // times by testing for the ABSENCE of something instead of the presence of a
    // known-good population. So: pin the population.
    expect(sites).toEqual(
      expect.arrayContaining([
        'agent-tools/capability/launch-agent.ts',
        'agent-tools/fleet_registry/launch-on-plan.ts',
        'agent-tools/goals/start.ts',
        'harness/routines/fleet-headcount-action.ts',
      ]),
    );
    expect(sites.length).toBeGreaterThanOrEqual(5);
  });

  it('every spawn site calls the resolver, or is allowlisted with a reason', () => {
    const unwired = sites.filter((rel) => {
      if (rel in ALLOWLIST) return false;
      return !RESOLVER.test(readFileSync(join(LIB_ROOT, rel), 'utf8'));
    });
    expect(
      unwired,
      `These files compose a psu launch without going through resolveGoalLaunch, so a goal's ` +
        `maxAgents/maxPerFleet ceilings do NOT apply to the agents they start. Either call the ` +
        `resolver (see agent-tools/capability/launch-agent.ts for the shape), or add the file to ` +
        `ALLOWLIST in this test with a reason explaining why goal ceilings cannot apply to it.`,
    ).toEqual([]);
  });

  it('has no stale allowlist entries', () => {
    // An allowlisted file that no longer composes a launch means the allowlist is
    // carrying a reason nobody can check any more — and the next reader treats the
    // stale entry as precedent for adding another.
    const stale = Object.keys(ALLOWLIST).filter((rel) => !sites.includes(rel));
    expect(stale, 'allowlisted files that no longer compose a launch — drop them').toEqual([]);
  });

  it('every allowlist reason is substantive, not a placeholder', () => {
    for (const [rel, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length, `${rel} needs a real reason`).toBeGreaterThan(80);
      expect(reason, `${rel}: "TODO"/"for now" is not a reason`).not.toMatch(/TODO|for now|temporar/i);
    }
  });
});
