/**
 * WI-126377 — the psu resume model picker's row builders.
 *
 * The picker itself is Inquirer-driven and effectively untestable in place, which
 * is exactly why every decision it makes lives in pure functions here: what rows
 * exist, in what order, which backend each targets, whether a spec goes through
 * the alias normalizer, and — the one that can silently produce an unlaunchable
 * spec — which reasoning efforts a model is allowed to offer.
 */
import { describe, expect, it } from 'vitest';
import {
  aliasModelRows,
  backendDefaultRows,
  buildResumeModelRows,
  codexModelRows,
  composeRegistryModelSpec,
  customModelRows,
  effortRowsFor,
  encodableEfforts,
  formatContextWindow,
  ompModelRows,
} from './su-model-menu.mjs';
import { CLOUD_MODEL_MENU, MODEL_EFFORT_LEVELS } from './agent-config-constants';
// The REAL policy list, not a copy: a rename of the retired id must keep this
// suite meaningful rather than leave it guarding a string nothing denies.
import { CODEX_DENIED_MODEL_IDS } from './model-context-budget.mjs';

/** psu's own alias rows carry `name` as `<alias> — <label>`; the parity suite in
 *  apps/operator/lib/psu-launcher.test.ts pins that shape, so deriving the
 *  fixture from CLOUD_MODEL_MENU keeps this file honest if the menu changes. */
const ALIASES = CLOUD_MODEL_MENU.map((row) => ({
  name: `${row.value} — ${row.label}`,
  value: row.value,
  backend: row.backend,
}));

const ENCODABLE = [...MODEL_EFFORT_LEVELS];

describe('encodableEfforts — the rule that keeps an unlaunchable spec off the menu', () => {
  it('DROPS a level the registry advertises that psu cannot encode', () => {
    // Both are real, measured 2026-08-27: codex advertises `ultra` on
    // gpt-5.6-sol/terra, OMP advertises `minimal` on the Claude 4.5 families.
    // psu's `:<effort>` grammar accepts neither, so a spec carrying one has its
    // suffix read as part of the MODEL ID.
    expect(encodableEfforts(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], ENCODABLE)).not.toContain('ultra');
    expect(encodableEfforts(['minimal', 'low', 'medium', 'high', 'xhigh'], ENCODABLE)).not.toContain('minimal');
  });

  it('keeps every level that IS encodable, and only those', () => {
    expect(encodableEfforts(['minimal', 'low', 'high', 'ultra'], ENCODABLE)).toEqual(['low', 'high']);
  });

  it('orders by the LAUNCHER menu, not the registry — two models never disagree on sequence', () => {
    expect(encodableEfforts(['max', 'low', 'high'], ENCODABLE)).toEqual(['low', 'high', 'max']);
  });

  it('treats "the registry did not say" as every encodable level (the pre-registry behavior)', () => {
    expect(encodableEfforts(null, ENCODABLE)).toEqual(ENCODABLE);
    expect(encodableEfforts([], ENCODABLE)).toEqual(ENCODABLE);
    expect(encodableEfforts(undefined, ENCODABLE)).toEqual(ENCODABLE);
  });

  it('is case-insensitive about what a registry advertises', () => {
    expect(encodableEfforts(['LOW', 'XHigh'], ENCODABLE)).toEqual(['low', 'xhigh']);
  });

  it('a model with NOTHING encodable yields no levels rather than falling back to all of them', () => {
    // The fallback is the dangerous repair here: it would offer five efforts for
    // a model that supports none of them.
    expect(encodableEfforts(['ultra'], ENCODABLE)).toEqual([]);
  });
});

