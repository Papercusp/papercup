// @vitest-environment jsdom
/**
 * GoalSessionsRail — rendering coverage for TERMINAL sessions.
 *
 * The derivation (`goal-sessions.test.ts`) already proves an ended session is
 * KEPT, sunk below the living, and capped. What it cannot prove is how that row
 * READS, and that is where this rail was wrong: `goal-sessions.ts` preserves
 * `column` verbatim as history, so a session that died mid-`working` arrived at
 * the renderer carrying the board's live `working` vocabulary. The component set
 * `data-ended` intending the row to be greyed — and nothing in the repo styled
 * that attribute — so the row rendered a green `--good` dot and the word
 * "working" on a rail whose own heading asks who is *working on it*. A corpse
 * read as a live worker: the single question this rail exists to answer.
 *
 * Two independent claims are pinned here, because either one alone is passable
 * while the bug is live:
 *
 *  1. The WORD. The row must say "ended" in text. Colour is not a cue a
 *     colour-blind reader, a high-contrast theme, or a screen reader receives —
 *     the same reason SessionChatModal spells out "This session has ended"
 *     instead of tinting its composer.
 *  2. The CSS RULE. This is the one that actually catches the original defect.
 *     The component asserting `data-ended` on the <li> passed perfectly well
 *     with zero styling behind it, so a render-only test is blind here by
 *     construction. Pinning the stylesheet is what makes the attribute's
 *     contract falsifiable.
 *
 * The model is built by hand rather than through `deriveGoalSessions`, so a
 * derivation bug cannot make a rendering test pass.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import GoalSessionsRail from './GoalSessionsRail';
import type {
  GoalSessionRow,
  GoalSessionsModel,
  GoalSessionsSection,
} from './goal-sessions';

afterEach(cleanup);

function row(over: Partial<GoalSessionRow> = {}): GoalSessionRow {
  return {
    ownerId: 'su-e8a25005-9a96-4d09-baf7-89fc7c103965',
    handle: 'su-e8a25005',
    label: 'su · su-e8a25',
    intent: null,
    column: 'working',
    reason: 'implementing the sessions rail',
    sinceSec: 40,
    isLead: true,
    contextPct: null,
    agent: 'claude',
    agentPaneKind: 'su',
    fleetSlug: null,
    ended: false,
    ...over,
  };
}

/** One populated section; the rail's other four render their empty lines. */
function model(rows: GoalSessionRow[]): GoalSessionsModel {
  const sections: GoalSessionsSection[] = [
    {
      id: 'plan',
      caption: 'Plan',
      groups: [{ lead: rows[0]!, members: rows.slice(1) }],
      count: rows.length,
      emptyLine: 'No plan fleet on this goal yet.',
    },
  ];
  return { sections, total: rows.length, empty: rows.length === 0 } as GoalSessionsModel;
}

/** A populated section beside an empty one — the shape the coverage model is
 *  actually read in, and the only one that can show the dimming contrast. */
function mixedModel(): GoalSessionsModel {
  const sections: GoalSessionsSection[] = [
    {
      id: 'plan',
      caption: 'Plan',
      groups: [{ lead: row(), members: [] }],
      count: 1,
      emptyLine: 'No plan fleet on this goal yet.',
    },
    {
      id: 'drain',
      caption: 'Drain',
      groups: [],
      count: 0,
      emptyLine: 'No drain fleet yet.',
    },
  ];
  return { sections, total: 1, empty: false } as GoalSessionsModel;
}

const noop = () => {};

