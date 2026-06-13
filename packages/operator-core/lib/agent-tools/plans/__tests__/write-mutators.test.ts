/**
 * Pure-mutator unit tests for the Phase 2 assisted-write verbs.
 *
 * These exercise the byte-level transformations only — the lock
 * integration is covered by the concurrency test that needs real PG.
 *
 * The mutators tested here are exported as plain functions so they can
 * be verified without spinning up the SU lock side-database.
 */

import { describe, expect, it } from 'vitest';
import { flipStatusInBody } from '../set-status';
import { setImportanceInBody } from '../set-importance';
import { replaceNowBlock } from '../set-now';
import {
  allocateNextDecisionId,
  appendDecisionToBody,
  normalizeAffects,
} from '../add-decision';
import {
  allocateNextItemId,
  appendItemToBody,
  buildItemLine,
  argsSchema as addItemArgsSchema,
} from '../add-item';
import { bumpUpdatedDate } from '../with-plan-lock';

const BASE = `---
title: t
slug: t-2026-05-20
status: active
created: 2026-05-20
updated: 2026-05-19
---

# t

## Now

**State:** old state
**Next:** old next

## Phase 1 — Tooling

- **P-001** \`done\` First item.
- **P-002** \`wip\` Second item.
- **P-003** \`todo\` Third item. blocked-by: P-002

## Decisions

### D-001 — A decision
Date: 2026-05-19
Decision text.
`;

describe('flipStatusInBody', () => {
  it('flips a known item from wip to done', () => {
    const { newBody, found, oldStatus } = flipStatusInBody(BASE, 'P-002', 'done');
    expect(found).toBe(true);
    expect(oldStatus).toBe('wip');
    expect(newBody).toContain('- **P-002** `done` Second item.');
  });

  it('preserves blocked-by + decision refs on the line', () => {
    const { newBody } = flipStatusInBody(BASE, 'P-003', 'wip');
    expect(newBody).toContain('- **P-003** `wip` Third item. blocked-by: P-002');
  });

  it('returns found=false for unknown items', () => {
    const { found } = flipStatusInBody(BASE, 'P-999', 'done');
    expect(found).toBe(false);
  });

  it('appends an optional note', () => {
    const { newBody } = flipStatusInBody(BASE, 'P-002', 'done', 'verified');
    expect(newBody).toMatch(/- \*\*P-002\*\* `done`.*\(verified\)/);
  });

  it('does not stomp other items with similar prefixes', () => {
    const doc = BASE + `\n- **P-0021** \`todo\` Different item.\n`;
    const { newBody, found } = flipStatusInBody(doc, 'P-002', 'done');
    expect(found).toBe(true);
    expect(newBody).toContain('- **P-002** `done` Second item.');
    // Untouched
    expect(newBody).toContain('- **P-0021** `todo` Different item.');
  });
});

