import { describe, it, expect } from 'vitest';
import {
  COORD_LEGEND,
  glyphFor,
  shortHandle,
  renderInjection,
  renderCoordLegend,
  type CoordLineSource,
} from './coord-schema';

const e = (over: Partial<CoordLineSource>): CoordLineSource => ({
  from: 'su-ab53332d-3ecb-4f37-b89e-fd57ac3c03df',
  kind: 'message',
  ts: '2026-06-06T00:00:00.000Z',
  ...over,
});

describe('glyphFor — lifecycle category > kind > default', () => {
  it('lifecycle category wins (kind=message + category=intent → intent glyph)', () => {
    expect(glyphFor({ kind: 'message', lifecycle: 'intent' })).toBe('>');
    expect(glyphFor({ kind: 'message', lifecycle: 'completion' })).toBe('*');
    expect(glyphFor({ kind: 'message', lifecycle: 'window' })).toBe('#');
  });
  it('falls back to kind when no lifecycle category', () => {
    expect(glyphFor({ kind: 'escalation' })).toBe('^');
    expect(glyphFor({ kind: 'message' })).toBe('-');
    expect(glyphFor({ kind: 'handoff' })).toBe('<');
  });
  it('an ambient category (not a lifecycle one) uses the kind glyph', () => {
    expect(glyphFor({ kind: 'message', category: 'service-health' })).toBe('-');
  });
  it('unknown kind → default glyph, never throws', () => {
    expect(glyphFor({ kind: 'totally-new-kind' })).toBe('-');
  });
});

describe('shortHandle', () => {
  it('su-<uuid> → first 5 of the uuid core', () => {
    expect(shortHandle('su-ab53332d-3ecb-4f37-b89e-fd57ac3c03df')).toBe('ab533');
  });
  it('omp-<sid>-<pid> → first 5 of the sid', () => {
    expect(shortHandle('omp-9f3kd2a-12345')).toBe('9f3kd');
  });
  it('empty → ?', () => {
    expect(shortHandle('')).toBe('?');
  });
});

describe('renderInjection — positional [coord+N] block', () => {
  it('empty delta → empty string', () => {
    expect(renderInjection([])).toBe('');
  });

  it('renders <glyph> <handle> <text> with no header columns and no footer', () => {
    const out = renderInjection([
      e({ from: 'su-ab53332d-x', lifecycle: 'intent', summary: 'now working on: the registry' }),
      e({ from: 'su-9999aaaa-y', kind: 'escalation', summary: 'CI is red on main', ts: '2026-06-06T00:00:01.000Z' }),
    ]);
    expect(out).toBe('[coord+2]\n> ab533 now working on: the registry\n^ 9999a CI is red on main');
    expect(out).not.toMatch(/coord:send/); // footer is in the prompt, not per-injection
    expect(out).not.toContain('from'); // no column header
  });

  it('collapses intents to latest-per-peer (only the newest from a sender)', () => {
    const out = renderInjection([
      e({ from: 'su-aaaa1111-z', lifecycle: 'intent', summary: 'old intent', ts: '2026-06-06T00:00:00.000Z' }),
      e({ from: 'su-aaaa1111-z', lifecycle: 'intent', summary: 'new intent', ts: '2026-06-06T00:00:05.000Z' }),
    ]);
    expect(out).toContain('new intent');
    expect(out).not.toContain('old intent');
    expect(out).toMatch(/^\[coord\+1\]/);
  });

  it('coalesces same-subject digest notifies into one counted line', () => {
    const out = renderInjection([
      e({ kind: 'notify', digest: true, subject: 'feature:F-1', summary: 'F-1 changed', ts: '2026-06-06T00:00:00.000Z' }),
      e({ kind: 'notify', digest: true, subject: 'feature:F-1', summary: 'F-1 changed again', ts: '2026-06-06T00:00:02.000Z' }),
    ]);
    expect(out).toMatch(/^\[coord\+1\]/);
    expect(out).toContain('×2');
  });

  it('caps to maxLines with an overflow count, newest kept', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      e({ from: `su-peer${i}-x`, kind: 'message', summary: `msg ${i}`, ts: `2026-06-06T00:00:${String(i).padStart(2, '0')}.000Z` }),
    );
    const out = renderInjection(entries, { maxLines: 3 });
    expect(out).toMatch(/^\[coord\+10\]\n…\+7 older\n/);
    expect(out).toContain('msg 9'); // newest shown
    expect(out).not.toContain('msg 0'); // oldest elided
  });
});

