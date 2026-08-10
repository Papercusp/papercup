/**
 * The mug/kettle census must tell a UI that OFFERS A ROUTE into the retired tier from one
 * that merely NAMES it.
 *
 * EI-20091394509538630 (2026-08-10). D7's third branch fired on ANY quoted tier token in a
 * `.tsx` whose basename matched `Sidebar|Tab|Rail|Nav`, then asserted the token "mounts a
 * tier tab" — a claim about the token's ROLE, made without looking at its position.
 * Measured on the live population, 3 of its 4 findings mounted nothing:
 *
 *   · FleetPeersRail:69 / GoalSessionsRail:56  `agentPaneKind === 'cup' ? <span>cup</span>`
 *   · AdvEvalsTab:1305                         `sub={… ? 'mug' : `mug · ${age}s`}`
 *
 * and only `LeftSidebar:159` — `{ id: 'queen', render: () => <MugTab/> }` — was the shape
 * the detector was built for.
 *
 * WHY IT COST SOMETHING. Those two badge lines are IDENTICAL: the second is a copy of the
 * first into a new file. The first had already been absorbed into the guard's baseline, so
 * by the time the copy landed the guard was in exactly the state its own header warns
 * about — noise rubber-stamped as population — and the copy read as a novel ungated entry
 * point. It red-pinned the shared green-checkpoint gate for over an hour with `main`
 * frozen, and three separate agents paid full triage on it inside thirty minutes.
 *
 * WHY THE FIX IS A POSITION RULE, NOT A REWORD OF THE LINE. Rewording the badge leaves the
 * trap armed for the next one, and there WILL be a next one: the retirement is executed by
 * writing UI that reports what a pane already is. Same structural argument as the sibling
 * comment-blindness suite (WI-37661), one level up — that guard fired on the plan's own
 * documentation, this one on the plan's own UI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { offersTierRoute } from '../../../scripts/lib/mug-kettle-ui-route.mjs';
import { stripCommentsOnly } from '../../../scripts/lib/strip-comments-and-strings.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * A DELIBERATELY PERMISSIVE stand-in for the census's `namesTier`, and the direction is
 * load-bearing in both halves of this suite:
 *
 *  · For a `null` (display-only) expectation it is the HARDER test. A permissive ruling can
 *    only ever find MORE mounts than the real one, so a file that classifies display-only
 *    under this stub classifies display-only under the census's real ruling a fortiori —
 *    including its homonym exclusions (`AnimatedPapercuspCup` is brand art, `papercup` is
 *    the Sentinel role). That is what lets this suite assert on real files without carrying
 *    a second copy of a ruling that has already drifted four ways in this repo.
 *  · For a mount expectation it would be too weak — so every mount case below is either
 *    carried by the DECLARATION half (which never consults `namesTier` at all) or states
 *    its component name explicitly.
 */
const permissiveNamesTier = (name: string): string | null =>
  /mug|kettle|cup|queen|pot|hive|bee|overwatch|nursery/i.exec(name)?.[0]?.toLowerCase() ?? null;

const classify = (src: string) => offersTierRoute(src, permissiveNamesTier);
const realFile = (rel: string) => stripCommentsOnly(readFileSync(join(REPO_ROOT, rel), 'utf8'), rel);

