/**
 * provider-ref-expansion.test.ts — WI-10002405, plan mapping M-019.
 *
 * THE QUESTION THIS OWNS, AND WHY NO OTHER TEST ANSWERS IT.
 *
 * Plan `deterministic-tool-definition-delivery-2026-09-21` reports a byte
 * saving for compact tool-definition delivery. Part of that saving comes from
 * `$defs` dedup: a sub-schema duplicated N times is sent ONCE and pointed at
 * with `$ref`. Every byte-budget guard in this repo measures that saving on
 * OUR side of the provider boundary — `schema-ref-inline.ts` says so in terms:
 * the wire `inputSchema` "is deliberately left referenced".
 *
 * `compact-schema-catalog.test.ts` ("keeps $defs/$ref STRUCTURE resolvable
 * rather than inlining it") already guards the OUR-SIDE half: that we still
 * SEND refs. It cannot answer the other half — whether the PROVIDER expands
 * them again before the model sees them. If it does, the `$defs` share of the
 * reported saving is never realised in the context window, which is exactly
 * where the originating complaint ("the context explodes very quickly") lives,
 * and bar R-7 ("savings reported honestly and comparably") is overstating.
 *
 * THE DISTINGUISHING TEST. Two semantically identical tools, swept over N:
 *   H1 refs survive : referenced cost grows ~flat in N, inlined grows linearly
 *                     => marginal-slope ratio well BELOW 1.
 *   H0 provider expands : the two curves are indistinguishable
 *                     => ratio ~1.
 * A single N cannot separate these — any one gap is explicable as a tokenizer
 * artifact. The slope RATIO is the discriminator.
 *
 * MEASURED 2026-09-22 via the local inference gateway (claude-sonnet-4-5):
 *   N=1  bytes -6.9%  tokens -2.8%     <- $defs is a NET LOSS at N=1
 *   N=2  bytes 38.3%  tokens 16.2%
 *   N=4  bytes 62.6%  tokens 37.0%
 *   N=8  bytes 75.2%  tokens 55.2%
 *   N=16 bytes 81.5%  tokens 68.2%
 *   marginal: 30.0 tok/dup referenced vs 207.0 tok/dup inlined (ratio 0.145)
 * VERDICT: refs SURVIVE; the $defs saving is real. Two honest caveats fall out
 * and belong in any restatement of the plan's savings:
 *   (1) `$defs` for a sub-schema used ONCE costs MORE than inlining it.
 *   (2) the TOKEN saving is consistently SMALLER than the BYTE saving, so a
 *       byte figure OVERSTATES the realised context-window saving.
 *
 * FLAKE POLICY — deliberate, because this test talks to a network service and
 * a spurious red here would freeze `main` for the whole fleet. It SKIPS on any
 * unreachable-gateway / transport error, and FAILS only when it successfully
 * measured and the measurement says refs stopped surviving. "Could not measure"
 * and "measured a regression" are never conflated.
 */

import { describe, it, expect, beforeAll } from 'vitest';

const MODEL = process.env.PROBE_MODEL ?? 'claude-sonnet-4-5-20250929';
const GATEWAY_PORT = process.env.PAPERCUSP_GATEWAY_PORT ?? '8788';
const COUNT_URL = `http://127.0.0.1:${GATEWAY_PORT}/v1/messages/count_tokens`;
const GATEWAY_BEARER = 'papercusp-gateway';

/** Under H0 the ratio is ~1.0; measured under H1 it is 0.145. 0.5 sits safely
 *  between and tolerates tokenizer drift without tolerating an actual flip. */
const MAX_SLOPE_RATIO = 0.5;

const MEASUREMENT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    value: { type: 'number', description: 'The measured quantity, in the unit named by `unit`.' },
    unit: { type: 'string', description: 'The unit of measurement, e.g. bytes, tokens, milliseconds.' },
    method: { type: 'string', description: 'How the measurement was taken, precisely enough to re-run it.' },
    takenAt: { type: 'string', description: 'ISO-8601 timestamp of when the measurement was taken.' },
    confidence: {
      type: 'string',
      enum: ['measured', 'inferred', 'assumed'],
      description: 'Provenance of this number: directly measured, inferred from a measurement, or assumed.',
    },
  },
  required: ['value', 'unit', 'method'],
};

const slotsFor = (n: number) => Array.from({ length: n }, (_, i) => `slot${i + 1}`);

function inlinedSchema(n: number) {
  const slots = slotsFor(n);
  return {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(
      slots.map((s) => [s, { ...structuredClone(MEASUREMENT), description: `Measurement for ${s}.` }]),
    ),
    required: slots,
  };
}

function referencedSchema(n: number) {
  const slots = slotsFor(n);
  return {
    type: 'object',
    additionalProperties: false,
    $defs: { measurement: structuredClone(MEASUREMENT) },
    properties: Object.fromEntries(
      slots.map((s) => [s, { $ref: '#/$defs/measurement', description: `Measurement for ${s}.` }]),
    ),
    required: slots,
  };
}

