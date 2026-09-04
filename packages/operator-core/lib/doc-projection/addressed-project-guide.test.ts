import { describe, expect, it } from 'vitest';
// ⚠ ONE LINE, deliberately — see project-doc-parts.test.ts for why the directive must sit on the specifier line.
// @ts-expect-error — .mjs script, no type declarations by design (it is a scripts/ tool).
import { addressedInventory, assemble, parseAudienceArg, partIsAddressed, partReachesAudience, projectClient, PROJECTION_BUDGET_CHARS } from '../../../../scripts/project-doc-parts.mjs';
import {
  ADDRESSED_GUIDE_MAX_CHARS,
  composeProjectGuideForWearer,
  projectGuideComposerForWearer,
  renderAddressedGuideSections,
  type AddressedGuidePart,
} from './addressed-project-guide';
import {
  GUIDE_ADDRESS_KINDS,
  guideAddressMatches,
  guideAddressProblems,
  guideAddressesForWearer,
  parseGuideAddress,
} from './guide-address';
import { validateDocPart } from '../harness/docs/doc-record';

/**
 * identities-v1-2026-08-30 P-022 — the Project guide becomes BLUEPRINT-ADDRESSABLE.
 *
 * ACCEPTANCE (the item's own words): two agents in the same pot wearing different
 * stacks receive different, correct Project guides; the unaddressed default is unchanged
 * for every existing reader. Both halves are asserted below against synthetic parts —
 * nothing here reads the live CLAUDE.md or a database (the same rule project-doc-parts
 * .test.ts states, for the same reason).
 */

type Part = {
  part_key: string;
  kind: string;
  body: string;
  ordinal: number;
  client_scope: string[];
  target_section: string | null;
  project_rank: number;
  stack_scope?: string[];
};

let seq = 0;
function part(over: Partial<Part> = {}): Part {
  seq += 1;
  return {
    part_key: `p-${seq}`,
    kind: 'invariant',
    body: `body ${seq}`,
    ordinal: seq,
    client_scope: ['all'],
    target_section: 'Section A',
    project_rank: 100,
    ...over,
  };
}

const CLIENT = { client: 'claude', file: 'CLAUDE.md', reader: 'Claude Code', docId: 'synthetic', budget: 50_000 };

describe('guide-address — the ONE addressing grammar', () => {
  it('parses the three kinds and refuses everything else', () => {
    expect(parseGuideAddress('blueprint:su.fleet-leader')).toEqual({ kind: 'blueprint', value: 'su.fleet-leader' });
    expect(parseGuideAddress('slot:autonomy')).toEqual({ kind: 'slot', value: 'autonomy' });
    expect(parseGuideAddress('role:su')).toEqual({ kind: 'role', value: 'su' });
    for (const bad of ['', 'su.fleet-leader', 'client:claude', 'slot:', 'blueprint:a b', 'slot:a:b', 'Blueprint:x']) {
      expect(parseGuideAddress(bad), bad).toBeNull();
    }
    expect(GUIDE_ADDRESS_KINDS).toEqual(['blueprint', 'slot', 'role']);
  });

  it('guideAddressProblems: shape always; vocabulary only when supplied', () => {
    expect(guideAddressProblems([])).toEqual([]);
    expect(guideAddressProblems(['blueprint:x', 'slot:autonomy'])).toEqual([]);
    expect(guideAddressProblems(['nope'])).toHaveLength(1);
    expect(guideAddressProblems(['slot:autonomy', 'slot:autonomy'])).toEqual([expect.stringContaining('duplicate')]);
    expect(guideAddressProblems(['slot:ghost'], { knownSlots: ['autonomy'] })).toEqual([expect.stringContaining('no registered slot')]);
    expect(guideAddressProblems(['blueprint:ghost'], { blueprintExists: () => false })).toEqual([expect.stringContaining('resolves to no blueprint')]);
    expect(guideAddressProblems(['blueprint:real'], { blueprintExists: (id) => id === 'real' })).toEqual([]);
  });

  it('expands a wearer to role + every layer’s slot and blueprint tokens, sorted and deduped', () => {
    const tokens = guideAddressesForWearer({
      role: 'su',
      layers: [
        { slot: 'domain', id: 'papercusp-engineer' },
        { slot: 'fleet-posture', id: 'su.fleet-leader' },
        { slot: 'autonomy', id: 'su.mode-auto' },
        { slot: 'domain', id: 'papercusp-engineer' },
      ],
    });
    expect(tokens).toEqual([
      'blueprint:papercusp-engineer',
      'blueprint:su.fleet-leader',
      'blueprint:su.mode-auto',
      'role:su',
      'slot:autonomy',
      'slot:domain',
      'slot:fleet-posture',
    ]);
    expect(guideAddressesForWearer({ layers: [] })).toEqual([]);
  });

  it('matches by intersection; an empty stack_scope reaches everyone', () => {
    expect(guideAddressMatches([], [])).toBe(true);
    expect(guideAddressMatches(['slot:autonomy'], ['role:su'])).toBe(false);
    expect(guideAddressMatches(['slot:autonomy', 'role:su'], ['role:su'])).toBe(true);
  });

  it('validateDocPart mirrors migration 1104: addressed ⇒ projects; tokens well-formed', () => {
    const base = { partKey: 'k', kind: 'invariant', targetSection: 'S', rationalePartKey: null };
    expect(validateDocPart({ ...base, clientScope: ['all'] })).toBeNull(); // pre-P-022 caller, untouched
    expect(validateDocPart({ ...base, clientScope: ['all'], stackScope: ['slot:autonomy'] })).toBeNull();
    expect(validateDocPart({ ...base, clientScope: [], stackScope: ['slot:autonomy'] })).toMatch(/must also project/);
    expect(validateDocPart({ ...base, clientScope: ['all'], stackScope: ['leader'] })).toMatch(/not an address/);
    expect(
      validateDocPart({ ...base, clientScope: ['all'], stackScope: ['slot:ghost'], stackVocabulary: { knownSlots: ['autonomy'] } }),
    ).toMatch(/no registered slot/);
  });
});

