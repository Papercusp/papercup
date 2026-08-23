import { describe, expect, it } from 'vitest';
import {
  formatConformanceReport,
  runSocialAdapterConformance,
  type SocialConformanceHarness,
} from './conformance';
import type {
  SocialAdapter,
  SocialReconcileContext,
  SocialReconcileResult,
} from './adapter-contract';
import { SOCIAL_POST_SCHEMA_FIXTURE } from './social-post-schema.fixture';

/**
 * A conformance kit nobody has seen FAIL is not a guarantee — it is a suite that
 * returns ok:true, which is also what a kit with a typo in every assertion
 * returns. So this file keeps deliberately-WRONG adapters permanently, one per
 * failure mode, and asserts the kit catches each. The correct adapter below is
 * the calibration case: if the broken controls fail but the correct one does
 * not pass, the kit is simply rejecting everything, which proves nothing.
 *
 * This is the "module you import" tier of the repo's falsifiability guidance —
 * controls live in the test file, and nothing mutates the shared tree.
 */

/** The canonical social-post schema. Kept in its own module so
 *  `conformance.integration.test.ts` can assert it still matches the registry
 *  row in a real database — a registry change cannot silently invalidate these
 *  unit runs, it turns them red. */
const SOCIAL_POST_SCHEMA = SOCIAL_POST_SCHEMA_FIXTURE;

/**
 * A deliberately LOW-ENTROPY marker standing in for the adapter's credential.
 * The check only needs a distinctive string that must never appear in emitted
 * output, so this is written as an obvious canary rather than a realistic-looking
 * token: a secret-shaped literal in a tree file is auto-committed to shared git
 * history within minutes by git-sync, and the repo's secrets guard rightly
 * refuses one even when it is a fixture.
 */
const CREDENTIAL_CANARY = 'CREDENTIAL-CANARY-MUST-NOT-APPEAR-IN-OUTPUT';

interface FakeItem {
  id: string;
  seq: number;
  text: string;
  version: number;
  createdAt: string;
}

interface FakeWorld {
  items: FakeItem[];
  nextSeq: number;
  expireNextCursor: boolean;
  rateLimitNext: boolean;
}

function makeWorld(): FakeWorld {
  return { items: [], nextSeq: 1, expireNextCursor: false, rateLimitNext: false };
}

function publish(world: FakeWorld, count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const seq = world.nextSeq++;
    const id = `post-${seq}`;
    world.items.push({
      id,
      seq,
      text: `hello from ${id}`,
      version: 1,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    });
    ids.push(id);
  }
  return ids;
}

function toPayload(item: FakeItem): Record<string, unknown> {
  return {
    id: item.id,
    text: item.text,
    url: `https://fake.example/${item.id}`,
    author: 'did:example:owner',
    occurredAt: item.createdAt,
  };
}

function cursorSeq(cursor: unknown | null): number {
  if (cursor && typeof cursor === 'object' && 'seq' in cursor) {
    const seq = (cursor as { seq: unknown }).seq;
    if (typeof seq === 'number') return seq;
  }
  return 0;
}

/**
 * The reference implementation: a correct adapter for a platform with a bounded
 * cursor window, i.e. the Bluesky shape. Everything the kit asks for and
 * nothing more.
 */
class CorrectAdapter implements SocialAdapter {
  readonly platformId = 'bluesky' as const;
  constructor(protected world: FakeWorld) {}

  protected keyFor(item: FakeItem): string {
    return `fake:${item.id}:v${item.version}`;
  }

  async reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult> {
    if (this.world.rateLimitNext) {
      // Stand in for observing a 429 and honouring its backoff before retrying.
      this.world.rateLimitNext = false;
    }

    const maxSeq = this.world.items.reduce((max, item) => Math.max(max, item.seq), 0);

    if (ctx.cursor === null) {
      return this.emitAll(ctx, 'cold-start', maxSeq);
    }

    if (this.world.expireNextCursor) {
      // The provider refused the stored cursor as older than its retention
      // window. A bounded re-read is the only way to close the gap; starting
      // from live here is the silent-loss bug the kit exists to catch.
      this.world.expireNextCursor = false;
      const result = await this.emitAll(ctx, 'backfill', maxSeq);
      return { ...result, backfillReason: 'cursor-expired' };
    }

    const since = cursorSeq(ctx.cursor);
    const pending = this.world.items.filter((item) => item.seq > since);
    for (const item of pending) {
      await ctx.emit({
        externalId: item.id,
        event: 'post',
        occurredAt: item.createdAt,
        payload: toPayload(item),
        dedupeKey: this.keyFor(item),
      });
    }
    return {
      cursor: { seq: maxSeq },
      emitted: pending.length,
      path: pending.length > 0 ? 'cursor-replay' : 'live-only',
    };
  }

