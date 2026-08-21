/**
 * claim-door-census.test.ts — the set of CLAIM DOORS, asserted as an exact list, each
 * classified by whether it enforces dependency blocking and why.
 *
 * Plan: dependency-subsystem-thorough-testing-2026-08-02 (P-009).
 * @covers INV-06
 *
 * WHY THIS EXISTS. INV-06 says "EVERY claim entry point applies the SAME blocking verdict —
 * there is no door through which a blocked item can be claimed", and its own
 * violationLooksLike names the real problem: "The audit that proves this is point-in-time and
 * rots the moment someone adds a door." The predecessor plan's P-012 audit was exactly that
 * snapshot. blocking-floor-single-source.test.ts then made the FLOOR non-rotting (one
 * definition per family, every self-select door calls it) — but it checks the doors it names,
 * so a NEW door that never calls the helper is invisible to it. This file closes that: the
 * ENUMERATION is asserted, so a new door fails the suite by construction.
 *
 * ⚠⚠ THE TRAP THIS FILE MUST NOT FALL INTO — D-008. "Every door agrees" is NOT "every door
 * blocks". Readiness floors (terminal-state, cooldown, claim-hold, needs-human,
 * dependency-blocking) gate opportunistic SELF-SELECTION only. The by-id claim
 * (claimWorkItem / claimIssue) deliberately does NOT enforce them: taking a blocked or
 * finished item BY NAME is how an operator reopens it, inherits ownership, or attaches
 * follow-up work (a tested escape hatch, EI-8972). So the classification below is
 * three-valued, and `by-id-ungated` is a CORRECT answer, not a gap. A census that demanded
 * every door gate would encode the wrong invariant and fail working code — which is worse
 * than no census, because someone would then "fix" the code to satisfy it.
 *
 * Static: no database, milliseconds, and it fails on the arrival of a door rather than on the
 * next incident. The behavioural half — one seeded row put to every door, all verdicts
 * compared — is cross-door-agreement.integration.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const LIB_ROOT = resolve(__dirname, '..');

/**
 * What a door is, mechanically: an EXPORTED function whose name reads as claiming or serving
 * work (`claimX` / `claimNextX` / `getNextX`), in a module that actually reads the work-item
 * relations. Both halves matter — the name alone sweeps in every unrelated lease-claim on the
 * box (claimVoiceLease, claimFleetLaunchSlot, claimDueRoutine, claimReaction …), and the
 * relations alone sweep in every reader. Together they select 12 functions across 6 files,
 * which is small enough to classify by hand and specific enough to notice a new one.
 */
const DOOR_NAME = /export\s+(?:async\s+)?function\s+((?:claimNext|getNext|claim)[A-Z]\w*)/g;
const WORK_ITEM_RELATIONS = /harness_shared\.(work_items|harness_features_consolidated|engineer_issues)/;

type DoorClass =
  /** A self-select door: it CHOOSES which item to hand out, so readiness floors apply. */
  | 'self-select-gating'
  /** A by-id claim: the deliberate operator override (D-008 / EI-8972). MUST NOT gate. */
  | 'by-id-ungated'
  /** Builds a floor fragment for others to apply; serves nothing itself. */
  | 'floor-builder'
  /** Matches the name shape but claims a lease/slot, not a work-item. */
  | 'not-a-work-item-door';

interface DoorEntry {
  klass: DoorClass;
  /** For a gating door: what proves it gates. For an ungated one: why that is correct. */
  note: string;
}

/**
 * Every claim door, classified.
 *
 * Adding an export that matches the shape above forces an entry here — which forces the
 * question "does this door apply the blocking floor, and what proves it?" at the moment the
 * door is written. That question, asked late, is D-007: `ok_no_blocker` in get-next.ts was
 * the one floor in its subquery not calling a shared helper, drifted for months, and made the
 * claimability PREVIEW disagree with the claim door — 0 blocked reported against the real 5.
 */