describe('projector — the default file is composed from UNADDRESSED parts only', () => {
  it('partIsAddressed / partReachesAudience: null audience ⇒ unaddressed only; tokens ⇒ intersection', () => {
    const plain = part();
    const leader = part({ stack_scope: ['blueprint:su.fleet-leader'] });
    expect(partIsAddressed(plain)).toBe(false);
    expect(partIsAddressed(leader)).toBe(true);
    expect(partReachesAudience(plain, null)).toBe(true);
    expect(partReachesAudience(leader, null)).toBe(false);
    expect(partReachesAudience(leader, ['role:su'])).toBe(false);
    expect(partReachesAudience(leader, ['role:su', 'blueprint:su.fleet-leader'])).toBe(true);
  });

  it('ACCEPTANCE ½ — the unaddressed default is BYTE-IDENTICAL whether or not addressed rows exist', () => {
    const unaddressed = [part({ body: 'rule one' }), part({ body: 'rule two', target_section: 'Section B' })];
    const withAddressed = [
      ...unaddressed,
      part({ body: 'LEADER ONLY', stack_scope: ['blueprint:su.fleet-leader'] }),
      part({ body: 'AUTO ONLY', stack_scope: ['slot:autonomy'] }),
    ];
    const before = projectClient(unaddressed, CLIENT).text;
    const after = projectClient(withAddressed, CLIENT).text;
    expect(after).toBe(before);
    expect(after).not.toContain('LEADER ONLY');
    expect(after).not.toContain('AUTO ONLY');
  });

  it('ACCEPTANCE ½ — two wearers in one pot receive DIFFERENT, CORRECT guides', () => {
    const parts = [
      part({ body: 'shared rule' }),
      part({ body: 'LEADER ONLY', stack_scope: ['blueprint:su.fleet-leader'] }),
      part({ body: 'MEMBER ONLY', stack_scope: ['blueprint:su.fleet-member'] }),
      part({ body: 'AUTO ONLY', stack_scope: ['slot:autonomy'] }),
    ];
    const leader = guideAddressesForWearer({ role: 'su', layers: [{ slot: 'fleet-posture', id: 'su.fleet-leader' }] });
    const memberAuto = guideAddressesForWearer({
      role: 'su',
      layers: [
        { slot: 'fleet-posture', id: 'su.fleet-member' },
        { slot: 'autonomy', id: 'su.mode-auto' },
      ],
    });
    const a = projectClient(parts, { ...CLIENT, audience: leader }).text;
    const b = projectClient(parts, { ...CLIENT, audience: memberAuto }).text;
    expect(a).not.toBe(b);
    expect(a).toContain('shared rule');
    expect(a).toContain('LEADER ONLY');
    expect(a).not.toContain('MEMBER ONLY');
    expect(a).not.toContain('AUTO ONLY');
    expect(b).toContain('shared rule');
    expect(b).toContain('MEMBER ONLY');
    expect(b).toContain('AUTO ONLY');
    expect(b).not.toContain('LEADER ONLY');
  });

  it('addressedInventory groups by token in read order; parseAudienceArg dedupes and refuses empty', () => {
    const inv = addressedInventory([
      part({ ordinal: 2, body: 'bb', stack_scope: ['slot:autonomy', 'role:su'] }),
      part({ ordinal: 1, body: 'a', stack_scope: ['slot:autonomy'] }),
      part(),
    ]);
    expect(inv.map((e: { token: string }) => e.token)).toEqual(['role:su', 'slot:autonomy']);
    expect(inv[1].parts.length).toBe(2);
    expect(inv[1].chars).toBe(3);
    expect(parseAudienceArg(['--write'])).toBeNull();
    expect(parseAudienceArg(['--audience=b, a ,b'])).toEqual(['a', 'b']);
    expect(() => parseAudienceArg(['--audience='])).toThrow(/at least one token/);
  });
});

