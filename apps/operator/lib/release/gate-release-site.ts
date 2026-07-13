#!/usr/bin/env npx tsx
/**
 * The publish gate: does any page in this directory carry THIS BOX's identity?
 *
 * Exits 0 (clean) or 1 (leak found). `publish-release-history.sh` runs it twice —
 * once on the bytes it is about to upload, and once on the bytes the host actually
 * serves back — and refuses to publish on any hit.
 *
 * It exists as a separate entry point, rather than as a check inside the renderer,
 * because THE SCRUB AND THE GATE MUST BE ABLE TO DISAGREE. A renderer that
 * certifies its own output can only ever confirm what it already believes; this
 * re-reads the finished bytes with fresh eyes. That is not theoretical — the gate
 * has caught two real leaks the scrub was blind to (a work-item title carrying the
 * owner's home path, and plan frontmatter carrying two of his personal email
 * addresses that were not this box's git identity).
 *
 * It shares findIdentityLeaks() with the scrub deliberately: ONE implementation of
 * "what counts as identity". A gate that re-implements the rule it is checking
 * drifts from it, and a gate that has drifted is guarding nothing. What makes it an
 * independent check is not different code — it is different INPUT: the finished
 * bytes, not the intent.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { findIdentityLeaks, identityLiterals } from './release-content-scrub';

export interface SiteLeak {
  file: string;
  kind: string;
  count: number;
  /** A short excerpt around the first hit, so the fix is obvious. */
  sample: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith('.html')) out.push(full);
  }
  return out;
}

/** Pure — so the gate's own behaviour is testable without a directory of real pages. */
export function gateSite(dir: string, literals = identityLiterals()): SiteLeak[] {
  const leaks: SiteLeak[] = [];
  for (const file of walk(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const hit of findIdentityLeaks(text, literals)) {
      // Show the first occurrence in context. Without this the operator knows a page
      // is dirty but not WHERE, and the tempting next move is to hand-edit the HTML —
      // which the next regenerate silently reverts.
      const lines = text.split('\n');
      const line = lines.find((l) => findIdentityLeaks(l, literals).some((h) => h.kind === hit.kind));
      leaks.push({
        file: path.relative(dir, file),
        kind: hit.kind,
        count: hit.count,
        sample: (line ?? '').trim().slice(0, 120),
      });
    }
  }
  return leaks;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const dir = argv[0];
  if (!dir) {
    console.error('usage: gate-release-site <dir>');
    return 2;
  }
  if (!fs.existsSync(dir)) {
    console.error(`gate-release-site: ${dir} does not exist`);
    return 2;
  }

  const literals = identityLiterals();
  const leaks = gateSite(dir, literals);
  const pages = walk(dir).length;

  if (leaks.length === 0) {
    // Name what it actually checked. A gate that says only "clean" is indistinguishable
    // from a gate that checked nothing — and a gate with nothing to assert is the exact
    // failure mode that let the dead update-host ship (WI-4389).
    const kinds = [...new Set(literals.map((l) => l.kind))].join(', ');
    console.log(
      `[gate] CLEAN — ${pages} page(s) scanned for this box's identity ` +
        `(${kinds || 'no machine literals resolved'}) plus any email address or home path.`,
    );
    return 0;
  }

  console.error(`[gate] 🔴 ${leaks.length} LEAK(S) across ${pages} page(s):\n`);
  for (const l of leaks) {
    console.error(`  ${l.file}`);
    console.error(`    ${l.kind} ×${l.count}:  ${l.sample}`);
  }
  return 1;
}

// `npx tsx gate-release-site.ts <dir>` — the form the publish script calls.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exit(main());
}