describe('effortRowsFor', () => {
  it('always leads with the model-default row, whose value is the empty suffix', () => {
    const rows = effortRowsFor({ published: ['low'], encodable: ENCODABLE });
    expect(rows[0].value).toBe('');
    expect(rows.map((r) => r.value)).toEqual(['', 'low']);
  });

  it('collapses to the default row ALONE when the model can encode no effort', () => {
    // The caller reads a length of 1 as "skip the prompt entirely" — a one-row
    // effort select is a keystroke that cannot change anything.
    const rows = effortRowsFor({ published: ['ultra'], encodable: ENCODABLE });
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe('');
  });

  it('renders a description beside the level when one is supplied', () => {
    const rows = effortRowsFor({
      published: ['high'],
      encodable: ENCODABLE,
      describe: (level) => (level === 'high' ? 'Greater reasoning depth' : null),
    });
    expect(rows[1].name).toBe('high — Greater reasoning depth');
  });
});

describe('backendDefaultRows — "just take in claude or omp or codex"', () => {
  it('emits one row per allowed backend, carrying no model', () => {
    const rows = backendDefaultRows({ backends: ['claude', 'omp', 'codex'], sourceAgent: 'claude' });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.value)).toEqual([
      { kind: 'backend-default', targetAgent: 'claude' },
      { kind: 'backend-default', targetAgent: 'omp' },
      { kind: 'backend-default', targetAgent: 'codex' },
    ]);
  });

  it('labels the session\'s own backend Native and the others Port to', () => {
    const rows = backendDefaultRows({ backends: ['claude', 'codex'], sourceAgent: 'codex' });
    expect(rows[0].name).toContain('Port to claude');
    expect(rows[1].name).toContain('Native codex');
  });
});

describe('aliasModelRows', () => {
  it('never offers a model the target backend cannot launch (WI-4891)', () => {
    // `psu --resume` is hard-bound to the session's backend; a codex alias on a
    // claude resume produced `claude -m sol`, a broken launch.
    const rows = aliasModelRows({ aliases: ALIASES, backends: ['claude'], sourceAgent: 'claude' });
    expect(rows.every((r) => r.value.targetAgent === 'claude')).toBe(true);
    expect(rows.map((r) => r.value.model)).not.toContain('sol');
  });

  it('marks alias rows so the caller keeps the [1m]-appending composer for them', () => {
    const rows = aliasModelRows({ aliases: ALIASES, backends: ['claude'], sourceAgent: 'claude' });
    expect(rows.every((r) => r.value.alias === true)).toBe(true);
  });
});

