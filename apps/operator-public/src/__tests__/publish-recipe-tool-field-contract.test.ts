/**
 * SENDER ↔ RECEIVER CONTRACT for a recipe's tool surface (WI-10001747).
 *
 * WHY THIS FILE EXISTS — read before changing it.
 *
 * `cupboard:publish-recipe` returned HTTP 400 on EVERY call from the day the
 * `recipe` kind was introduced until 2026-09-17. The operator sent the recipe's
 * `toolsUsed` as `provides_tools`; the Worker route accepts `provides_tools`
 * only for kinds plugin|pack and refused it as `plugin_or_pack_kind_only`. The
 * browsable `recipe` kind was therefore permanently empty.
 *
 * The reason it went undetected for so long is the interesting part, and it is
 * the thing this file guards against recurring:
 *
 *   - The RECEIVER suite (listings.test.ts) asserted the refusal — 3 sites —
 *     and was green.
 *   - The SENDER suite asserted that the operator sends the field — and was
 *     green.
 *   - Neither crossed the wire. Both sides were independently, confidently
 *     correct about a contract they disagreed on.
 *
 * WHEN BOTH SIDES OF A WIRE ARE INDEPENDENTLY GREEN, THE UNTESTED THING IS THE
 * WIRE. So this test does not re-state the field name: it READS the name out of
 * the operator's real call site and feeds THAT name to the real Worker route. If
 * someone repoints the sender, this test follows it and fails when the receiver
 * disagrees — which is exactly what nothing did before.
 *
 * Owner ruling (Avi, 2026-09-17, WI-10001747 post 205371): add a consumption-
 * shaped `uses_tools` field. `provides_tools` keeps meaning PROVISION and its
 * plugin|pack gate stays put — a recipe ORCHESTRATES tools it does not provide,
 * and overloading one column by kind would let a future installer try to resolve
 * tools the unit never supplied.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildApi } from '../routes/index.ts';
import { makeEnv, stubGithub, STUB_HEAD_SHA, stubTreeFor } from './fake-d1.ts';

const RECIPE_CORE_SRC = new URL(
  '../../../../packages/operator-core/lib/cupboard/publish-recipe-core.ts',
  import.meta.url,
);

/**
 * The field name the OPERATOR actually sends a recipe's `toolsUsed` under,
 * read from its real call site rather than re-typed here. Re-typing it is what
 * would reintroduce the original defect: a test that agrees with the sender by
 * assumption instead of by measurement.
 */
function senderToolFieldName(): string {
  const src = readFileSync(RECIPE_CORE_SRC, 'utf8');
  const m = src.match(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*exported\.manifest\.toolsUsed\s*\}/);
  if (!m?.[1]) {
    throw new Error(
      'publish-recipe-core no longer spreads `exported.manifest.toolsUsed` into the listing ' +
        'under a recognisable field. This extractor is the SENDER half of a wire contract — ' +
        'repair it to match the new call site rather than deleting this test, or the ' +
        'sender/receiver split it guards becomes invisible again (WI-10001747).',
    );
  }
  return m[1];
}

const RECIPE_BASE = {
  github_owner: 'papercupai',
  github_name: 'demo-project',
  github_url: 'https://github.com/papercupai/demo-project',
  project_ref: 'papercupai/demo-project',
};

const TOOLS = ['plans:get', 'scorecards:emit'];

