/**
 * Scout divergent generation (P-004, D-004) — the ideator fan-out.
 *
 * Runs N ideators over the corpus digest, each through a *distinct*
 * {@link CreativeLens} (the analogical lens additionally seeded with a distinct
 * distant domain), so the batch explores different regions of idea-space and
 * cannot collapse to the median ("forced diversity"). The roster construction is
 * a pure, testable function ({@link buildIdeatorRoster}); execution injects a
 * {@link ScoutLlmCall} (the gym:judge pattern) so the whole step unit-tests with
 * a fake call and no network.
 *
 * Output: a flat `Idea[]` (each tagged with its lens + grounded refs) handed to
 * the P-005 critics. One failed ideator never kills the batch (defensive, like
 * the change-feed's `safe()`).
 */
import type { CorpusDigest, CreativeLens, Idea, ScoutLlmCall } from './types';
import { CREATIVE_LENSES } from './types';
import {
  assignDistantDomain,
  buildIdeatorPrompt,
  digestRefSet,
  DISTANT_DOMAINS,
  type DistantDomain,
} from './lenses';

/** The default ideator model — a strong model matters for the creative leap. */
export const SCOUT_IDEATOR_MODEL = 'claude-opus-4-8';

/** One planned ideator: a lens, its within-lens index (drives domain rotation), and a global index. */
export interface IdeatorSlot {
  lens: CreativeLens;
  /** 0-based index within this lens (rotates the distant domain for analogical). */
  withinLens: number;
  /** 0-based index across the whole roster (stable id source). */
  globalIndex: number;
  /** The primed distant domain (analogical lens only). */
  seedDomain?: DistantDomain;
}

export interface BuildRosterInput {
  /** Lenses to run (default: all four; empty/duplicates normalized). */
  lenses?: readonly CreativeLens[];
  /** Base ideators per lens — floored at 1 so no lens is ever silenced (D-004). Default 1. */
  perLens?: number;
  /**
   * Per-lens win-weights (P-013 / D-009 hook): EXTRA ideators (beyond the base)
   * are distributed across lenses proportional to these weights. Never removes a
   * lens; diversity floor is preserved — weights only ADD to winning lenses.
   */
  lensWeights?: Partial<Record<CreativeLens, number>>;
  /** Total extra ideators to distribute by `lensWeights` (default 0 → weights inert). */
  extraIdeatorBudget?: number;
  /** Distant-domain pool/order for analogical ideators (default {@link DISTANT_DOMAINS}). */
  distantDomains?: readonly DistantDomain[];
}

/** Distinct, order-preserving lens list (defaults to all four). */
function normalizeLenses(lenses?: readonly CreativeLens[]): CreativeLens[] {
  const src = lenses && lenses.length > 0 ? lenses : CREATIVE_LENSES;
  const seen = new Set<CreativeLens>();
  const out: CreativeLens[] = [];
  for (const l of src) {
    if (!seen.has(l)) {
      seen.add(l);
      out.push(l);
    }
  }
  return out;
}

/**
 * Distribute `total` extra ideators across `lenses` proportional to `weights`,
 * by the largest-remainder method (stable, exact: the parts sum to `total`).
 * Lenses with no/zero weight get no extras. Returns a per-lens extra count.
 */
export function allocateExtraIdeators(
  lenses: readonly CreativeLens[],
  weights: Partial<Record<CreativeLens, number>>,
  total: number,
): Record<CreativeLens, number> {
  const out = Object.fromEntries(lenses.map((l) => [l, 0])) as Record<CreativeLens, number>;
  if (total <= 0) return out;
  const w = lenses.map((l) => Math.max(0, weights[l] ?? 0));
  const sum = w.reduce((a, b) => a + b, 0);
  if (sum <= 0) return out; // no signal → no extras
  const ideal = w.map((x) => (x / sum) * total);
  const floors = ideal.map((x) => Math.floor(x));
  let assigned = floors.reduce((a, b) => a + b, 0);
  lenses.forEach((l, i) => {
    out[l] = floors[i];
  });
  // Distribute the leftover to the largest fractional remainders.
  const remainders = lenses
    .map((l, i) => ({ l, rem: ideal[i] - floors[i] }))
    .sort((a, b) => b.rem - a.rem);
  let k = 0;
  while (assigned < total && k < remainders.length) {
    out[remainders[k].l] += 1;
    assigned += 1;
    k += 1;
  }
  return out;
}

