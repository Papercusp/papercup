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
  buildRubricFocus,
  digestRefSet,
  DISTANT_DOMAINS,
  type DistantDomain,
} from './lenses';
import { DEFAULT_SCOUT_IDEATOR_MODEL } from './models';

/** The default ideator model — a strong model matters for the creative leap. */
export const SCOUT_IDEATOR_MODEL = DEFAULT_SCOUT_IDEATOR_MODEL;
/**
 * Bound one wedged ideator GENERATION so the whole Scout cycle can still make progress.
 *
 * WI-4475: this is a GENERATION cap, NOT a wall-clock cap on the whole call — its timer starts
 * when the shared governor ADMITS the request, not when the call is enqueued. Sizing evidence
 * (measured 2026-07-13 against the live gateway, at the ideator's exact params): opus-4-8 emits
 * ~62 tok/s, so a FULL 4096-token response takes ~66s; 180s leaves ~2.7x headroom. A call that
 * blows this budget is genuinely wedged mid-stream. Queue-wait is charged to the cycle deadline
 * instead (see `RunIdeatorsOptions.cycleDeadlineMs`) — conflating the two is what made a routine
 * rate-limit pause look like transport death.
 */
export const DEFAULT_SCOUT_IDEATOR_TIMEOUT_MS = 180_000;

/**
 * Grace added to the admission backstop timer. The governor is supposed to bail on its own at
 * `governorMaxWaitMs` with an honest capacity error; this backstop only exists for a transport
 * that neither admits nor returns. The grace lets the governor's own error win that race.
 */
const ADMISSION_BACKSTOP_GRACE_MS = 5_000;

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
  /** Abort all ideator calls when the parent Scout cycle is cancelled. */
  signal?: AbortSignal;
  /**
   * Per-ideator GENERATION cap (default {@link DEFAULT_SCOUT_IDEATOR_TIMEOUT_MS}; <=0 disables).
   *
   * WI-4475: this bounds the model actually STREAMING — its timer starts when the governor
   * ADMITS the call, not when the call is enqueued. It deliberately does NOT bound the
   * admission wait (see {@link cycleDeadlineMs}); charging queue-wait against this cap is what
   * turned a survivable rate-limit pause into a hard "transport timeout" with $0 spent.
   */
  ideatorTimeoutMs?: number;
  /**
   * WI-4475 — absolute epoch-ms deadline of the OWNING Scout cycle. The ADMISSION wait
   * (queueing behind the shared rate-limit governor) is bounded by the time actually left on
   * it, so an inner call can never outlive — or eat — the cycle that owns it.
   *
   * Absent ⇒ no admission bound is imposed (the host's own default applies), which is the
   * pre-WI-4475 behavior and keeps every existing caller/test byte-identical.
   */
  cycleDeadlineMs?: number;
  /**
   * Optional gym-QD stepping-stone priming (P-012 archive→Scout): appended to
   * every ideator's grounded substrate so generation builds on the gym's
   * discovered elites. Empty/absent ⇒ cold start (no priming).
   */
  priming?: string;
  /** Dedicated crowded/empty niche guidance block (P-007). */
  nicheMapPriming?: string;
  /**
   * Per-blueprint ideator MISSION framing (P-010). Forwarded to every ideator's
   * prompt; absent ⇒ the default coding-platform framing (byte-identical).
   */
  mission?: string;
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

/**
 * Raised (by the prod cycle adapter, cycle-deps.ts) when EVERY ideator failed its
 * LLM call — a TOTAL transport death (gateway wedge / token 401 / provider stall) —
 * AND the batch produced ZERO ideas. This is deliberately distinct from a healthy
 * cycle that genuinely found nothing (ideators ran fine, returned 0 ideas): a total
 * transport failure must NOT masquerade as a benign 'no-ideas' tick. Surfacing it as
 * a thrown error lets the scheduler's catch record an `error` tick (visible in
 * scout_ticks) AND call recordFire('error') so the autoloop fire-gate backs off,
 * instead of hammering a dead gateway every cadence and logging it as quiet idle.
 * Partial failures (some ideators OK) never throw — one dead ideator never kills the
 * batch (the existing defensive contract in runIdeators).
 */
export class ScoutIdeatorsTransportError extends Error {
  readonly failedCount: number;
  readonly sample?: string;
  constructor(failedCount: number, sample?: string) {
    super(
      `scout: all ${failedCount} ideator LLM call(s) failed — transport death (0 ideas, $0 spent)` +
        (sample ? `: ${sample}` : ''),
    );
    this.name = 'ScoutIdeatorsTransportError';
    this.failedCount = failedCount;
    if (sample !== undefined) this.sample = sample;
  }
}