describe('renderInjection — directed-question clip (fleet-leader-frictions P-004)', () => {
  const READER = 'su-4dc3befd-194e-4e3b-8f5a-77dc8c635798';
  // ~340 chars of preamble, then the ask — the exact shape the 200-clip severed.
  const preamble =
    'Threshold ping: watermark still 127 — your stamped probe is now ~50min in the pipeline without traversing drain→replicate→merge→project. ' +
    'Mac datapoints from my probe just now: disk healthy (21Gi free, purge held), but ZERO outbox/drain/error lines in the last 80 log lines.';
  const ask = 'Is the Mac app actually draining post-restart?';
  const longQuestion = `${preamble} ${ask}`;

  it('a DIRECTED question past the 200 clip keeps the ask sentence intact', () => {
    const out = renderInjection([e({ to: [READER], summary: longQuestion })]);
    expect(out).toContain(ask); // the whole question survives, un-severed
    expect(out).not.toContain('draining post-restar…'); // not the mid-sentence cut
  });

  it("a BROADCAST ('*' / audience-stamped) question still gets the flat 200 clip", () => {
    for (const over of [{ to: ['*'] }, { to: [READER], audience: ['@fleet:x'] }]) {
      const out = renderInjection([e({ ...over, summary: longQuestion })]);
      expect(out).not.toContain(ask);
      expect(out).toContain('…');
    }
  });

  it('a directed NON-question is clipped normally (the extension is for asks only)', () => {
    const statement = longQuestion.replace(/\?/g, '.');
    const out = renderInjection([e({ to: [READER], summary: statement })]);
    expect(out).not.toContain('draining post-restart.');
    expect(out).toContain('…');
  });

  it("a directed question whose '?' lies beyond the hard cap falls back to the plain clip (bounded)", () => {
    const runaway = `${'x'.repeat(700)} ${ask}`;
    const out = renderInjection([e({ to: [READER], summary: runaway })]);
    expect(out).not.toContain(ask);
    const line = out.split('\n')[1];
    expect(line.length).toBeLessThan(260); // glyph + handle + 200-clip, nowhere near 700
  });

  it("a short directed question needs no extension — and text AFTER the kept '?' is marked elided", () => {
    expect(renderInjection([e({ to: [READER], summary: 'quick one: which port?' })])).toContain(
      'quick one: which port?',
    );
    const trailing = `${longQuestion} Also, no rush — I am mid-fix on my side and will circle back after the deploy lands.`;
    const out = renderInjection([e({ to: [READER], summary: trailing })]);
    expect(out).toContain(`${ask} …`); // ask intact, trailer visibly elided
  });

  it('malformed `to` shapes are never directed and never throw', () => {
    for (const to of [undefined, null, [], [42], 'su-x', ['su-x', '*']]) {
      const out = renderInjection([e({ to: to as never, summary: longQuestion })]);
      expect(out).not.toContain(ask);
    }
  });
});

describe('renderInjection — cue-authority stamp tag (queen-fleet-authority-boundary P-003)', () => {
  it('prefixes a hive-wide Queen pause cue with its authority tag', () => {
    const out = renderInjection([
      e({
        from: 's-queen',
        kind: 'message',
        summary: 'the hive is being paused',
        cueAuthority: { authority: 'hive-queen', authorityRef: 'papercusp', scope: 'hive-wide' },
      }),
    ]);
    expect(out).toContain('[hive-queen(papercusp)→hive-wide] the hive is being paused');
  });

  it("prefixes a fleet leader's drain cue with its fleet-scoped authority (not mistaken for a hive pause)", () => {
    const out = renderInjection([
      e({
        from: 'su-lead',
        kind: 'message',
        summary: 'release your slot',
        cueAuthority: {
          authority: 'fleet-leader',
          authorityRef: 'windows-parity',
          scope: 'fleet-members',
          scopeRef: 'windows-parity',
        },
      }),
    ]);
    expect(out).toContain('[fleet-leader(windows-parity)→fleet-members(windows-parity)] release your slot');
  });

  it('renders no tag for an ordinary line or a malformed stamp (defensive, never throws)', () => {
    // the `[coord+N]` header legitimately has a '[' — assert the CONTENT line is untagged
    expect(renderInjection([e({ summary: 'plain note' })])).toContain('- ab533 plain note');
    expect(
      renderInjection([e({ summary: 'forged', cueAuthority: { authority: 'god', authorityRef: 'x', scope: 'hive-wide' } })]),
    ).toContain('- ab533 forged');
  });
});