/**
 * Build the ideator roster (pure). Guarantees the forced-diversity floor: every
 * requested lens gets ≥ `perLens` (≥1) ideators; `lensWeights`+`extraIdeatorBudget`
 * only ADD extra ideators to winning lenses. Analogical ideators rotate through
 * the distant-domain pool so even multiple analogical ideators diverge.
 */
export function buildIdeatorRoster(input: BuildRosterInput = {}): IdeatorSlot[] {
  const lenses = normalizeLenses(input.lenses);
  const perLens = Math.max(1, input.perLens ?? 1);
  const domains = input.distantDomains && input.distantDomains.length > 0 ? input.distantDomains : DISTANT_DOMAINS;

  const extras =
    input.lensWeights && (input.extraIdeatorBudget ?? 0) > 0
      ? allocateExtraIdeators(lenses, input.lensWeights, input.extraIdeatorBudget ?? 0)
      : (Object.fromEntries(lenses.map((l) => [l, 0])) as Record<CreativeLens, number>);

  const slots: IdeatorSlot[] = [];
  let globalIndex = 0;
  for (const lens of lenses) {
    const count = perLens + (extras[lens] ?? 0);
    for (let withinLens = 0; withinLens < count; withinLens++) {
      const seedDomain = lens === 'analogical' ? assignDistantDomain(withinLens, domains) : undefined;
      slots.push({ lens, withinLens, globalIndex, seedDomain });
      globalIndex++;
    }
  }
  return slots;
}

export interface RunIdeatorsOptions extends BuildRosterInput {
  llmCall: ScoutLlmCall;
  /** Max ideas each ideator may return (default 3). */
  maxIdeasPerIdeator?: number;
  /** Model id (default {@link SCOUT_IDEATOR_MODEL}). */
  model?: string;
  /** Extended-thinking budget per ideator (default none — cheaper). */
  thinkingBudgetTokens?: number;
}

/** Per-ideator outcome (forced-diversity audit + provenance + failure isolation). */
export interface IdeatorRunInfo {
  lens: CreativeLens;
  seedDomain?: string;
  globalIndex: number;
  /** Ideas kept after the grounding/shape filter. */
  produced: number;
  /** Ideas the model returned before filtering. */
  raw: number;
  ok: boolean;
  error?: string;
}

export interface RunIdeatorsResult {
  ideas: Idea[];
  perLensCounts: Record<CreativeLens, number>;
  ideators: IdeatorRunInfo[];
  costUsd: number;
}

interface RawIdea {
  title: string;
  body: string;
  mechanism: string;
  addressesPatternRefs: string[];
  seedDomain?: string;
}

/** Parse a model payload (object or text) into the `{ideas:[...]}` array, defensively. */
export function parseIdeasPayload(json: unknown, text: string): unknown[] {
  const fromJson = extractIdeasArray(json);
  if (fromJson) return fromJson;
  const parsed = tryParseJsonText(text);
  return extractIdeasArray(parsed) ?? [];
}

function extractIdeasArray(x: unknown): unknown[] | null {
  if (Array.isArray(x)) return x;
  if (x && typeof x === 'object' && Array.isArray((x as Record<string, unknown>).ideas)) {
    return (x as { ideas: unknown[] }).ideas;
  }
  return null;
}

function tryParseJsonText(text: string): unknown {
  if (!text) return null;
  const stripped = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    /* fall through to bracket extraction */
  }
  const match = stripped.match(/[[{][\s\S]*[\]}]/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      /* give up */
    }
  }
  return null;
}