describe('codexModelRows — the registry that made gpt-5.5 reachable without typing it', () => {
  const MODELS = [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['low', 'high', 'ultra'], contextWindow: 272_000 },
    { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], contextWindow: 272_000 },
  ];

  it('targets codex and does NOT mark rows as aliases', () => {
    const rows = codexModelRows(MODELS, { sourceAgent: 'codex' });
    expect(rows.map((r) => r.value.targetAgent)).toEqual(['codex', 'codex']);
    expect(rows.every((r) => r.value.alias === false)).toBe(true);
  });

  it('carries each model\'s OWN advertised efforts through for narrowing', () => {
    const rows = codexModelRows(MODELS, { sourceAgent: 'codex' });
    expect(rows[0].value.efforts).toEqual(['low', 'high', 'ultra']);
    expect(effortRowsFor({ published: rows[0].value.efforts, encodable: ENCODABLE }).map((r) => r.value)).toEqual([
      '',
      'low',
      'high',
    ]);
  });

  it('puts the id in the row NAME, because the picker filters on names alone', () => {
    const rows = codexModelRows(MODELS, { sourceAgent: 'codex' });
    expect(rows[1].name).toContain('gpt-5.5');
  });

  it('drops a registry row an ALIAS row already covers, so the menu holds no duplicate', () => {
    // `sol` normalizes to `gpt-5.6-sol` — one launch, two spellings. The alias
    // wins because it is the spelling psu's own flags and docs use.
    const rows = codexModelRows(MODELS, { sourceAgent: 'codex', skipIds: ['gpt-5.6-sol'] });
    expect(rows.map((r) => r.value.model)).toEqual(['gpt-5.5']);
  });

  it('matches skipIds case-insensitively rather than trusting the registry\'s casing', () => {
    const rows = codexModelRows(MODELS, { sourceAgent: 'codex', skipIds: ['GPT-5.6-SOL'] });
    expect(rows.map((r) => r.value.model)).toEqual(['gpt-5.5']);
  });

  // WI-2140343 — the picker is where a RETIRED model becomes typeable again.
  // `deniedIds` existed in codexModelRows and psu-launcher already passed
  // CODEX_DENIED_MODEL_IDS, but NOTHING asserted either: deleting the filter
  // here, or the launcher's `codexDeniedIds:` line, put gpt-5.3-codex-spark
  // back on the menu with every other test still green. The registry is not a
  // policy source — the installed Codex cache advertises models the ChatGPT
  // subscription cannot serve, which is the Spark incident itself.
  const SPARK = { id: 'gpt-5.3-codex-spark', label: 'Spark', efforts: ['low'], contextWindow: 272_000 };

  it('DROPS a denied model, so a retired id cannot be picked out of the registry', () => {
    const rows = codexModelRows([...MODELS, SPARK], { sourceAgent: 'codex', deniedIds: CODEX_DENIED_MODEL_IDS });
    expect(rows.map((r) => r.value.model)).toEqual(['gpt-5.6-sol', 'gpt-5.5']);
  });

  it('matches deniedIds case-insensitively rather than trusting the registry\'s casing', () => {
    const rows = codexModelRows([{ ...SPARK, id: 'GPT-5.3-Codex-Spark' }], {
      sourceAgent: 'codex',
      deniedIds: CODEX_DENIED_MODEL_IDS,
    });
    expect(rows).toEqual([]);
  });

  // CONTROL — proves the two assertions above are made by the FILTER, not by a
  // fixture that never contained Spark. Without this, both would still pass if
  // `deniedIds` were ignored entirely.
  it('still offers the denied model when no deny list is passed', () => {
    const rows = codexModelRows([...MODELS, SPARK], { sourceAgent: 'codex' });
    expect(rows.map((r) => r.value.model)).toContain('gpt-5.3-codex-spark');
  });
});

