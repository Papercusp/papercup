/**
 * Every model the platform is CONFIGURED to select must have a usage price
 * (WI-10004506, the class behind WI-10004502).
 *
 * WI-10004502: the Scout ideator ran `gpt-5.4:medium`, but
 * `@papercusp/model-pricing` had no `gpt-5.4` row. `llm-client`'s Codex path
 * refuses an unpriced model (`Codex model has no registered usage price`), so
 * every ideation cycle died before it was sent. Nothing failed in CI: the model
 * was declared in `CODEX_EXTENDED_WINDOW_FALLBACK` and the gateway's Codex
 * lineup, and the price table is a separate module. The first signal was the
 * Scout's error-streak alarm after three failed cycles in production.
 *
 * This test closes that gap by DERIVING the population from the code that
 * declares selectable models — never from a second hand-kept list (derived-truth
 * ladder, rung 1). Adding a model to any of these sources without a price now
 * fails here instead of in a live agent:
 *
 *   • `CODEX_SAFE_DEFAULT_MODEL` — the managed Codex launch default.
 *   • `CODEX_EXTENDED_WINDOW_FALLBACK` — every Codex id papercusp launches at an
 *     extended window (this is where `gpt-5.4` lived).
 *   • `CODEX_GATEWAY_FALLBACK_LINEUP` — every Codex model the gateway advertises
 *     on `/v1/models` (this is where the unpriced `gpt-5.4-mini` was found).
 *   • `CLOUD_MODEL_MENU` — the canonical picker aliases. Codex aliases resolve
 *     through `normalizeCodexCliModel`; Claude aliases through the gateway's own
 *     `resolveGatewayModel` (the `[1m]` marker is what the gateway resolves).
 *   • `DEFAULT_MODEL_TIERS`, `PAPERCUP_CHAT_MODEL_PIN`, `PAPERCUP_CHAT_FAILOVER`
 *     — committed model specs that spawn real sessions.
 *   • `LEARNING_MODEL_SPEC`, `DEFAULT_SCOUT_MODELS` — the background learning and
 *     Scout defaults, which call llm-client's pricing-gated path directly.
 *
 * Runtime overrides (owner-steering `modelOverrides`, per-role DB config) are
 * NOT visible to a static test; they are the remaining gap and are covered at
 * the call site by llm-client's refusal plus the Scout error-streak alarm.
 */
import { describe, expect, it } from 'vitest';
import { priceFor } from '@papercusp/model-pricing';
import {
  CLOUD_MODEL_MENU,
  DEFAULT_MODEL_TIERS,
  PAPERCUP_CHAT_FAILOVER,
  PAPERCUP_CHAT_MODEL_PIN,
  type AgentBackend,
} from './agent-config-constants';
import {
  CODEX_DENIED_MODEL_IDS,
  CODEX_EXTENDED_WINDOW_FALLBACK,
  CODEX_SAFE_DEFAULT_MODEL,
  normalizeCodexCliModel,
} from './model-context-budget.mjs';
import { CODEX_GATEWAY_FALLBACK_LINEUP, resolveGatewayModel } from './inference-gateway/gateway';
import { LEARNING_MODEL_SPEC } from './learning/model-policy';
import { DEFAULT_SCOUT_MODELS } from './scout/models';

/**
 * Claude picker aliases the GATEWAY does not resolve to an upstream id: the
 * Claude CLI resolves them itself and the transcript reports the concrete id.
 * This is a judgment list (rung 4), kept so a NEW unresolvable alias is a
 * visible decision rather than a silent hole in the population below.
 */
const CLI_RESOLVED_CLAUDE_ALIASES = ['haiku'] as const;

type Population = Map<string, Set<string>>;

function add(pop: Population, model: string, source: string): void {
  const sources = pop.get(model) ?? new Set<string>();
  sources.add(source);
  pop.set(model, sources);
}

/** Resolve one committed spec to the concrete id usage is priced under, or null when only the CLI can resolve it. */
function concreteModel(spec: string, backend: AgentBackend | 'claude'): string | null {
  if (backend === 'codex') return normalizeCodexCliModel(spec);
  const marked = spec.includes('[1m]') ? spec : spec.replace(/(:[a-z]+)?$/i, '[1m]$1');
  const resolved = resolveGatewayModel(marked).model;
  return /^claude-/i.test(resolved) ? resolved : null;
}