interface RawIdea {
  title: string;
  body: string;
  mechanism: string;
  addressesPatternRefs: string[];
  seededByRefs?: string[];
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
  const seededByRefs = Array.isArray(o.seededByRefs)
    ? [...new Set(o.seededByRefs.filter((r): r is string => typeof r === 'string' && r.trim().length > 0))]
    : [];
  const seedDomain = typeof o.seedDomain === 'string' ? o.seedDomain : undefined;
  return { title, body, mechanism, addressesPatternRefs: refs, ...(seededByRefs.length ? { seededByRefs } : {}), seedDomain };
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
  // NOV-3 (gym-unwedge-scout-novelty-2026-07-02): throughput is a novelty
  // prerequisite — 11 routed ideas ALL-TIME is no evolutionary pressure. Default
  // raised 3→4 (critics/grading remain the filter; the USD budget ceiling still
  // governs spend) and env-tunable so the owner can push higher without a deploy.
  const envMax = Number(process.env.PAPERCUSP_SCOUT_MAX_IDEAS_PER_IDEATOR);
  const maxIdeas =
    opts.maxIdeasPerIdeator ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : 4);
  const validRefs = digestRefSet(digest);
  const thinking = opts.thinkingBudgetTokens;
  // DETERMINISTIC rubric seeding (blender-self-learning-2026-07-12 P-004): when
  // the digest carries measured rubric criteria, the FIRST roster slot is
  // required to ground an idea in one of the worst-measured refs. One slot, not
  // all — the rest of the roster keeps its unforced diversity, but rubric
  // measurements now generate ideas every cycle by construction, not by hoping
  // the lane wins salience in the flat render (0/116 ever, per the WI-4250 audit).
  const rubricFocus = buildRubricFocus(digest);

  const runs = await Promise.all(
    roster.map(async (slot, slotIdx): Promise<{ info: IdeatorRunInfo; ideas: Idea[]; cost: number }> => {
      const { system, user } = buildIdeatorPrompt({
        lens: slot.lens,
        digest,
        seedDomain: slot.seedDomain,
        maxIdeas,
        ...(opts.mission ? { mission: opts.mission } : {}),
        ...(opts.priming ? { priming: opts.priming } : {}),
        ...(opts.nicheMapPriming ? { nicheMapPriming: opts.nicheMapPriming } : {}),
        ...(slotIdx === 0 && rubricFocus ? { rubricFocus } : {}),
      });
      try {
        const res = await callIdeatorLlm(
          opts,
          {
            model,
            system,
            messages: [{ role: 'user', content: user }],
            responseFormat: 'json',
            ...(thinking ? { thinkingBudgetTokens: thinking, maxTokens: thinking + 4096 } : { maxTokens: 4096 }),
          },
          slot,
        );
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
            ...(raw.seededByRefs && raw.seededByRefs.length > 0
              ? { seededByRefs: [...raw.seededByRefs] }
              : {}),
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

type ScoutLlmCallInput = Parameters<ScoutLlmCall>[0];

/**
 * WI-4475 — two budgets, not one.
 *
 * The old shape started a single 180s wall-clock timer at CALL time and raced it against
 * `llmCall`. But `llmCall` blocks (by design) in the shared rate-limit governor waiting for a
 * permit BEFORE it issues the request — so that one timer was charging QUEUE-WAIT and
 * GENERATION to the same budget. Measured 2026-07-13: opus-4-8 emits ~62 tok/s, so a FULL
 * 4096-token ideation response takes ~66s — the 180s cap has ~2.7x headroom and the call
 * CANNOT time out by generating. Every observed "Scout ideator <lens> timed out after
 * 180000ms" ($0 spent, 0 ideas) was therefore a correctly-paced capacity wait being
 * guillotined and misreported as transport death. Live governor pauses run 15s / 120s / 453s.
 *
 * So we split them:
 *   - ADMISSION  — bounded by the time actually LEFT on the owning cycle's deadline. The
 *     governor gets that as `governorMaxWaitMs` and bails with an HONEST capacity error
 *     instead of being killed by our timer. A backstop timer covers a transport that never
 *     admits and never returns.
 *   - GENERATION — the existing per-ideator cap, whose timer starts on `onAdmitted` (the
 *     instant the request is really issued) and RESETS on each retry attempt.
 *
 * Net effect: a pause shorter than the cycle's remaining budget now yields IDEAS (a bit
 * later) instead of a hard cycle failure; a pause longer than it fails fast and honestly.
 */
async function callIdeatorLlm(
  opts: RunIdeatorsOptions,
  input: ScoutLlmCallInput,
  slot: IdeatorSlot,
): Promise<Awaited<ReturnType<ScoutLlmCall>>> {
  const generationTimeoutMs =
    opts.ideatorTimeoutMs === undefined
      ? DEFAULT_SCOUT_IDEATOR_TIMEOUT_MS
      : opts.ideatorTimeoutMs;
  const hasGenerationCap = Number.isFinite(generationTimeoutMs) && generationTimeoutMs > 0;

  // The admission budget: whatever the owning cycle has left, minus a reserve so generation
  // still has room to run. No deadline ⇒ leave it to the host default (pre-WI-4475 behavior).
  const admissionBudgetMs = (() => {
    if (opts.cycleDeadlineMs === undefined || !Number.isFinite(opts.cycleDeadlineMs)) return undefined;
    const remaining = opts.cycleDeadlineMs - Date.now();
    const reserve = hasGenerationCap ? generationTimeoutMs : 0;
    return Math.max(0, remaining - reserve);
  })();

  if (!hasGenerationCap && admissionBudgetMs === undefined && !opts.signal) {
    return opts.llmCall(input);
  }

  const ctrl = new AbortController();
  let generationTimer: ReturnType<typeof setTimeout> | null = null;
  let admissionTimer: ReturnType<typeof setTimeout> | null = null;
  let parentAbort: (() => void) | null = null;
  // Assigned synchronously by the Promise executor below, before `llmCall` is ever invoked.
  let onAdmitted: () => void = () => {};

  const clearTimers = () => {
    if (generationTimer) clearTimeout(generationTimer);
    if (admissionTimer) clearTimeout(admissionTimer);
    generationTimer = null;
    admissionTimer = null;
  };

  const rejectOnAbort = new Promise<never>((_, reject) => {
    const abort = (err: Error) => {
      if (!ctrl.signal.aborted) ctrl.abort(err);
      reject(err);
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        abort(new Error(`Scout ideator ${slot.lens} aborted`));
        return;
      }
      parentAbort = () => abort(new Error(`Scout ideator ${slot.lens} aborted`));
      opts.signal.addEventListener('abort', parentAbort, { once: true });
    }

    // Backstop: the governor should bail on its own at `governorMaxWaitMs`, but if a transport
    // neither admits nor returns we must not hang until the cycle dies. The grace lets the
    // governor's own honest capacity error win the race whenever it is working.
    if (admissionBudgetMs !== undefined) {
      admissionTimer = setTimeout(
        () =>
          abort(
            new Error(
              `Scout ideator ${slot.lens} was never admitted within ${Math.trunc(admissionBudgetMs)}ms ` +
                `— no capacity within the cycle's remaining budget (not a transport timeout)`,
            ),
          ),
        admissionBudgetMs + ADMISSION_BACKSTOP_GRACE_MS,
      );
      if (typeof admissionTimer.unref === 'function') admissionTimer.unref();
    }

    // The GENERATION cap starts only once the request is actually issued.
    onAdmitted = () => {
      if (admissionTimer) {
        clearTimeout(admissionTimer);
        admissionTimer = null;
      }
      if (!hasGenerationCap) return;
      // Re-armed per attempt: a retry re-acquires a permit, so it gets a fresh budget.
      if (generationTimer) clearTimeout(generationTimer);
      generationTimer = setTimeout(
        () =>
          abort(
            new Error(
              `Scout ideator ${slot.lens} timed out after ${Math.trunc(generationTimeoutMs)}ms of GENERATION ` +
                `(admitted — the model was streaming; this is not a capacity wait)`,
            ),
          ),
        generationTimeoutMs,
      );
      if (typeof generationTimer.unref === 'function') generationTimer.unref();
    };
  });

  try {
    return await Promise.race([
      opts.llmCall({
        ...input,
        signal: ctrl.signal,
        ...(admissionBudgetMs !== undefined ? { governorMaxWaitMs: admissionBudgetMs } : {}),
        onAdmitted: () => onAdmitted(),
      }),
      rejectOnAbort,
    ]);
  } finally {
    clearTimers();
    if (parentAbort && opts.signal) opts.signal.removeEventListener('abort', parentAbort);
  }
}