describe('ompModelRows', () => {
  const MODELS = [
    {
      selector: 'google-vertex/claude-fable-5@default',
      name: 'Claude Fable 5',
      provider: 'google-vertex',
      contextWindow: 1_000_000,
      reasoning: true,
      thinking: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    },
  ];

  it('does NOT mark an OMP selector as an alias — the [1m] marker must never reach it', () => {
    // psu's DEFAULT_1M_FAMILY_RE is unanchored (/fable|opus|.../), so this
    // selector MATCHES `fable`. Routing it through the alias composer would
    // produce `google-vertex/claude-fable-5@default[1m]`, a provider-qualified id
    // wearing a Claude-Code-private marker it has no syntax for.
    const rows = ompModelRows(MODELS, { sourceAgent: 'omp' });
    expect(rows[0].value.alias).toBe(false);
    expect(rows[0].value.targetAgent).toBe('omp');
    expect(rows[0].value.model).toBe('google-vertex/claude-fable-5@default');
  });

  it('folds the selector and its detail into the searchable name', () => {
    const rows = ompModelRows(MODELS, { sourceAgent: 'claude' });
    expect(rows[0].name).toContain('google-vertex/claude-fable-5@default');
    expect(rows[0].name).toContain('1M ctx');
    expect(rows[0].name).toContain('reasoning');
    expect(rows[0].name).toContain('Port to omp');
  });

  it('narrows `minimal` out of the efforts it hands the caller', () => {
    const rows = ompModelRows(MODELS, { sourceAgent: 'omp' });
    expect(effortRowsFor({ published: rows[0].value.efforts, encodable: ENCODABLE }).map((r) => r.value)).toEqual([
      '',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });
});

describe('buildResumeModelRows', () => {
  const CODEX = [{ id: 'gpt-5.5', efforts: ['high'], contextWindow: 272_000 }];
  const OMP = [{ selector: 'openrouter/~openai/gpt-5.6', thinking: ['high'], contextWindow: 400_000 }];

  it('leads with the backend defaults — a backend alone is a complete answer', () => {
    const rows = buildResumeModelRows({
      backends: ['codex'],
      sourceAgent: 'codex',
      aliases: ALIASES,
      codexModels: CODEX,
    });
    expect(rows[0].value.kind).toBe('backend-default');
  });

  it('closes with a per-backend escape, so no follow-up "which backend?" prompt is needed', () => {
    const rows = buildResumeModelRows({ backends: ['claude', 'omp', 'codex'], sourceAgent: 'claude', aliases: ALIASES });
    const escapes = rows.filter((r) => r.value.kind === 'custom');
    expect(escapes.map((r) => r.value.targetAgent)).toEqual(['claude', 'omp', 'codex']);
    expect(rows.slice(-3)).toEqual(escapes);
  });

  it('withholds a registry group whose backend this resume cannot launch', () => {
    // The owner's own case: a codex resume. It gets the codex registry and must
    // NOT get OMP selectors, which only the omp backend can launch.
    const rows = buildResumeModelRows({
      backends: ['codex'],
      sourceAgent: 'codex',
      aliases: ALIASES,
      codexModels: CODEX,
      ompModels: OMP,
    });
    expect(rows.map((r) => r.value.targetAgent)).not.toContain('omp');
    expect(rows.some((r) => r.value.kind === 'model' && r.value.model === 'gpt-5.5')).toBe(true);
  });

  it('degrades to aliases + escape when BOTH registries come back empty', () => {
    // The fail-soft contract: a missing registry costs its group, never the picker.
    const rows = buildResumeModelRows({ backends: ['codex'], sourceAgent: 'codex', aliases: ALIASES });
    expect(rows.some((r) => r.value.kind === 'backend-default')).toBe(true);
    expect(rows.some((r) => r.value.kind === 'model' && r.value.model === 'sol')).toBe(true);
    expect(rows.some((r) => r.value.kind === 'custom')).toBe(true);
  });

  it('offers strictly MORE than the four hardcoded aliases it replaced', () => {
    const aliasOnly = aliasModelRows({ aliases: ALIASES, backends: ['codex'], sourceAgent: 'codex' }).length;
    const rows = buildResumeModelRows({
      backends: ['codex'],
      sourceAgent: 'codex',
      aliases: ALIASES,
      codexModels: CODEX,
    });
    expect(rows.filter((r) => r.value.kind === 'model').length).toBeGreaterThan(aliasOnly);
  });
});

describe('composeRegistryModelSpec', () => {
  it('appends a chosen effort and nothing else', () => {
    expect(composeRegistryModelSpec({ model: 'gpt-5.5', effort: 'high' })).toBe('gpt-5.5:high');
  });

  it('leaves a provider-qualified selector byte-identical when no effort is chosen', () => {
    expect(composeRegistryModelSpec({ model: 'google-vertex/claude-fable-5@default', effort: '' })).toBe(
      'google-vertex/claude-fable-5@default',
    );
  });

  it('returns null for no model, so the caller falls back to the backend default', () => {
    expect(composeRegistryModelSpec({ model: '', effort: 'high' })).toBeNull();
    expect(composeRegistryModelSpec({ model: '   ', effort: '' })).toBeNull();
  });
});

describe('formatContextWindow', () => {
  it('renders the scales a model picker actually shows', () => {
    expect(formatContextWindow(1_000_000)).toBe('1M ctx');
    expect(formatContextWindow(272_000)).toBe('272k ctx');
    expect(formatContextWindow(900)).toBe('900 ctx');
  });

  it('says nothing rather than guessing when the registry omits the window', () => {
    expect(formatContextWindow(null)).toBeNull();
    expect(formatContextWindow(undefined)).toBeNull();
  });
});

describe('customModelRows', () => {
  it('names the backend in the row so the id is never ambiguous', () => {
    const rows = customModelRows({ backends: ['omp'], sourceAgent: 'claude' });
    expect(rows[0].value).toEqual({ kind: 'custom', targetAgent: 'omp' });
    expect(rows[0].name).toContain('Port to omp');
  });
});