describe('GoalSessionsRail — terminal sessions', () => {
  it('says "ended" IN WORDS on a session that stopped, so the cue is not colour-only', () => {
    render(<GoalSessionsRail model={model([row({ ended: true })])} onClose={noop} />);

    const state = screen.getByTestId('goal-session-row').querySelector('.pc-peer__state');
    expect(state?.textContent).toContain('ended');
  });

  it('KEEPS the last state word as history rather than replacing it', () => {
    // The state it stopped in is evidence of what it was doing — a test agent
    // that ended while `working` is proof the testing ran. The word "ended"
    // qualifies that history; it must not erase it.
    render(<GoalSessionsRail model={model([row({ ended: true })])} onClose={noop} />);

    const state = screen.getByTestId('goal-session-row').querySelector('.pc-peer__state');
    expect(state?.textContent).toContain('working');
  });

  it('does NOT say "ended" on a live session', () => {
    // The inverse guard: a marker that renders unconditionally would report the
    // whole rail dead, which is the same failure pointing the other way.
    render(<GoalSessionsRail model={model([row({ ended: false })])} onClose={noop} />);

    const state = screen.getByTestId('goal-session-row').querySelector('.pc-peer__state');
    expect(state?.textContent).not.toContain('ended');
  });

  it('marks the row with data-ended so the stylesheet has a hook', () => {
    render(
      <GoalSessionsRail
        model={model([row({ ended: false }), row({ ownerId: 'su-dead', ended: true })])}
        onClose={noop}
      />,
    );

    const ended = screen
      .getAllByTestId('goal-session-row')
      .map((n) => n.getAttribute('data-ended'));
    expect(ended).toEqual([null, 'true']);
  });
});

describe('GoalSessionsRail — empty sections stay visible AND dimmed', () => {
  // The rail keeps all five headings on purpose: the five types are the goal's
  // COVERAGE MODEL, so "no drain fleet" is a finding, and hiding the section
  // would render it as "no drain section exists" — the opposite reading. The
  // dimming is what makes that model scannable at a glance instead of by
  // reading five counts.
  it('keeps an empty section rendered rather than dropping it', () => {
    render(<GoalSessionsRail model={mixedModel()} onClose={noop} />);
    expect(screen.getByTestId('goal-sessions-empty').textContent).toContain(
      'No drain fleet yet.',
    );
  });

  it('marks ONLY the empty section heading with data-muted', () => {
    const { container } = render(<GoalSessionsRail model={mixedModel()} onClose={noop} />);
    const muted = Array.from(container.querySelectorAll('.pc-peers__cap')).map((n) =>
      n.getAttribute('data-muted'),
    );
    // Populated first, empty second — a marker that fired on both would dim the
    // whole rail and destroy the contrast it exists to create.
    expect(muted).toEqual([null, 'true']);
  });
});

describe('GoalSessionsRail — the ended row is actually styled', () => {
  // THE regression guard. `data-ended` shipped with no rule behind it, and no
  // render assertion can see that: the attribute is present either way. Reading
  // the stylesheet is the only way this claim is falsifiable from a unit test.
  const css = readFileSync(
    join(__dirname, '../../_components/chat/chat-controls.css'),
    'utf8',
  );

  it('overrides the live per-column DOT colour for an ended row', () => {
    // Without this the dot keeps `--good` and the row reads as a live worker.
    expect(css).toMatch(/\[data-ended='true'\]\s+\.pc-peer__dot\[data-col\]/);
  });

  it('overrides the live per-column STATE colour for an ended row', () => {
    expect(css).toMatch(/\[data-ended='true'\]\s+\.pc-peer__state\[data-col\]/);
  });

  it('dims the empty-section heading the component marks', () => {
    // Same defect class as the ended dot, found the same way: the component set
    // `data-muted` and nothing styled it, so every heading rendered at equal
    // weight and the coverage model was unreadable at a glance. Pinned here
    // because no render assertion can see a missing stylesheet rule.
    expect(css).toMatch(/\.pc-peers__cap\[data-muted='true'\]/);
  });

  it('beats the per-column rules on specificity', () => {
    // (0,3,0) vs (0,2,0). Asserted as a PROPERTY of the selector rather than a
    // literal, so adding a sixth column above cannot silently reintroduce the
    // bug: the ended rule matches `[data-col]` unqualified and so covers every
    // column, present and future.
    const endedDot = /\[data-ended='true'\]\s+\.pc-peer__dot\[data-col\]\s*\{/.exec(css);
    expect(endedDot).not.toBeNull();
    // It must NOT enumerate a specific column — that is the form that rots.
    expect(css).not.toMatch(/\[data-ended='true'\]\s+\.pc-peer__dot\[data-col='/);
  });
});
