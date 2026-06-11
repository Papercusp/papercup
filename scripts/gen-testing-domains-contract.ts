/**
 * gen-testing-domains-contract.ts — regenerate .papercusp/testing-domains.json
 * from the operator's testing-domains registry (the single source of truth).
 *
 * The papercup dogfood harness's Tests tab (/adv) reads its domains from
 * `<worktree>/.papercusp/testing-domains.json` (see
 * apps/operator/lib/endpoint-route/routes/harness/testing.ts). Before this
 * script that file was hand-maintained in parallel with
 * testing-domains-registry.ts — a dual source of truth that silently drifted
 * (half the suite became invisible in the tab). This makes the registry
 * canonical and the contract a derived artifact.
 *
 *   Run:  npx tsx scripts/gen-testing-domains-contract.ts          (write)
 *         npx tsx scripts/gen-testing-domains-contract.ts --check  (CI: fail if stale)
 *
 * Contract tier scheme is the harness Tests tab's two-tier grouping
 * ({universal, project}) — NOT the registry's internal quick/domain/surface
 * tiers. Universal = the portable/built-in domains that apply to any project;
 * everything else is "This Harness". Acceptance (VAL-covering tests from
 * .papercusp/tests.json) is appended; it has no globs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminRegistry } from '@papercusp/operator-core/lib/testing-domains-registry.ts';
import {
  ACCEPTANCE_DOMAIN_ID,
  HARNESS_TESTING_TIER_LABELS,
} from '@papercusp/operator-core/lib/harness-testing-registry.ts';
import type { TestDomain } from '@papercusp/operator-core/lib/testing-domains.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO_ROOT, '.papercusp', 'testing-domains.json');

// The harness Tests tab's "Universal" tier = the portable/built-in domains.
// Everything else renders under "This Harness". (live-web/chaos-web are
// panel-only universal tabs with no registry domain — the Tests tab appends
// them client-side from UNIVERSAL_TESTING_TABS, so they never appear here.)
const UNIVERSAL_IDS = new Set(['test-runs', 'chaos-desktop', 'ai-explore', 'routes']);

// Display order: universal group first (fixed order), then the rest in
// registry order, then acceptance last.
const UNIVERSAL_ORDER = ['test-runs', 'chaos-desktop', 'ai-explore', 'routes'];

const byId = new Map<string, TestDomain>(adminRegistry.map((d) => [d.id, d]));

const ACCEPTANCE_DOMAIN: TestDomain = {
  id: ACCEPTANCE_DOMAIN_ID,
  label: 'Acceptance',
  description: 'VAL-covering tests written by the tester (from .papercusp/tests.json).',
  tier: 'project',
  sections: [{ id: 'all', label: 'All VALs' }],
};

function serializeDomain(d: TestDomain): unknown {
  const tier = UNIVERSAL_IDS.has(d.id) ? 'universal' : 'project';
  return {
    id: d.id,
    label: d.label,
    description: d.description,
    tier,
    sections: d.sections.map((s) => {
      const out: Record<string, unknown> = { id: s.id, label: s.label };
      if (s.description !== undefined) out.description = s.description;
      if (s.globs !== undefined) out.globs = s.globs;
      if (s.runners !== undefined) out.runners = s.runners;
      return out;
    }),
  };
}

const ordered: TestDomain[] = [];
for (const id of UNIVERSAL_ORDER) {
  const d = byId.get(id);
  if (d) ordered.push(d);
}
for (const d of adminRegistry) {
  if (!UNIVERSAL_IDS.has(d.id)) ordered.push(d);
}

const contract = {
  _comment:
    'Harness-owned test-domain contract for the papercup dogfood harness. GENERATED from testing-domains-registry.ts by scripts/gen-testing-domains-contract.ts — do not hand-edit. Run `npx tsx scripts/gen-testing-domains-contract.ts` after changing domains.',
  domains: [...ordered.map(serializeDomain), serializeDomain(ACCEPTANCE_DOMAIN)],
  tierLabels: HARNESS_TESTING_TIER_LABELS,
};

const json = JSON.stringify(contract, null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== json) {
    process.stderr.write(
      '✗ .papercusp/testing-domains.json is stale. Run: npx tsx scripts/gen-testing-domains-contract.ts\n',
    );
    process.exit(1);
  }
  process.stdout.write('✓ .papercusp/testing-domains.json is up to date\n');
} else {
  writeFileSync(OUT, json);
  process.stdout.write(`✓ wrote ${contract.domains.length} domains to .papercusp/testing-domains.json\n`);
}