const toolFor = (schema: unknown) => [
  {
    name: 'record_measurements',
    description: 'Record a batch of measurements taken during a byte-budget audit.',
    input_schema: schema,
  },
];

class GatewayUnreachable extends Error {}

async function countTokens(tools: unknown): Promise<number> {
  let res: Response;
  try {
    res = await fetch(COUNT_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${GATEWAY_BEARER}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        ...(tools ? { tools } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    // Transport-level: gateway down, DNS, timeout. NOT a verdict about refs.
    throw new GatewayUnreachable(String(err));
  }
  if (!res.ok) {
    // Auth/rate-limit/model-not-available are all "could not measure", not a regression.
    throw new GatewayUnreachable(`count_tokens ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return ((await res.json()) as { input_tokens: number }).input_tokens;
}

describe('post-provider $ref survival (WI-10002405 / M-019)', () => {
  let reachable = false;
  let skipReason = '';

  beforeAll(async () => {
    try {
      await countTokens(null);
      reachable = true;
    } catch (err) {
      skipReason = err instanceof GatewayUnreachable ? err.message : String(err);
    }
  }, 60_000);

  it(
    'the provider does NOT expand $ref: referenced tool cost grows far slower than inlined',
    async (ctx) => {
      if (!reachable) {
        // LOUD skip. A silent pass here would be a vacuous green — the exact
        // failure mode this plan is about (a narrowed measurement read as a verdict).
        ctx.skip(`inference gateway :${GATEWAY_PORT} not reachable — could not measure. ${skipReason}`);
        return;
      }

      const LOW = 2;
      const HIGH = 8;

      // The beforeAll probe only proves the gateway answered ONCE. A transient
      // upstream failure (e.g. a 502 "fetch failed") on any of the five
      // measurement calls below is the same "could not measure" condition, so it
      // gets the same LOUD skip — never a red leg, and never a vacuous pass:
      // only GatewayUnreachable is converted, and every assertion still runs on
      // a complete measurement set (WI-10005367).
      let measured: { refLow: number; refHigh: number; inlLow: number; inlHigh: number };
      try {
        const baseline = await countTokens(null);
        measured = {
          refLow: (await countTokens(toolFor(referencedSchema(LOW)))) - baseline,
          refHigh: (await countTokens(toolFor(referencedSchema(HIGH)))) - baseline,
          inlLow: (await countTokens(toolFor(inlinedSchema(LOW)))) - baseline,
          inlHigh: (await countTokens(toolFor(inlinedSchema(HIGH)))) - baseline,
        };
      } catch (err) {
        if (!(err instanceof GatewayUnreachable)) throw err;
        ctx.skip(
          `inference gateway :${GATEWAY_PORT} failed mid-measurement — could not measure. ${err.message}`,
        );
        return;
      }
      const { refLow, refHigh, inlLow, inlHigh } = measured;

      const dN = HIGH - LOW;
      const refSlope = (refHigh - refLow) / dN;
      const inlSlope = (inlHigh - inlLow) / dN;

      // POSITIVE CONTROL: the instrument must have measured something. If the
      // inlined variant does not get more expensive as duplicates are added,
      // the harness is broken and the ratio below is meaningless.
      expect(
        inlSlope,
        'positive control failed: inlined cost did not grow with N, so the instrument measured nothing',
      ).toBeGreaterThan(0);

      // THRESHOLD-POSITION CONTROL. Under H0 the provider expands $ref, so the
      // referenced curve would be indistinguishable from the inlined one and
      // the ratio would be ~1. The threshold therefore only discriminates while
      // it sits below 1 — if someone later loosens MAX_SLOPE_RATIO past that,
      // this test would keep passing while having stopped being able to detect
      // the regression it exists to catch. This asserts the constant's POSITION,
      // and deliberately does not dress that up as a measurement.
      expect(
        MAX_SLOPE_RATIO,
        'MAX_SLOPE_RATIO must stay below 1: at or above it, an expanded-refs (H0) curve would pass',
      ).toBeLessThan(1);

      // SEPARATION CONTROL, from the measured data: the two curves must be far
      // enough apart that the verdict rests on signal rather than noise. Token
      // counts are integers, so a few tokens of drift must not decide this.
      expect(
        inlSlope - refSlope,
        `curves too close to separate H1 from H0: referenced=${refSlope.toFixed(1)} inlined=${inlSlope.toFixed(1)} tok/dup`,
      ).toBeGreaterThan(5);

      const ratio = refSlope / inlSlope;

      expect(
        ratio,
        `marginal tok/dup: referenced=${refSlope.toFixed(1)} inlined=${inlSlope.toFixed(1)} ratio=${ratio.toFixed(3)}. ` +
          'A ratio near 1 means the provider now EXPANDS $ref before the model sees it, which erases the ' +
          "$defs share of this plan's reported byte saving. Re-state the reported savings with the $defs " +
          'component corrected, and see WI-10002405.',
      ).toBeLessThan(MAX_SLOPE_RATIO);
    },
    180_000,
  );
});
