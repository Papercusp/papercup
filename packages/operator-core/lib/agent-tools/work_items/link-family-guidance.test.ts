/**
 * link-family-guidance.test.ts — pins the agent-facing link semantics that the
 * linking audit found missing (linking-notify-family-hardening P-002 + P-003):
 * the src→dst direction legend and the rel-selection guidance in
 * work_items:link, and the discoverability of create's inline links:[…]
 * (reciprocal seeAlso both ways). Source-content assertions — zero import side
 * effects; fails only if a rewording drops the semantics, not on refactors.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/link-family-guidance.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('work_items:link direction legend + rel guidance (P-002)', () => {
  it('the description states src→dst semantics for every directional rel', () => {
    const src = read('./link.ts');
    expect(src).toMatch(/src BLOCKS dst/);
    expect(src).toMatch(/src FIXES dst/);
    expect(src).toMatch(/src DUPLICATES dst/);
    expect(src).toMatch(/src INVESTIGATES dst/);
    expect(src).toMatch(/src is ABOUT dst/);
    expect(src).toMatch(/src was CAUSED-BY dst/);
    expect(src).toMatch(/`relates` is symmetric/);
  });

  it('guidance gives a use-X-when line for the descriptive rels', () => {
    const src = read('./link.ts');
    expect(src).toMatch(/`investigates` = src is the digging/);
    expect(src).toMatch(/`about` = src concerns a target/);
    expect(src).toMatch(/`relates` = worth a cross-reference/);
  });
});

describe('inline links:[…] discoverability (P-003)', () => {
  it('create guidance mentions inline links and cross-references work_items:link', () => {
    const src = read('./create.ts');
    // Accept both example spellings: the 2026-07-11 guidance rewrite (bug-filing
    // discipline) shortened the inline example to `target_id` only — P-003's contract
    // is that inline links are DISCOVERABLE from create's guidance, not the form list.
    expect(src).toMatch(/links:\[\{ rel, target_id( \| target_kind\+target_ref)? \}\]/);
    expect(src).toMatch(/work_items:link \(add typed edges to an EXISTING item/);
  });

  it('link seeAlso points back at create’s inline links (reciprocal)', () => {
    const src = read('./link.ts');
    expect(src).toMatch(/work_items:create \(its inline links:\[…\]/);
  });
});