function publish(
  api: ReturnType<typeof buildApi>,
  env: ReturnType<typeof makeEnv>['env'],
  body: Record<string, unknown>,
) {
  return api.request(
    '/listings',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}

function stubFor(listingRef: string, repoId: number) {
  stubGithub({
    user: { id: 5, login: 'pub' },
    repo: { id: repoId, private: false, permissions: { admin: true }, default_branch: 'main' },
    head: { sha: STUB_HEAD_SHA },
    tree: { entries: stubTreeFor(listingRef) },
  });
}

describe('recipe tool-surface: operator sender ↔ worker receiver', () => {
  let api: ReturnType<typeof buildApi>;
  beforeEach(() => {
    api = buildApi();
  });

  // Positive control for the instrument itself. If the extractor silently
  // returned nothing, the wire test below would be asserting about a field
  // named `undefined` and could pass or fail for the wrong reason.
  it('reads a tool field name out of the operator call site', () => {
    expect(senderToolFieldName()).toMatch(/^[a-z_][a-z0-9_]*$/);
  });

  it('THE WIRE: the worker ACCEPTS a recipe carrying whatever field the operator sends', async () => {
    const { env } = makeEnv();
    stubFor('my-recipe', 61);
    const field = senderToolFieldName();

    const res = await publish(api, env, {
      ...RECIPE_BASE,
      github_repository_id: 61,
      listing_kind: 'recipe',
      listing_ref: 'my-recipe',
      [field]: TOOLS,
    });

    // The failure this guards: 400 invalid_field. Surface WHICH field and why,
    // because "expected 200, got 400" alone sent the original investigation to
    // the wrong layer.
    if (res.status !== 200) {
      const j = (await res.json()) as { error?: string; field?: string; reason?: string };
      throw new Error(
        `Worker REFUSED the field the operator sends for a recipe. ` +
          `sender field=${field}; status=${res.status}; ` +
          `error=${j.error}; field=${j.field}; reason=${j.reason}. ` +
          `Sender and receiver disagree — this is WI-10001747 recurring.`,
      );
    }

    const body = (await res.json()) as { listing: Record<string, unknown> };
    expect(body.listing[field]).toBe(JSON.stringify(TOOLS));
  });

  // FALSIFIABILITY. This is the pre-fix shape verbatim. It must still be
  // refused: if this ever goes green, the provision gate has been widened to
  // recipe — the option the owner explicitly did NOT choose — and the wire test
  // above would then pass for the wrong reason.
  it('the PRE-FIX shape is still refused: provides_tools on a recipe', async () => {
    const { env } = makeEnv();
    stubFor('legacy-recipe', 62);

    const res = await publish(api, env, {
      ...RECIPE_BASE,
      github_repository_id: 62,
      listing_kind: 'recipe',
      listing_ref: 'legacy-recipe',
      provides_tools: TOOLS,
    });

    expect(res.status).toBe(400);
    const j = (await res.json()) as { field: string; reason: string };
    expect(j.field).toBe('provides_tools');
    expect(j.reason).toBe('plugin_or_pack_kind_only');
  });

  it('the sender does NOT use the provision field', () => {
    expect(senderToolFieldName()).not.toBe('provides_tools');
  });

  it('uses_tools is refused on a kind that does not orchestrate tools', async () => {
    const { env } = makeEnv();
    stubFor('bp', 63);

    const res = await publish(api, env, {
      ...RECIPE_BASE,
      github_repository_id: 63,
      listing_kind: 'blueprint',
      listing_ref: 'bp',
      uses_tools: TOOLS,
    });

    expect(res.status).toBe(400);
    const j = (await res.json()) as { field: string; reason: string };
    expect(j.field).toBe('uses_tools');
    expect(j.reason).toBe('orchestrating_kind_only');
  });

  it('uses_tools enforces the same bounds as provides_tools', async () => {
    const { env } = makeEnv();
    const bad: unknown[] = ['not-an-array', [], [''], [123], ['x'.repeat(129)]];
    for (const [i, value] of bad.entries()) {
      stubFor(`bounded-${i}`, 70 + i);
      const res = await publish(api, env, {
        ...RECIPE_BASE,
        github_repository_id: 70 + i,
        listing_kind: 'recipe',
        listing_ref: `bounded-${i}`,
        uses_tools: value,
      });
      expect(res.status, `uses_tools=${JSON.stringify(value)} should be refused`).toBe(400);
      expect((await res.json() as { field: string }).field).toBe('uses_tools');
    }
  });
});