const CLAIM_DOORS: ReadonlyMap<string, DoorEntry> = new Map([
  // ---- self-select doors: these MUST gate ---------------------------------
  [
    'work-items.ts#claimNextWorkItem',
    {
      klass: 'self-select-gating',
      note:
        'FEATURE-family self-select. Applies claimFloorsWhereSql. Behavioural proof: ' +
        'claim-respects-blocking.integration.test.ts (both flag arms) + the agreement table ' +
        'in cross-door-agreement.integration.test.ts.',
    },
  ],
  [
    'work-items.ts#claimNextIssueWorkItem',
    {
      klass: 'self-select-gating',
      note:
        'ISSUE-family self-select. Applies depsBlockedExclusionSql (the bare-ref floor). ' +
        'Behavioural proof: the agreement table, where it is compared against the PREVIEW ' +
        'door reading the same row — the pair D-007 found disagreeing.',
    },
  ],
  [
    'scheduler/get-next.ts#getNextWorkItem',
    {
      klass: 'self-select-gating',
      note:
        'The scheduler door. Applies claimFloorsWhereSql (feature) and depsBlockedExclusionSql ' +
        "(issue, the `ok_no_blocker` leg). Reached in tests via getNextForBee; both legs' " +
        'helper calls are asserted in blocking-floor-single-source.test.ts.',
    },
  ],
  [
    'scheduler/get-next.ts#getNextWorkItemDefault',
    {
      klass: 'self-select-gating',
      note:
        'Thin default-options wrapper over getNextWorkItem — it adds no floor of its own and ' +
        'cannot skip one. Covered by that door; asserted below to stay a wrapper.',
    },
  ],
  [
    'scheduler/claim-spec-store.ts#getNextForBee',
    {
      klass: 'self-select-gating',
      note:
        'The spec-driven entry point the live scheduler actually calls (getClaimSpec → ' +
        'getNextWorkItem). Driven directly by claim-respects-blocking.integration.test.ts ' +
        "as one of its two paths, incl. the 3-deep and 6-deep chains.",
    },
  ],
  [
    'harness/improvements/agent-review.ts#claimNextAgentReview',
    {
      klass: 'self-select-gating',
      note:
        'ISSUE-family reviewer self-select. Applies depsBlockedExclusionSql before the ' +
        'agentReview=pending lane predicate, so review routing cannot bypass an unresolved ' +
        'dependency. The helper call is asserted below and the helper itself is covered by ' +
        'blocking-floor-single-source.test.ts plus the cross-door agreement suite.',
    },
  ],

  // ---- by-id doors: these MUST NOT gate (D-008) ---------------------------
  [
    'work-items.ts#claimWorkItem',
    {
      klass: 'by-id-ungated',
      note:
        'FEATURE-family by-id claim — the deliberate operator override (EI-8972). Enforces the ' +
        'SECURITY/admission floor (autoPickableWhereSql), which holds at every door, and NOT ' +
        'readiness. Taking a blocked item by name is how you reopen it or attach follow-up ' +
        'work. Asserted as a boundary in blocking-floor-single-source.test.ts and ' +
        'behaviourally in the agreement table.',
    },
  ],
  [
    'issues-engineer.ts#claimIssue',
    {
      klass: 'by-id-ungated',
      note:
        'The ISSUE-family by-id analogue of claimWorkItem, and ungated for the same D-008 ' +
        'reason. Enumerated explicitly so nobody "fixes" the asymmetry between the two ' +
        'families by adding a readiness floor to one of them.',
    },
  ],

  // ---- floor builders: they serve nothing ---------------------------------
  [
    'work-items.ts#claimFloorsWhereSql',
    {
      klass: 'floor-builder',
      note:
        'THE feature-family floor fragment (the canonical definition, per ' +
        'blocking-floor-single-source.test.ts). A builder, not a door: it returns SQL and ' +
        'claims nothing.',
    },
  ],
  [
    'work-items.ts#claimHoldExclusionSql',
    {
      klass: 'floor-builder',
      note: 'The _claimHold fragment shared across families. Same reason: returns SQL, serves nothing.',
    },
  ],

  // ---- name-shaped, but not work-item doors -------------------------------
  [
    'pot/watchdog.ts#claimWatchdogFire',
    {
      klass: 'not-a-work-item-door',
      note:
        'Claims a WATCHDOG FIRE lease (a scheduling turn), not a work-item. The module reads ' +
        'work_items for its sweep, which is why the scan sees it.',
    },
  ],
  [
    'work-item-redundancy.ts#claimReplicaSlot',
    {
      klass: 'not-a-work-item-door',
      note:
        'Claims a REPLICA SLOT on an item already selected by a real door upstream — it does ' +
        'not choose what to serve, so readiness floors are not its concern.',
    },
  ],
  [
    'work-item-redundancy.ts#claimReplicaSlotLocal',
    { klass: 'not-a-work-item-door', note: 'The local-only variant of claimReplicaSlot; same reasoning.' },
  ],
  [
    'coord/condition-bridge.ts#claimConditionKey',
    {
      klass: 'not-a-work-item-door',
      note:
        'Claims a CONDITION KEY onto a work-item row that ALREADY exists — the dedup identity that ' +
        'lets a recurring condition update one row instead of minting a new one per observation. It ' +
        'takes a key, not an item, and selects nothing to serve, so readiness floors are not its ' +
        'concern. The scan sees it because it writes work_items and matches the name shape.',
    },
  ],
  [
    'coord/condition-object.ts#claimStateOf',
    {
      klass: 'not-a-work-item-door',
      note:
        'PURE derivation, not a door at all: it REPORTS the claim state of one already-linked row ' +
        '(its own docstring says "PURE"). It takes nothing, writes nothing, and serves nothing — the ' +
        'scan matches it on the claim* name shape alone.',
    },
  ],
  [
    'events/await/store.ts#claimSpecificOnceAwaits',
    {
      klass: 'not-a-work-item-door',
      note:
        'Claims selected event_awaits rows for exactly-once wake delivery. The file also reads ' +
        'work_items for verified-wait ownership, which enrolls the module in this census, but this ' +
        'function updates only event_awaits and never selects or assigns a work item.',
    },
  ],
  [
    'events/await/store.ts#claimDueDeliveries',
    {
      klass: 'not-a-work-item-door',
      note:
        'Claims due event_wake_deliveries rows for the wake pump with SKIP LOCKED. It leases delivery ' +
        'attempts, not work items; the module-level work_items read belongs to a separate verified-wait ' +
        'ownership query and is why the mechanical scan sees this function.',
    },
  ],
  [
    'events/await/store.ts#claimDueVerifiedAwaits',
    {
      klass: 'not-a-work-item-door',
      note:
        'Claims expired verified event_awaits rows for producer-health reconciliation. It changes the ' +
        'verifier lease on an await and serves no work item; an unrelated work_items query elsewhere in ' +
        'store.ts is the only reason this name-shaped function enters the census.',
    },
  ],
]);

