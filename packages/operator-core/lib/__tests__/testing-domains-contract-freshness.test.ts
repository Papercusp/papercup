/**
 * EI-1407 — the Tests-tab contract (`.papercusp/testing-domains.json`) must
 * never silently drift from `testing-domains-registry.ts`.
 *
 * `gen:contract:check` (scripts/gen-testing-domains-contract.ts --check) is
 * wired ONLY into GH Actions CI (.github/workflows/test.yml) — but git-sync's
 * dev-box auto-commits carry `[skip ci]`, so CI never runs on them, and the
 * local pipeline gate (green-checkpoint's `npm run test:affected`) never
 * caught a stale contract. Proven live while fixing this bug: a genuine
 * Queen→Mug / shared-hive→shared-pot registry rename had landed without a
 * regenerate, and `--check` correctly failed on it.
 *
 * This test imports the SAME pure `buildContractJson()` the CLI script uses
 * (no subprocess spawn, no duplicated generation logic — reuses the one
 * source of truth) and asserts it byte-for-byte matches the committed file,
 * so `test:affected` — which DOES run on every dev-box commit — now catches
 * drift the moment it lands, not next time someone happens to run the CLI.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-relative-packages
import { buildContractJson, TESTING_DOMAINS_CONTRACT_PATH } from '../../../../scripts/gen-testing-domains-contract';

describe('testing-domains.json contract freshness (EI-1407)', () => {
  it('matches the live registry exactly — regenerate with `npx tsx scripts/gen-testing-domains-contract.ts` if this fails', () => {
    const generated = buildContractJson();
    const committed = readFileSync(TESTING_DOMAINS_CONTRACT_PATH, 'utf8');
    expect(committed).toBe(generated);
  });
});