/** Coerce one raw idea object; null if it lacks the required fields. */
function coerceRawIdea(x: unknown): RawIdea | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const body = typeof o.body === 'string' ? o.body.trim() : '';
  const mechanism = typeof o.mechanism === 'string' ? o.mechanism.trim() : '';
  if (!title || !body || !mechanism) return null;
  const refs = Array.isArray(o.addressesPatternRefs)
    ? o.addressesPatternRefs.filter((r): r is string => typeof r === 'string')
    : [];
  const seedDomain = typeof o.seedDomain === 'string' ? o.seedDomain : undefined;
  return { title, body, mechanism, addressesPatternRefs: refs, seedDomain };
}

/**
 * Run the ideator fan-out over `digest`. Ideators execute in parallel; each is
 * isolated (a thrown/garbled ideator yields no ideas, recorded `ok:false`,
 * without sinking the batch). Each kept idea is grounded — its
 * `addressesPatternRefs` is intersected with the digest's real refs.
 */
export async function runIdeators(digest: CorpusDigest, opts: RunIdeatorsOptions): Promise<RunIdeatorsResult> {
  const roster = buildIdeatorRoster(opts);
  const model = opts.model ?? SCOUT_IDEATOR_MODEL;
  const maxIdeas = opts.maxIdeasPerIdeator ?? 3;
  const validRefs = digestRefSet(digest);
  const thinking = opts.thinkingBudgetTokens;

  const runs = await Promise.all(
    roster.map(async (slot): Promise<{ info: IdeatorRunInfo; ideas: Idea[]; cost: number }> => {
      const { system, user } = buildIdeatorPrompt({
        lens: slot.lens,
        digest,
        seedDomain: slot.seedDomain,
        maxIdeas,
      });
      try {
        const res = await opts.llmCall({
          model,
          system,
          messages: [{ role: 'user', content: user }],
          responseFormat: 'json',
          ...(thinking ? { thinkingBudgetTokens: thinking, maxTokens: thinking + 4096 } : { maxTokens: 4096 }),
        });
        const rawArr = parseIdeasPayload(res.json, res.text);
        const ideas: Idea[] = [];
        for (let j = 0; j < rawArr.length; j++) {
          const raw = coerceRawIdea(rawArr[j]);
          if (!raw) continue;
          const grounded = raw.addressesPatternRefs.filter((r) => validRefs.has(r));
          ideas.push({
            id: `scout-idea-${slot.lens}-${slot.globalIndex}-${ideas.length}`,
            lens: slot.lens,
            title: raw.title,
            body: raw.body,
            mechanism: raw.mechanism,
            // Analogical: trust the assigned seed domain over the model's echo.
            seedDomain: slot.seedDomain?.key ?? raw.seedDomain,
            addressesPatternRefs: grounded,
          });
        }
        return {
          info: {
            lens: slot.lens,
            seedDomain: slot.seedDomain?.key,
            globalIndex: slot.globalIndex,
            produced: ideas.length,
            raw: rawArr.length,
            ok: true,
          },
          ideas,
          cost: res.costUsd ?? 0,
        };
      } catch (err) {
        return {
          info: {
            lens: slot.lens,
            seedDomain: slot.seedDomain?.key,
            globalIndex: slot.globalIndex,
            produced: 0,
            raw: 0,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          },
          ideas: [],
          cost: 0,
        };
      }
    }),
  );

  const ideas = runs.flatMap((r) => r.ideas);
  const perLensCounts = Object.fromEntries(CREATIVE_LENSES.map((l) => [l, 0])) as Record<CreativeLens, number>;
  for (const idea of ideas) perLensCounts[idea.lens] += 1;

  return {
    ideas,
    perLensCounts,
    ideators: runs.map((r) => r.info),
    costUsd: runs.reduce((a, r) => a + r.cost, 0),
  };
}
