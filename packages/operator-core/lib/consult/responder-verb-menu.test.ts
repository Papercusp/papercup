import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { consultReadDoorLine, consultResponderVerbMenu } from './responder-verb-menu';
import { cascadeWakeBody } from './cascade-core';
import { revivalBrief } from './get-feedback-core';

const CONSULT_DIR = resolve(dirname(fileURLToPath(import.meta.url)));

// EI-21761566265989000 — a routed reviewer answered a real consult without reading the thread,
// because every wake that routes a consult named the WRITE verbs and none named the READ door.
// These guards pin both halves: the menu says the right thing, and it is the ONLY thing that
// says it — so a sixth wake variant cannot quietly reintroduce the omission.

describe('the consult responder verb menu names the read door', () => {
  it('names conversations:get, and says what a wrong-door read looks like', () => {
    const line = consultReadDoorLine('conv-abc');
    // The door itself, addressed to THIS conversation — a reviewer should not have to construct it.
    expect(line).toContain("conversations:get { id: 'conv-abc' }");
    // The guessable name does not exist. Saying so is the whole discoverability fix: the reviewer
    // who reported this reached for `consult:read` and concluded the capability was missing.
    expect(line).toContain('consult:read');
    // ...and the SILENT half: an empty result is indistinguishable from an empty thread. Without
    // this sentence a reviewer reads "no replies" as fact and reviews without the requester's posts.
    expect(line).toMatch(/EMPTY/);
  });

  it('renders the write verbs alongside it, with per-branch qualifiers', () => {
    const menu = consultResponderVerbMenu({
      conversationId: 'conv-xyz',
      evidenceNote: 'first-principles reasoning is admissible here',
      declineNote: "if it's not your area",
    });
    expect(menu).toContain("conversations:get { id: 'conv-xyz' }");
    expect(menu).toContain('consult:reply { kind } (first-principles reasoning is admissible here)');
    expect(menu).toContain("consult:decline { reason } if it's not your area");
    expect(menu).toContain('consult:close { outcome }');
    expect(menu).toContain('Untyped conversations:post is refused.');
  });

  it('falls back to the default qualifiers when a branch does not override them', () => {
    const menu = consultResponderVerbMenu({ conversationId: 'conv-1' });
    expect(menu).toContain('consult:reply { kind } (answer requires evidence)');
    expect(menu).toContain('consult:decline { reason } only if you genuinely cannot add value');
  });
});

// Derived from the REAL builders, not from a copy of their text: if a builder stops routing
// through the menu, these fail even though the menu module itself is still perfect.
describe('every real responder wake body carries the read door', () => {
  it('the cascade advance wake does', () => {
    const body = cascadeWakeBody({
      question: 'does the cache identity strip the launcher seam?',
      conversationId: 'conv-cascade',
      position: 2,
      menuSize: 3,
      next: { ownerId: 'su-peer', score: 0.41, similarity: 0.33, via: 'minimum', liveness: 'live' },
      digest: [],
    });
    expect(body).toContain("conversations:get { id: 'conv-cascade' }");
    expect(body).toContain('consult:reply { kind }');
  });

  it('the revival brief does', () => {
    const body = revivalBrief({
      requesterId: 'su-requester',
      question: 'why did the cross-run cache always miss?',
      conversationId: 'conv-revival',
      candidate: {
        score: 0.72,
        signals: { similarity: 0.66 },
        evidence: [{ session_id: 'sess-1', turn_idx: 4, sim: 0.66 }],
      },
    });
    expect(body).toContain("conversations:get { id: 'conv-revival' }");
    // The revival brief's own trailing instruction must survive the refactor.
    expect(body).toContain('you were revived for this consult, not for a standing mission');
  });
});

// ---------------------------------------------------------------------------
// SINGLE-RENDERER guard. The bug was five hand-maintained copies of one menu, and the fix is
// only durable while there is exactly one. This is the derived half: it reads the real directory
// rather than a list someone has to remember to update.
// ---------------------------------------------------------------------------

/** The signature of a hand-rolled responder menu: the decline verb with its argument object. */
const INLINE_MENU_MARKER = 'consult:decline { reason }';

const sourceFilesRenderingTheMenu = (): string[] =>
  readdirSync(CONSULT_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'responder-verb-menu.ts')
    .filter((f) => readFileSync(join(CONSULT_DIR, f), 'utf8').includes(INLINE_MENU_MARKER))
    .sort();

describe('the verb menu has exactly one renderer', () => {
  // CALIBRATION. Without this the guard below passes vacuously if the marker stops matching
  // anything at all — an empty result set is a subset of an empty expectation, and reads exactly
  // like "no file hand-rolls the menu". Prove the marker still describes the real menu first.
  it('the marker actually appears in the one legitimate renderer (positive control)', () => {
    const canonical = readFileSync(join(CONSULT_DIR, 'responder-verb-menu.ts'), 'utf8');
    expect(canonical).toContain(INLINE_MENU_MARKER);
    // ...and the directory scan really is looking at a populated directory.
    const scanned = readdirSync(CONSULT_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(scanned.length).toBeGreaterThanOrEqual(5);
    expect(scanned).toContain('get-feedback-core.ts');
    expect(scanned).toContain('cascade-core.ts');
    expect(scanned).toContain('consult-verbs-core.ts');
  });

  it('no other consult source renders the responder menu inline', () => {
    expect(sourceFilesRenderingTheMenu()).toEqual([]);
  });

  // FALSIFIABILITY CONTROL, kept permanently rather than proven once by mutating the shared tree
  // (a probe that edits a tracked file can be committed by the git-sync sweep even when nothing
  // goes wrong). This replays the exact predicate against a source that hand-rolls the menu — the
  // shape all five sites had before the fix — and asserts it is caught.
  it('the same predicate catches a hand-rolled sixth copy (control)', () => {
    const SYNTHETIC_SIXTH_WAKE = [
      'export function newRoutingWakeBody(conversationId: string): string {',
      '  return (',
      '    `You were routed a consult.\\n` +',
      '    `Reply in conversation ${conversationId} with consult:reply { kind } (answer requires evidence); ` +',
      '    `consult:decline { reason } only if you genuinely cannot add value; consult:close { outcome } when settled.`',
      '  );',
      '}',
    ].join('\n');
    expect(SYNTHETIC_SIXTH_WAKE.includes(INLINE_MENU_MARKER)).toBe(true);
    // ...and it does NOT fire on a file that merely mentions the verb without rendering the menu,
    // so the guard is a menu detector rather than a `consult:decline` word detector.
    const MERE_MENTION = 'hint: "To end the consult, use consult:close or consult:decline (responder)."';
    expect(MERE_MENTION.includes(INLINE_MENU_MARKER)).toBe(false);
  });
});