describe('addressed-project-guide — the launch seam', () => {
  const addressed: AddressedGuidePart[] = [
    { part_key: 'lead-1', body: 'Leaders bench lanes.', ordinal: 10, target_section: 'Fleet leadership', stack_scope: ['blueprint:su.fleet-leader'] },
    { part_key: 'lead-2', body: 'Leaders declare gates.', ordinal: 11, target_section: 'Fleet leadership', stack_scope: ['blueprint:su.fleet-leader'] },
    { part_key: 'pre', body: 'A preamble-positioned note.', ordinal: 12, target_section: '(preamble)', stack_scope: ['role:su'] },
  ];

  it('the cap IS the projector’s enforced budget — pinned, not restated by memory', () => {
    expect(ADDRESSED_GUIDE_MAX_CHARS).toBe(PROJECTION_BUDGET_CHARS);
  });

  it('renders sections exactly as the projector’s assemble does (heading per section change, no (preamble) heading)', () => {
    const rendered = renderAddressedGuideSections(addressed, ['blueprint:su.fleet-leader', 'role:su']);
    const lede = rendered.slice(0, rendered.indexOf('\n\n## Fleet leadership'));
    expect(lede).toContain('## Addressed guidance');
    expect(lede).toContain('`blueprint:su.fleet-leader`, `role:su`');
    // The body after the lede is byte-equal to the projector's own composition of the same rows.
    const body = rendered.slice(lede.length + 2);
    expect(body).toBe(assemble(addressed));
    expect(body).toContain('## Fleet leadership\n\nLeaders bench lanes.\n\nLeaders declare gates.\n\nA preamble-positioned note.');
    expect(body).not.toContain('## (preamble)');
    expect(renderAddressedGuideSections([], ['role:su'])).toBe('');
  });

  it('no addressed parts ⇒ the default passes through the budget seam BYTE-IDENTICAL', () => {
    const defaultText = '# Guide\n\nUse nuqs.\n';
    const out = composeProjectGuideForWearer({ defaultText, source: '/repo/CLAUDE.md', parts: [], tokens: ['role:su'] });
    expect(out.text).toBe(defaultText);
    expect(out.truncated).toBe(false);
    expect(out.addressed).toBeNull();
  });

  it('addressed parts are appended after the default and accounted for', () => {
    const defaultText = '# Guide\n\nUse nuqs.\n\n';
    const out = composeProjectGuideForWearer({ defaultText, source: '/repo/CLAUDE.md', parts: addressed, tokens: ['blueprint:su.fleet-leader'] });
    expect(out.text.startsWith('# Guide\n\nUse nuqs.\n\n## Addressed guidance')).toBe(true);
    expect(out.text).toContain('Leaders bench lanes.');
    expect(out.truncated).toBe(false);
    expect(out.addressed).toEqual({
      tokens: ['blueprint:su.fleet-leader'],
      partKeys: ['lead-1', 'lead-2', 'pre'],
      addedChars: out.text.length - defaultText.length,
    });
  });

  it('projectGuideAtBudget stays the seam — an oversized composition is cut with the pointer, never emitted whole', () => {
    const defaultText = 'x'.repeat(2_000);
    const big: AddressedGuidePart[] = [{ part_key: 'huge', body: 'y'.repeat(3_000), ordinal: 1, target_section: 'S', stack_scope: ['role:su'] }];
    const out = composeProjectGuideForWearer({ defaultText, source: '/repo/CLAUDE.md', parts: big, tokens: ['role:su'], maxChars: 4_000 });
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(4_000 + 320);
    expect(out.text).toContain('Project guide truncated');
    expect(out.text).toContain('/repo/CLAUDE.md');
  });

  it('projectGuideComposerForWearer: a failed read degrades to the DEFAULT guide and reports the error', async () => {
    const errors: unknown[] = [];
    const compose = projectGuideComposerForWearer({
      wearer: { role: 'su', layers: [{ slot: 'fleet-posture', id: 'su.fleet-leader' }] },
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      client: 'claude',
      // A stub `Sql` whose `unsafe` throws — the shape `readAddressedGuideParts` calls.
      sql: { unsafe: async () => { throw new Error('relation missing'); } } as never,
      onError: (e) => errors.push(e),
    });
    const out = await compose({ text: '# Guide\n', source: '/repo/CLAUDE.md' });
    expect(out.text).toBe('# Guide\n');
    expect(out.addressed).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it('projectGuideComposerForWearer: reads with the wearer’s tokens and both client axes, composes the rows', async () => {
    const calls: unknown[][] = [];
    const compose = projectGuideComposerForWearer({
      wearer: { role: 'su', layers: [{ slot: 'fleet-posture', id: 'su.fleet-leader' }] },
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      client: 'codex',
      sql: {
        unsafe: async (_q: string, params: unknown[]) => {
          calls.push(params);
          return addressed.slice(0, 1);
        },
      } as never,
    });
    const out = await compose({ text: '# Guide\n', source: '/repo/CLAUDE.md' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['ws', 'papercusp', 'claude-md', ['blueprint:su.fleet-leader', 'role:su', 'slot:fleet-posture'], ['codex', 'all']]);
    expect(out.addressed?.partKeys).toEqual(['lead-1']);
    expect(out.text).toContain('Leaders bench lanes.');
  });
});