describe('mug/kettle census — a route into the tier vs a mention of it (EI-20091394509538630)', () => {
  /**
   * THE CALIBRATION, deliberately first: every "display-only" assertion below is satisfied
   * by a classifier that returns null for EVERYTHING, so without this the suite would pass
   * most loudly at the moment the detector went blind. That is the exact failure direction
   * this change risks — a precision fix is one over-tightened regex away from a guard that
   * never fires again.
   */
  describe('CONTROL: the shapes that genuinely offer a route are still caught', () => {
    it('a tab strip entry declaring an id', () => {
      expect(classify("{ id: 'queen', label: t('brain'), render: (a) => <MugTab active={a} /> }"))
        .toMatch(/declares tab identity/);
    });

    it('a JSX attribute carrying the id', () => {
      expect(classify('<Tab value="mug" onSelect={go} />')).toMatch(/declares tab identity/);
    });

    it('a bare array element — the shape a keyed-field rule alone would miss', () => {
      expect(classify("const TAB_IDS = ['queen', 'overwatch', 'agents'];")).toMatch(/declares tab identity/);
    });

    it('a navigation call taking the id as an argument', () => {
      expect(classify("onClick={() => setTab('cup')}")).toMatch(/declares tab identity/);
    });

    /**
     * The hole the position rule opens, closed by the element half — stated as a test so
     * nobody has to take the header's word for it. Here the ONLY quoted token is a
     * comparison operand, so the declaration half correctly skips it; the mount is real
     * regardless, and is caught by the component being rendered.
     */
    it('a comparison that GUARDS a mount is still a mount', () => {
      expect(classify("{tab === 'cup' ? <CupPane active /> : null}")).toBe('mounts <CupPane>');
    });

    /**
     * A recall GAIN over the token scan this replaces: had `LeftSidebar`'s id been a
     * constant rather than the literal `'queen'`, the mount itself was invisible.
     */
    it('a tier component mounted with no quoted token anywhere', () => {
      expect(classify('return <MugTab active={active} />;')).toBe('mounts <MugTab>');
    });

    it('the real LeftSidebar still classifies as a route', () => {
      expect(classify(realFile('apps/operator-vite/src/components/left-sidebar/LeftSidebar.tsx')))
        .toMatch(/declares tab identity|mounts </);
    });
  });

  describe('a read-only mention is NOT a route', () => {
    /**
     * The line that froze `main`, verbatim from both files it appears in. It prints the word
     * "cup" beside a peer row the roster already returned as one: it mounts nothing, spawns
     * nothing, and refusing to RENDER it would hide what a live pane IS rather than withhold
     * a capability — so there is no gate that fits, which is why the guard's prescribed
     * remedy ("refuse when the flag is off") could not be applied to it.
     */
    it('an equality-test badge', () => {
      expect(classify(`{peer.agentPaneKind === 'cup' ? <span className="pc-peer__kind">cup</span> : null}`))
        .toBeNull();
    });

    it('a display string in a stat tile', () => {
      expect(classify("sub={q.ageSec == null ? 'mug' : `mug · ${q.ageSec}s`}")).toBeNull();
    });

    /**
     * ⚠ CASE-SENSITIVITY IS LOAD-BEARING, not incidental. The declaration rule accepts
     * `kind:`/`kind=`; under `/i` the `Kind` suffix of `agentPaneKind` would satisfy it and
     * re-admit the badge shape through the back door.
     */
    it('a camelCase field whose SUFFIX spells a declaration key', () => {
      expect(classify("row.agentPaneKind === 'cup'")).toBeNull();
      expect(classify("row.paneName !== 'kettle'")).toBeNull();
    });

    it('the real badge-bearing rails, as the census reads them', () => {
      expect(classify(realFile('apps/operator/app/_components/chat/FleetPeersRail.tsx'))).toBeNull();
      expect(classify(realFile('apps/operator/app/adv/hud/GoalSessionsRail.tsx'))).toBeNull();
    });
  });

  /**
   * `TIER_JSX_RE` is module-scoped and carries the `/g` flag, so a leaked `lastIndex` would
   * make the SECOND classification of the same input skip what the first consumed — a
   * detector that is correct exactly once per process. Cheap to assert, invisible in any
   * single-call test, and this module is called once per file across ~7,200 files.
   */
  it('is idempotent across calls (no leaked regex lastIndex)', () => {
    const src = 'return <MugTab active={active} />;';
    expect(classify(src)).toBe(classify(src));
    expect(classify(src)).toBe('mounts <MugTab>');
  });
});