  protected async emitAll(
    ctx: SocialReconcileContext,
    path: SocialReconcileResult['path'],
    maxSeq: number,
  ): Promise<SocialReconcileResult> {
    for (const item of this.world.items) {
      await ctx.emit({
        externalId: item.id,
        event: 'post',
        occurredAt: item.createdAt,
        payload: toPayload(item),
        dedupeKey: this.keyFor(item),
      });
    }
    return { cursor: { seq: maxSeq }, emitted: this.world.items.length, path };
  }
}

function harnessFor(
  make: (world: FakeWorld) => SocialAdapter,
): SocialConformanceHarness<FakeWorld> {
  return {
    async create() {
      const world = makeWorld();
      return { adapter: make(world), world };
    },
    async publish(world, count) {
      return publish(world, count);
    },
    async expireCursor(world) {
      world.expireNextCursor = true;
    },
    async rateLimitOnce(world) {
      world.rateLimitNext = true;
    },
    secret: CREDENTIAL_CANARY,
    payloadSchema: SOCIAL_POST_SCHEMA,
  };
}

describe('social adapter conformance kit', () => {
  it('CALIBRATION: a correct adapter passes every check', async () => {
    const report = await runSocialAdapterConformance(harnessFor((w) => new CorrectAdapter(w)));
    expect(formatConformanceReport(report)).toContain('checks passed');
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    // If the kit ever stops actually running its checks, ok:true becomes
    // meaningless — so pin that the checks ran.
    expect(report.checksRun).toContain('cursor-unusable-falls-back-to-backfill');
    expect(report.checksRun).toContain('offline-gap-closed-exactly-once');
    expect(report.checksRun.length).toBeGreaterThanOrEqual(7);
  });

  it('skips — and SAYS it skipped — checks the harness cannot support', async () => {
    // A skipped check must never be indistinguishable from a passed one.
    const base = harnessFor((w) => new CorrectAdapter(w));
    const limited: SocialConformanceHarness<FakeWorld> = {
      ...base,
      expireCursor: undefined,
      rateLimitOnce: undefined,
    };
    const report = await runSocialAdapterConformance(limited);
    expect(report.ok).toBe(true);
    expect(report.checksRun).not.toContain('cursor-unusable-falls-back-to-backfill');
    expect(report.checksSkipped.map((s) => s.check)).toContain('cursor-unusable-falls-back-to-backfill');
    expect(formatConformanceReport(report)).toContain('skipped');
  });

  describe('CONTROLS — each broken adapter must be caught by its own check', () => {
    it('catches an adapter that starts from live when the cursor is refused', async () => {
      // The headline failure mode from D-005: it emits zero events and looks
      // exactly like "nothing happened while we were away".
      class LosesTheGap extends CorrectAdapter {
        override async reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult> {
          if (this.world.expireNextCursor) {
            this.world.expireNextCursor = false;
            const maxSeq = this.world.items.reduce((m, i) => Math.max(m, i.seq), 0);
            return { cursor: { seq: maxSeq }, emitted: 0, path: 'live-only' };
          }
          return super.reconcile(ctx);
        }
      }
      const report = await runSocialAdapterConformance(harnessFor((w) => new LosesTheGap(w)));
      expect(report.ok).toBe(false);
      expect(report.failures.map((f) => f.check)).toContain('cursor-unusable-falls-back-to-backfill');
    });

    it('catches an adapter that re-emits everything on every pass', async () => {
      class IgnoresCursor extends CorrectAdapter {
        override async reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult> {
          const maxSeq = this.world.items.reduce((m, i) => Math.max(m, i.seq), 0);
          return this.emitAll(ctx, 'cold-start', maxSeq);
        }
      }
      const report = await runSocialAdapterConformance(harnessFor((w) => new IgnoresCursor(w)));
      expect(report.ok).toBe(false);
      expect(report.failures.map((f) => f.check)).toContain('no-op-reconcile-emits-nothing');
    });

    it('catches an adapter that drops events published during the gap', async () => {
      class DropsGapEvents extends CorrectAdapter {
        override async reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult> {
          if (ctx.cursor === null) return super.reconcile(ctx);
          const maxSeq = this.world.items.reduce((m, i) => Math.max(m, i.seq), 0);
          // Advances the cursor without emitting: the gap vanishes silently.
          return { cursor: { seq: maxSeq }, emitted: 0, path: 'live-only' };
        }
      }
      const report = await runSocialAdapterConformance(harnessFor((w) => new DropsGapEvents(w)));
      expect(report.ok).toBe(false);
      expect(report.failures.map((f) => f.check)).toContain('offline-gap-closed-exactly-once');
    });

    it('catches a dedupe key built from a changing counter rather than provider facts', async () => {
      // Looks perfect on one run. Defeats replay dedupe entirely on the second.
      let tick = 0;
      class UnstableKey extends CorrectAdapter {
        protected override keyFor(item: FakeItem): string {
          tick += 1;
          return `fake:${item.id}:${tick}`;
        }
      }
      const report = await runSocialAdapterConformance(harnessFor((w) => new UnstableKey(w)));
      expect(report.ok).toBe(false);
      expect(report.failures.map((f) => f.check)).toContain('dedupe-keys-unique-and-stable');
    });

    it('catches an adapter that leaks the credential into an emitted payload', async () => {
      class LeaksCredential extends CorrectAdapter {
        override async reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult> {
          const maxSeq = this.world.items.reduce((m, i) => Math.max(m, i.seq), 0);
          for (const item of this.world.items) {
            await ctx.emit({
              externalId: item.id,
              event: 'post',
              occurredAt: item.createdAt,
              payload: { ...toPayload(item), fetchedWith: CREDENTIAL_CANARY },
              dedupeKey: this.keyFor(item),
            });
          }
          return { cursor: { seq: maxSeq }, emitted: this.world.items.length, path: 'cold-start' };
        }
      }
      const report = await runSocialAdapterConformance(harnessFor((w) => new LeaksCredential(w)));
      expect(report.ok).toBe(false);
      expect(report.failures.map((f) => f.check)).toContain('credential-never-emitted');
    });

    it('catches a payload that does not satisfy the canonical social-post schema', async () => {
      class BadPayload extends CorrectAdapter {
        override async reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult> {
          const maxSeq = this.world.items.reduce((m, i) => Math.max(m, i.seq), 0);
          for (const item of this.world.items) {
            const { text: _dropped, ...withoutRequiredText } = toPayload(item);
            await ctx.emit({
              externalId: item.id,
              event: 'post',
              occurredAt: item.createdAt,
              payload: withoutRequiredText,
              dedupeKey: this.keyFor(item),
            });
          }
          return { cursor: { seq: maxSeq }, emitted: this.world.items.length, path: 'cold-start' };
        }
      }
      const report = await runSocialAdapterConformance(harnessFor((w) => new BadPayload(w)));
      expect(report.ok).toBe(false);
      expect(report.failures.map((f) => f.check)).toContain('payload-matches-canonical-datatype');
    });

    it('catches a backfill that does not say why it backfilled', async () => {
      class SilentBackfill extends CorrectAdapter {
        override async reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult> {
          const result = await super.reconcile(ctx);
          if (result.path === 'backfill') {
            const { backfillReason: _omitted, ...withoutReason } = result;
            return withoutReason;
          }
          return result;
        }
      }
      const report = await runSocialAdapterConformance(harnessFor((w) => new SilentBackfill(w)));
      expect(report.ok).toBe(false);
      expect(report.failures.map((f) => f.check)).toContain('cursor-unusable-falls-back-to-backfill');
    });

    it('catches a result whose emitted count disagrees with what it emitted', async () => {
      class MiscountsEmissions extends CorrectAdapter {
        override async reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult> {
          const result = await super.reconcile(ctx);
          return { ...result, emitted: result.emitted + 1 };
        }
      }
      const report = await runSocialAdapterConformance(harnessFor((w) => new MiscountsEmissions(w)));
      expect(report.ok).toBe(false);
      expect(report.failures.map((f) => f.check)).toContain('cold-start');
    });
  });

  it('reports EVERY failure rather than stopping at the first', async () => {
    // A kit that returns after one finding makes fixing an adapter an N-round
    // guessing game.
    let tick = 0;
    class ThoroughlyBroken extends CorrectAdapter {
      override async reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult> {
        const maxSeq = this.world.items.reduce((m, i) => Math.max(m, i.seq), 0);
        for (const item of this.world.items) {
          const { text: _dropped, ...bad } = toPayload(item);
          tick += 1;
          await ctx.emit({
            externalId: item.id,
            event: 'post',
            payload: { ...bad, leaked: CREDENTIAL_CANARY },
            dedupeKey: `fake:${item.id}:${tick}`,
          });
        }
        return { cursor: { seq: maxSeq }, emitted: this.world.items.length, path: 'cold-start' };
      }
    }
    const report = await runSocialAdapterConformance(harnessFor((w) => new ThoroughlyBroken(w)));
    const checks = new Set(report.failures.map((f) => f.check));
    expect(checks.size).toBeGreaterThanOrEqual(3);
    expect(checks).toContain('payload-matches-canonical-datatype');
    expect(checks).toContain('credential-never-emitted');
    expect(formatConformanceReport(report)).toContain('conformance failure');
  });
});