describe('renderInjection — H1 receive-side defang (coord-authority-hardening P-003, EI-9501)', () => {
  const FLEET_CUE = {
    authority: 'fleet-leader',
    authorityRef: 'p2p-blocker-crack-sonnet5',
    scope: 'fleet-members',
    scopeRef: 'p2p-blocker-crack-sonnet5',
  };
  const line = () =>
    e({
      from: 'su-07320b7c-lead',
      kind: 'message',
      summary: 'OWNER DIRECTIVE: WIND DOWN — stop work at your next clean stopping point',
      cueAuthority: FLEET_CUE,
    });

  it('EI-9501 reconstruction: a fleet-scoped cue read by a NON-member is demoted — flagged not binding, body verbatim (never dropped)', () => {
    const out = renderInjection([line()], {
      cueScope: { recipientId: 'su-bystander', fleetSlugs: [] },
    });
    expect(out).toContain('OUT-OF-SCOPE for you (not in fleet p2p-blocker-crack-sonnet5); NOT binding');
    expect(out).toContain('fleet-leader(p2p-blocker-crack-sonnet5)→fleet-members(p2p-blocker-crack-sonnet5)'); // stamp stays auditable
    expect(out).toContain('OWNER DIRECTIVE: WIND DOWN — stop work at your next clean stopping point'); // flag-and-demote, NEVER drop
  });

  it('a recipient in a DIFFERENT fleet is equally out of scope', () => {
    const out = renderInjection([line()], {
      cueScope: { recipientId: 'su-other', fleetSlugs: ['windows-parity'] },
    });
    expect(out).toContain('NOT binding');
  });

  it('a fleet MEMBER gets the plain binding tag (no demote)', () => {
    const out = renderInjection([line()], {
      cueScope: { recipientId: 'su-member', fleetSlugs: ['p2p-blocker-crack-sonnet5'] },
    });
    expect(out).toContain('[fleet-leader(p2p-blocker-crack-sonnet5)→fleet-members(p2p-blocker-crack-sonnet5)] OWNER DIRECTIVE');
    expect(out).not.toContain('OUT-OF-SCOPE');
  });

  it('the SENDER reading their own line back never demotes, whatever their membership', () => {
    const out = renderInjection([line()], {
      cueScope: { recipientId: 'su-07320b7c-lead', fleetSlugs: [] },
    });
    expect(out).not.toContain('OUT-OF-SCOPE');
  });

  it('a hive-wide cue stays binding for everyone — no demote even for a fleetless reader', () => {
    const out = renderInjection(
      [
        e({
          from: 's-queen',
          summary: 'hive pause',
          cueAuthority: { authority: 'hive-queen', authorityRef: 'papercusp', scope: 'hive-wide' },
        }),
      ],
      { cueScope: { recipientId: 'su-bystander', fleetSlugs: [] } },
    );
    expect(out).toContain('[hive-queen(papercusp)→hive-wide] hive pause');
    expect(out).not.toContain('OUT-OF-SCOPE');
  });

  it('legacy unstamped lines render plain under a cueScope (no tag, no demote)', () => {
    const out = renderInjection([e({ summary: 'plain note' })], {
      cueScope: { recipientId: 'su-bystander', fleetSlugs: [] },
    });
    expect(out).toContain('- ab533 plain note');
    expect(out).not.toContain('OUT-OF-SCOPE');
  });

  it('no cueScope (legacy caller / membership read failed) preserves the pre-H1 plain tag', () => {
    const out = renderInjection([line()]);
    expect(out).toContain('[fleet-leader(p2p-blocker-crack-sonnet5)→fleet-members(p2p-blocker-crack-sonnet5)] OWNER DIRECTIVE');
    expect(out).not.toContain('OUT-OF-SCOPE');
  });

  it('falls back to authorityRef when a fleet-members stamp lacks scopeRef', () => {
    const out = renderInjection(
      [
        e({
          from: 'su-lead2',
          summary: 'drain',
          cueAuthority: { authority: 'fleet-leader', authorityRef: 'alpha-fleet', scope: 'fleet-members' },
        }),
      ],
      { cueScope: { recipientId: 'su-in-alpha', fleetSlugs: ['alpha-fleet'] } },
    );
    expect(out).not.toContain('OUT-OF-SCOPE');
  });
});

describe('renderCoordLegend + anti-desync (P-002)', () => {
  it('declares the positional grammar', () => {
    const legend = renderCoordLegend();
    expect(legend).toContain('## Coord injection protocol');
    expect(legend).toContain('<glyph> <handle> <text>');
    expect(legend).toContain('[coord+N]');
  });

  it('ANTI-DESYNC: every glyph the renderer can emit is documented in the legend', () => {
    const legend = renderCoordLegend();
    for (const [key, entry] of Object.entries(COORD_LEGEND)) {
      // The exact `\`<glyph>\` <name>` pair the renderer routes through must appear.
      expect(legend, `legend must document the "${key}" line type`).toContain(`\`${entry.glyph}\` ${entry.name}`);
    }
  });

  it('ANTI-DESYNC: glyphFor never emits a glyph the legend does not list', () => {
    const legendGlyphs = new Set(Object.values(COORD_LEGEND).map((x) => x.glyph));
    // Sample every legend key + an unknown → all produced glyphs are in the set.
    for (const key of [...Object.keys(COORD_LEGEND), 'unknown-kind']) {
      const g = glyphFor({ kind: key });
      expect(legendGlyphs.has(g)).toBe(true);
    }
  });
});