function configuredModels(): { population: Population; cliResolved: string[] } {
  const pop: Population = new Map();
  const cliResolved: string[] = [];
  const addSpec = (spec: string, backend: AgentBackend | 'claude', source: string) => {
    const model = concreteModel(spec, backend);
    if (model) add(pop, model, source);
    else cliResolved.push(spec.replace(/\[1m\]|:[a-z]+$/gi, ''));
  };

  add(pop, CODEX_SAFE_DEFAULT_MODEL, 'CODEX_SAFE_DEFAULT_MODEL');
  for (const id of Object.keys(CODEX_EXTENDED_WINDOW_FALLBACK)) add(pop, id, 'CODEX_EXTENDED_WINDOW_FALLBACK');
  for (const entry of CODEX_GATEWAY_FALLBACK_LINEUP) add(pop, entry.slug, 'CODEX_GATEWAY_FALLBACK_LINEUP');
  for (const row of CLOUD_MODEL_MENU) {
    addSpec(row.value, row.backend === 'codex' ? 'codex' : 'claude', `CLOUD_MODEL_MENU:${row.value}`);
  }
  for (const tier of DEFAULT_MODEL_TIERS) {
    addSpec(tier.spec, tier.backend ?? 'claude', `DEFAULT_MODEL_TIERS:${tier.name}`);
  }
  addSpec(PAPERCUP_CHAT_MODEL_PIN.model, PAPERCUP_CHAT_MODEL_PIN.backend, 'PAPERCUP_CHAT_MODEL_PIN');
  for (const [failed, alt] of Object.entries(PAPERCUP_CHAT_FAILOVER)) {
    if (alt) addSpec(alt.model, alt.backend, `PAPERCUP_CHAT_FAILOVER:${failed}`);
  }
  // Background learning loops and every Scout phase call llm-client directly, the
  // exact path that refused the unpriced gpt-5.4 in WI-10004502. Their specs carry
  // a raw provider id (llm-client picks the backend from it), so no alias resolution.
  add(pop, LEARNING_MODEL_SPEC, 'LEARNING_MODEL_SPEC');
  for (const [phase, spec] of Object.entries(DEFAULT_SCOUT_MODELS)) add(pop, spec, `DEFAULT_SCOUT_MODELS:${phase}`);
  // A denied model is refused at launch, so it is not selectable and owes no price.
  for (const denied of CODEX_DENIED_MODEL_IDS) pop.delete(denied);
  return { population: pop, cliResolved: [...new Set(cliResolved)].sort() };
}

/** The checker under test: every model in the population that `priceFor` cannot resolve. */
function unpriced(pop: Population): string[] {
  return [...pop.entries()]
    .filter(([model]) => priceFor(model) === null)
    .map(([model, sources]) => `${model} (from ${[...sources].sort().join(', ')})`)
    .sort();
}

describe('configured models are priced (WI-10004506)', () => {
  it('calibration: the population is derived from code and contains the WI-10004502 model', () => {
    const { population } = configuredModels();
    expect(population.size).toBeGreaterThanOrEqual(8);
    // The incident model must be IN the population, or this guard could not have caught WI-10004502.
    expect([...(population.get('gpt-5.4') ?? [])]).toContain('CODEX_EXTENDED_WINDOW_FALLBACK');
    expect([...(population.get('gpt-5.4') ?? [])]).toContain('CODEX_GATEWAY_FALLBACK_LINEUP');
    expect(population.has('gpt-5.4-mini')).toBe(true);
    // Every family the picker offers reaches the population (or the explicit CLI-resolved list).
    expect(population.has('gpt-5.6-luna')).toBe(true);
    expect([...population.keys()].some((m) => m.startsWith('claude-opus'))).toBe(true);
  });

  it('negative control: the checker reports a model with no price, naming its source', () => {
    const pop: Population = new Map();
    add(pop, 'gpt-99-unpriced-control', 'control');
    add(pop, 'gpt-5.5', 'control');
    expect(unpriced(pop)).toEqual(['gpt-99-unpriced-control (from control)']);
  });

  it('every configured model resolves to a @papercusp/model-pricing entry', () => {
    // A failure here means a model was added to a selectable source without a price.
    // Add its list price to libs/generic/model-pricing/src/index.ts (with the URL and
    // date you verified it), never a fallback to an older family's price.
    expect(unpriced(configuredModels().population)).toEqual([]);
  });

  it('only the known CLI-resolved Claude aliases escape gateway resolution', () => {
    expect(configuredModels().cliResolved).toEqual([...CLI_RESOLVED_CLAUDE_ALIASES]);
  });
});