const SCAN_SKIP_DIRS = new Set(['__tests__', 'node_modules', 'dist']);

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (SCAN_SKIP_DIRS.has(entry)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.integration.test.ts')) continue;
    out.push(full);
  }
  return out;
}

function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('--') || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

const relLib = (file: string) => relative(LIB_ROOT, file).split(sep).join('/');

/** Every `<relpath>#<exportName>` in the tree that matches the door shape. */
function discoverDoors(): string[] {
  const found: string[] = [];
  for (const file of collectSourceFiles(LIB_ROOT)) {
    const code = withoutComments(readFileSync(file, 'utf8'));
    if (!WORK_ITEM_RELATIONS.test(code)) continue;
    for (const m of code.matchAll(DOOR_NAME)) found.push(`${relLib(file)}#${m[1]}`);
  }
  return found.sort();
}

const DISCOVERED = discoverDoors();

describe('claim doors are an enumerated set (P-009)', () => {
  it('the scan finds doors at all (an empty discovery would satisfy every assertion below)', () => {
    // The INV-12 discipline applied to the census: a detector that never fires reports a
    // clean bill of health forever. 12 is the count at the time of writing; the assertion is
    // deliberately a floor, not an equality, so adding a door fails the ENUMERATION check
    // below (which names it) rather than this one (which would not).
    expect(DISCOVERED.length).toBeGreaterThanOrEqual(10);
  });

  it('every discovered door is CLASSIFIED — a new door fails here by construction', () => {
    const unclassified = DISCOVERED.filter((d) => !CLAIM_DOORS.has(d));
    expect(
      unclassified,
      'These exported functions look like claim doors but carry no classification, so nothing ' +
        'states whether they enforce dependency blocking. This is the assertion INV-06 needs ' +
        'and a point-in-time audit cannot give: the predecessor P-012 audit was a snapshot and ' +
        'rotted. Add an entry to CLAIM_DOORS — self-select-gating (and name what proves it ' +
        'gates), by-id-ungated (D-008: readiness floors are self-select only), floor-builder, ' +
        'or not-a-work-item-door.',
    ).toEqual([]);
  });

  it('every classified door still exists (a stale entry cannot inflate the enumeration)', () => {
    const discovered = new Set(DISCOVERED);
    const stale = [...CLAIM_DOORS.keys()].filter((d) => !discovered.has(d));
    expect(stale, 'CLAIM_DOORS entries that no longer match a live export.').toEqual([]);
  });

  it('every entry carries a real reason (an unexplained classification is not a classification)', () => {
    const thin = [...CLAIM_DOORS.entries()].filter(([, e]) => e.note.trim().length < 40).map(([d]) => d);
    expect(thin).toEqual([]);
  });

  it('at least one door of each LOAD-BEARING class exists (a mis-tuned scan cannot empty a class)', () => {
    // If a future refactor made the scan miss, say, every self-select door, the enumeration
    // check above would still pass — nothing unclassified was found. This asserts the classes
    // that must be non-empty for the census to mean anything.
    const byClass = (k: DoorClass) => [...CLAIM_DOORS.values()].filter((e) => e.klass === k).length;
    expect(byClass('self-select-gating')).toBeGreaterThanOrEqual(3);
    expect(byClass('by-id-ungated')).toBeGreaterThanOrEqual(2); // both families
  });
});