describe('replaceNowBlock', () => {
  it('replaces an existing Now block', () => {
    const out = replaceNowBlock(BASE, 'new state', 'do X next');
    expect(out).toContain('**State:** new state');
    expect(out).toContain('**Next:** do X next');
    expect(out).not.toContain('old state');
    expect(out).not.toContain('old next');
    // Other sections preserved
    expect(out).toContain('## Phase 1 — Tooling');
    expect(out).toContain('## Decisions');
  });

  it('matches numbered Now headings', () => {
    const doc = BASE.replace('## Now', '## 3. Now');
    const out = replaceNowBlock(doc, 'replaced', 'next');
    expect(out).toContain('**State:** replaced');
  });

  it('inserts a Now block after frontmatter when missing', () => {
    const doc = `---
title: t
slug: t
status: draft
---

# t

## Phase 1

- **P-001** \`todo\` first
`;
    const out = replaceNowBlock(doc, 'fresh', 'go');
    expect(out).toContain('## Now\n\n**State:** fresh\n\n**Next:** go');
    expect(out.indexOf('## Now')).toBeLessThan(out.indexOf('## Phase 1'));
  });

  it('does not truncate at a capital Z in the Now text (\\Z is not a JS anchor)', () => {
    const doc = `---
title: t
slug: t
status: active
---

# t

## Now

**State:** Zero legacy plans remain.

**Next:** ship it

## Background

prose
`;
    const out = replaceNowBlock(doc, 'new state', 'new next');
    // Exactly one Now block; old content fully gone; no orphaned fragment.
    expect(out.match(/^## Now/gm)).toHaveLength(1);
    expect(out.match(/\*\*Next:\*\*/g)).toHaveLength(1);
    expect(out).not.toContain('Zero legacy plans remain');
    expect(out).toContain('## Background');
    expect(out).toContain('**State:** new state');
  });

  it('replaces a Now block that is the last section without duplicating it', () => {
    const doc = `---
title: t
slug: t
status: active
---

# t

## Now

**State:** old state
**Next:** old next
`;
    const out = replaceNowBlock(doc, 'new state', 'new next');
    expect(out.match(/^## Now/gm)).toHaveLength(1);
    expect(out.match(/\*\*Next:\*\*/g)).toHaveLength(1);
    expect(out).toContain('**State:** new state');
    expect(out).not.toContain('old state');
  });

  it('treats $ sequences in state/next as literal text, not replacement patterns', () => {
    const tricky = 'budget is $5, see $& and $1 literally';
    const out = replaceNowBlock(BASE, tricky, 'done');
    expect(out).toContain(tricky);
  });
});

describe('decision id allocation + append', () => {
  it('allocates the next D-NNN', () => {
    expect(allocateNextDecisionId(BASE)).toBe('D-002');
  });

  it('starts at D-001 when no decisions exist', () => {
    const doc = `---
title: t
slug: t
status: draft
---

# t
`;
    expect(allocateNextDecisionId(doc)).toBe('D-001');
  });

  it('handles non-sequential ids correctly (max+1, not count+1)', () => {
    const doc = `---
title: t
slug: t
status: draft
---

# t

## Decisions

### D-001 — first
Date: 2026-05-20
body
### D-007 — seventh
Date: 2026-05-20
body
### D-003 — third
Date: 2026-05-20
body
`;
    expect(allocateNextDecisionId(doc)).toBe('D-008');
  });

  it('appends a new decision at end of Decisions section', () => {
    const out = appendDecisionToBody(BASE, 'D-002', 'Second decision', 'Body of decision.', '2026-05-20', ['P-001']);
    expect(out).toContain('### D-002 — Second decision');
    expect(out).toContain('Date: 2026-05-20');
    expect(out).toContain('Body of decision.');
    expect(out).toContain('Related: P-001');
    // Original decision preserved
    expect(out).toContain('### D-001 — A decision');
  });

  it('creates Decisions section if missing', () => {
    const doc = `---
title: t
slug: t
status: draft
---

# t
`;
    const out = appendDecisionToBody(doc, 'D-001', 'First', 'Body.', '2026-05-20', []);
    expect(out).toContain('## Decisions');
    expect(out).toContain('### D-001 — First');
  });

  it('never appends into a suffixed heading like "## Decisions (settled)" (EI-141 / audit P-041)', () => {
    const doc = `---
title: t
slug: t
status: draft
---

# t

## Decisions (settled)

### D-001 — old settled decision
Date: 2026-05-01
settled body

## Next steps

stuff
`;
    const out = appendDecisionToBody(doc, 'D-002', 'Fresh', 'Fresh body.', '2026-05-20', []);
    // The suffixed section is untouched; a REAL ## Decisions section is created.
    const settledSection = out.slice(
      out.indexOf('## Decisions (settled)'),
      out.indexOf('## Next steps'),
    );
    expect(settledSection).not.toContain('D-002');
    expect(out).toMatch(/^## Decisions$/m);
    expect(out).toContain('### D-002 — Fresh');
  });

  it('targets the canonical ## Decisions when a suffixed heading ALSO precedes it (EI-141 exact repro)', () => {
    // The decentralized-dispatch-scaling repro: a stray `## Decisions (settled)`
    // sits ABOVE the canonical `## Decisions`. The append must land in the
    // canonical section (which the plans:get parser reads), never the suffixed
    // first-match — otherwise the decision is silently invisible.
    const doc = `---
title: t
slug: t
status: draft
---

# t

## Decisions (settled)

### D-001 — old settled decision
Date: 2026-05-01
settled body

## Decisions

### D-002 — a live decision
Date: 2026-05-10
live body

## Next steps

stuff
`;
    const out = appendDecisionToBody(doc, 'D-003', 'Fresh', 'Fresh body.', '2026-05-20', []);
    // The suffixed section is untouched…
    const settledSection = out.slice(
      out.indexOf('## Decisions (settled)'),
      out.indexOf('## Decisions\n'),
    );
    expect(settledSection).not.toContain('D-003');
    // …and the new decision lands inside the canonical ## Decisions section
    // (between its heading and the following ## Next steps).
    const canonicalStart = out.indexOf('## Decisions\n');
    const nextSection = out.indexOf('## Next steps');
    const canonicalSection = out.slice(canonicalStart, nextSection);
    expect(canonicalSection).toContain('### D-003 — Fresh');
    // No duplicate canonical heading was created.
    expect(out.match(/^## Decisions$/gm)).toHaveLength(1);
  });

  it('still matches a numbered Decisions heading ("## 5. Decisions")', () => {
    const doc = `---
title: t
slug: t
status: draft
---

# t

## 5. Decisions

### D-001 — first
Date: 2026-05-01
body
`;
    const out = appendDecisionToBody(doc, 'D-002', 'Second', 'Body.', '2026-05-20', []);
    // Appended into the existing numbered section — no new plain section.
    expect(out).not.toMatch(/^## Decisions$/m);
    expect(out.indexOf('### D-002')).toBeGreaterThan(out.indexOf('## 5. Decisions'));
  });

  it('never stacks blank lines at the insert point (EI-141 / audit P-041)', () => {
    const doc = `---
title: t
slug: t
status: draft
---

# t

## Decisions

### D-001 — first
Date: 2026-05-01
body

## Next steps

stuff
`;
    // The splice point above "## Next steps" already sits on a blank line;
    // pre-fix the block's leading \n stacked a second one.
    const out = appendDecisionToBody(doc, 'D-002', 'Second', 'Body.', '2026-05-20', []);
    expect(out).not.toContain('\n\n\n');
    // Repeated appends stay stable too (the historical drift accumulator).
    const out2 = appendDecisionToBody(out, 'D-003', 'Third', 'Body.', '2026-05-20', []);
    expect(out2).not.toContain('\n\n\n');
  });
});

describe('normalizeAffects (cross-plan affects[])', () => {
  it('returns [] for undefined / empty', () => {
    expect(normalizeAffects(undefined, 'home')).toEqual([]);
    expect(normalizeAffects([], 'home')).toEqual([]);
  });

  it('drops the home slug — a decision cannot cross-ref its own plan', () => {
    expect(normalizeAffects(['home', 'other'], 'home')).toEqual(['other']);
  });

  it('de-duplicates repeated slugs so propagation fires once each', () => {
    expect(normalizeAffects(['a', 'a', 'b', 'a'], 'home')).toEqual(['a', 'b']);
  });

  it('preserves first-seen order', () => {
    expect(normalizeAffects(['c', 'a', 'b'], 'home')).toEqual(['c', 'a', 'b']);
  });
});

describe('item id allocation + append', () => {
  it('allocates next P-NNN considering both Phase items AND decision-referenced ids', () => {
    expect(allocateNextItemId(BASE)).toBe('P-004');
  });

  it('appends to existing phase', () => {
    const itemLine = buildItemLine('P-004', 'Fourth item', ['P-002']);
    const { newBody, createdPhase } = appendItemToBody(BASE, 'Phase 1 — Tooling', itemLine);
    expect(createdPhase).toBe(false);
    expect(newBody).toContain('- **P-004** `todo` Fourth item blocked-by: P-002');
    // Order preserved
    const idx1 = newBody.indexOf('- **P-003**');
    const idx4 = newBody.indexOf('- **P-004**');
    expect(idx1).toBeLessThan(idx4);
  });

  it('creates phase section if missing, before Decisions', () => {
    const itemLine = buildItemLine('P-100', 'New phase item', []);
    const { newBody, createdPhase } = appendItemToBody(BASE, 'Phase 2 — Migration', itemLine);
    expect(createdPhase).toBe(true);
    expect(newBody).toContain('## Phase 2 — Migration');
    expect(newBody).toContain('- **P-100** `todo` New phase item');
    expect(newBody.indexOf('## Phase 2')).toBeLessThan(newBody.indexOf('## Decisions'));
  });

  it('matches numbered Phase headings tolerantly', () => {
    const doc = BASE.replace('## Phase 1 — Tooling', '## 4. Phase 1 — Tooling');
    const itemLine = buildItemLine('P-009', 'After numbered phase', []);
    const { newBody, createdPhase } = appendItemToBody(doc, 'Phase 1 — Tooling', itemLine);
    expect(createdPhase).toBe(false);
    expect(newBody).toContain('- **P-009** `todo` After numbered phase');
  });

  it('appends to an existing phase whose name ends in a non-word char (regression: \\b never matched after ")")', () => {
    // First add creates the section…
    const first = appendItemToBody(
      BASE,
      'Phase 9 — Implementation (2026-06-05)',
      buildItemLine('P-100', 'First in dated phase', []),
    );
    expect(first.createdPhase).toBe(true);
    // …the second add must APPEND to it, not create a duplicate heading.
    const second = appendItemToBody(
      first.newBody,
      'Phase 9 — Implementation (2026-06-05)',
      buildItemLine('P-101', 'Second in dated phase', []),
    );
    expect(second.createdPhase).toBe(false);
    const headings = second.newBody.match(/^## Phase 9 — Implementation \(2026-06-05\)$/gm) ?? [];
    expect(headings).toHaveLength(1);
    expect(second.newBody.indexOf('- **P-100**')).toBeLessThan(second.newBody.indexOf('- **P-101**'));
  });

  it('still refuses a prefix match on word-ending phases ("Phase 1" must not match "Phase 1b")', () => {
    const doc = BASE.replace('## Phase 1 — Tooling', '## Phase 1b — Tooling');
    const hit = appendItemToBody(doc, 'Phase 1b', buildItemLine('P-102', 'Prefix guard', []));
    expect(hit.createdPhase).toBe(false); // exact heading matched
    const miss = appendItemToBody(doc, 'Phase 1', buildItemLine('P-103', 'x', []));
    expect(miss.createdPhase).toBe(true); // "Phase 1" must NOT match "Phase 1b"
  });

  it('argsSchema rejects a phase the parser would not recognize as a phase section', () => {
    const args = { slug: 's', harness: 'all', phase: 'Implementation (2026-06-05)', text: 'x', importance: 'normal' };
    const bad = addItemArgsSchema.safeParse(args);
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.map((i) => i.message).join('\n')).toMatch(/must start with "Phase"/i);
    }
    const good = addItemArgsSchema.safeParse({ ...args, phase: 'Phase 1 — Implementation (2026-06-05)' });
    expect(good.success).toBe(true);
  });

  it('omits the importance keyword for the default (normal)', () => {
    expect(buildItemLine('P-004', 'Fourth item', [])).toBe('- **P-004** `todo` Fourth item');
    expect(buildItemLine('P-004', 'Fourth item', [], 'normal')).toBe('- **P-004** `todo` Fourth item');
  });

  it('emits importance after blocked-by for a non-default level', () => {
    expect(buildItemLine('P-004', 'Fourth item', ['P-002'], 'urgent')).toBe(
      '- **P-004** `todo` Fourth item blocked-by: P-002 importance: urgent',
    );
    expect(buildItemLine('P-005', 'Solo', [], 'high')).toBe('- **P-005** `todo` Solo importance: high');
  });
});

describe('plans:add-item importance enforcement (P-004/P-007)', () => {
  const base = { slug: 's', harness: 'all', phase: 'Phase 1 — X', text: 'do a thing' };

  it('rejects when importance is missing (no silent default)', () => {
    expect(addItemArgsSchema.safeParse(base).success).toBe(false);
  });

  it('accepts each valid importance level', () => {
    for (const lvl of ['urgent', 'high', 'normal', 'low'] as const) {
      expect(addItemArgsSchema.safeParse({ ...base, importance: lvl }).success).toBe(true);
    }
  });

  it('rejects an out-of-vocabulary importance', () => {
    expect(addItemArgsSchema.safeParse({ ...base, importance: 'critical' }).success).toBe(false);
  });
});

describe('setImportanceInBody', () => {
  it('adds an importance keyword to an item that had none', () => {
    const { newBody, found, oldImportance } = setImportanceInBody(BASE, 'P-001', 'urgent');
    expect(found).toBe(true);
    expect(oldImportance).toBe('normal');
    expect(newBody).toContain('- **P-001** `done` First item. importance: urgent');
  });

  it('preserves blocked-by and appends importance after it', () => {
    const { newBody } = setImportanceInBody(BASE, 'P-003', 'high');
    expect(newBody).toContain('- **P-003** `todo` Third item. blocked-by: P-002 importance: high');
  });

  it('replaces an existing importance value', () => {
    const doc = BASE + `\n- **P-009** \`todo\` Tunable. importance: low\n`;
    const { newBody, oldImportance } = setImportanceInBody(doc, 'P-009', 'urgent');
    expect(oldImportance).toBe('low');
    expect(newBody).toContain('- **P-009** `todo` Tunable. importance: urgent');
    expect(newBody).not.toContain('importance: low');
  });

  it('removes the keyword when set back to normal', () => {
    const doc = BASE + `\n- **P-009** \`todo\` Tunable. importance: high\n`;
    const { newBody, oldImportance } = setImportanceInBody(doc, 'P-009', 'normal');
    expect(oldImportance).toBe('high');
    expect(newBody).toContain('- **P-009** `todo` Tunable.');
    expect(newBody).not.toMatch(/P-009.*importance:/);
  });

  it('returns found=false for unknown items', () => {
    expect(setImportanceInBody(BASE, 'P-999', 'high').found).toBe(false);
  });
});

describe('bumpUpdatedDate', () => {
  it('bumps the updated field to today', () => {
    const out = bumpUpdatedDate(BASE, new Date('2026-06-15T00:00:00Z'));
    expect(out).toContain('updated: 2026-06-15');
    expect(out).not.toContain('updated: 2026-05-19');
  });

  it('inserts updated if absent', () => {
    const doc = `---
title: t
slug: t
status: draft
created: 2026-05-20
---

body`;
    const out = bumpUpdatedDate(doc, new Date('2026-06-15T00:00:00Z'));
    expect(out).toContain('updated: 2026-06-15');
  });

  it('leaves bodies without frontmatter alone', () => {
    const doc = `# no frontmatter\n\nbody`;
    expect(bumpUpdatedDate(doc)).toBe(doc);
  });
});