describe('the two structural claims the classification rests on', () => {
  const read = (rel: string) => readFileSync(join(LIB_ROOT, rel), 'utf8');

  it('getNextWorkItemDefault is a WRAPPER — it adds no floor and can skip none', () => {
    // Its entry is justified by "covered by getNextWorkItem". That is a claim about the code,
    // so it is asserted rather than trusted: a wrapper that grew its own query would need its
    // own proof.
    const src = read('scheduler/get-next.ts');
    const start = src.indexOf('export function getNextWorkItemDefault(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(
      body.includes('getNextWorkItem('),
      'getNextWorkItemDefault no longer delegates to getNextWorkItem. It is enumerated as a ' +
        'wrapper covered by that door; if it now selects rows itself it needs its own proof.',
    ).toBe(true);
    expect(
      /harness_shared\.|SELECT /i.test(body),
      'getNextWorkItemDefault now contains its own SQL. See above — it is no longer a wrapper.',
    ).toBe(false);
  });

  it('the agent-review reviewer door applies the shared issue dependency floor', () => {
    const src = read('harness/improvements/agent-review.ts');
    const start = src.indexOf('export async function claimNextAgentReview(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(
      body.includes('depsBlockedExclusionSql(sql)'),
      'claimNextAgentReview is a self-select door, so it must apply the shared issue-family ' +
        'dependency floor before serving pending review work.',
    ).toBe(true);
  });

  it('BOTH by-id doors keep the security floor and neither grows a readiness floor (D-008)', () => {
    // blocking-floor-single-source.test.ts already asserts this for claimWorkItem. The issue
    // family's claimIssue was never asserted, so the SAME boundary rested on nothing on that
    // side — which is precisely the per-family asymmetry D-017 was.
    const workItems = read('work-items.ts');
    const byId = workItems.slice(workItems.indexOf('export async function claimWorkItem('));
    const claimWorkItemBody = byId.slice(0, byId.indexOf('\nexport '));
    expect(claimWorkItemBody.includes('autoPickableWhereSql')).toBe(true);
    expect(
      /dep_type\s*=\s*'blocks'|depsBlockedExclusionSql/.test(withoutComments(claimWorkItemBody)),
      'claimWorkItem must NOT enforce dependency-blocking (D-008 / EI-8972).',
    ).toBe(false);

    const issues = read('issues-engineer.ts');
    const issueById = issues.slice(issues.indexOf('export async function claimIssue('));
    const claimIssueBody = issueById.slice(0, issueById.indexOf('\nexport '));
    expect(
      /dep_type\s*=\s*'blocks'|depsBlockedExclusionSql/.test(withoutComments(claimIssueBody)),
      'claimIssue must NOT enforce dependency-blocking. The by-id claim is the deliberate ' +
        'operator override in BOTH families; adding the floor here would break reopen / ' +
        'inherit / attach-follow-up for issues while leaving features alone — a per-family ' +
        'asymmetry, which is the exact shape of D-017.',
    ).toBe(false);
  });
});

describe('the census DETECTS a door (so its empty results mean something)', () => {
  const scan = (code: string) =>
    WORK_ITEM_RELATIONS.test(code) ? [...code.matchAll(DOOR_NAME)].map((m) => m[1]) : [];

  it('a new self-select door in a work-item module is discovered', () => {
    expect(
      scan('export async function claimNextThing() { return sql`SELECT 1 FROM harness_shared.work_items` }'),
    ).toEqual(['claimNextThing']);
  });

  it('an unrelated lease-claim is NOT discovered (the relation half of the criterion works)', () => {
    // claimVoiceLease / claimFleetLaunchSlot / claimDueRoutine / claimReaction all match the
    // NAME. If they entered the census, CLAIM_DOORS would fill with noise and the real
    // question — does this door gate? — would stop being asked of anything.
    expect(scan('export async function claimVoiceLease() { return sql`SELECT 1 FROM harness_shared.voice_leases` }')).toEqual(
      [],
    );
  });

  it('a prose mention of a door is NOT discovered', () => {
    expect(scan(withoutComments('// see claimNextWorkItem() in harness_shared.work_items'))).toEqual([]);
  });
});
