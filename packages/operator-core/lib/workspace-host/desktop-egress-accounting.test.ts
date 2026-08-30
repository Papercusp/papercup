import { describe, expect, it } from 'vitest';
import {
  ACTIVE_VIEWER_SECOND_CEILING_BYTES,
  DESKTOP_EGRESS_MEASUREMENT,
  IDLE_VIEWER_SECOND_BYTES,
  activeViewerSecondsFromFrameActivity,
  estimateDesktopEgressCost,
  estimateDesktopStreamEgressBytes,
  estimateFirstPaintBytes,
} from './desktop-egress-accounting';

const XGA = { width: 1024, height: 768 };
const HD = { width: 1920, height: 1080 };
const HOUR_SECONDS = 3600;

function cell(name: string) {
  const found = DESKTOP_EGRESS_MEASUREMENT.find((entry) => entry.cell === name);
  if (!found) throw new Error(`no measured cell ${name}`);
  return found;
}

describe('desktop egress accounting — calibration against D-035', () => {
  // CALIBRATION. Without these the guards below can all pass on a model that reproduces nothing,
  // which is the failure mode where controls look healthy because the instrument is broken.
  it('reproduces both measured first-paint costs, because the fit runs through them', () => {
    expect(estimateFirstPaintBytes(XGA).bytes).toBeCloseTo(cell('xga-idle').attachBytes, -1);
    expect(estimateFirstPaintBytes(HD).bytes).toBeCloseTo(cell('hd-idle').attachBytes, -1);
    expect(estimateFirstPaintBytes(XGA).extrapolated).toBe(false);
    expect(estimateFirstPaintBytes(HD).extrapolated).toBe(false);
  });

  it('flags a geometry outside the two measured points as extrapolated', () => {
    expect(estimateFirstPaintBytes({ width: 3840, height: 2160 }).extrapolated).toBe(true);
    expect(estimateFirstPaintBytes({ width: 800, height: 600 }).extrapolated).toBe(true);
  });

  it('reproduces the measured 60s active windows, over-estimating the friendlier cell', () => {
    // The steady term is the WORSE of the two measured cells, so xga-active is reproduced exactly
    // and hd-active is over-estimated by the 8% between them. That over-estimate is the ceiling
    // doing its job, not drift: this module budgets, so it must not pick the friendlier number.
    for (const name of ['xga-active', 'hd-active'] as const) {
      const measured = cell(name);
      const modelled = estimateDesktopStreamEgressBytes([
        { geometry: measured.geometry, attaches: 0, activeViewerSeconds: 60 },
      ]);
      const measuredWindowBytes = measured.steadyBytesPerSec * 60;
      expect(modelled.breakdown.steadyStateBytes).toBeGreaterThanOrEqual(measuredWindowBytes);
      expect(modelled.breakdown.steadyStateBytes / measuredWindowBytes).toBeLessThan(1.1);
    }
  });

  it('takes its ceiling from the worse measured cell', () => {
    const activeRates = DESKTOP_EGRESS_MEASUREMENT.map((entry) => entry.steadyBytesPerSec);
    expect(ACTIVE_VIEWER_SECOND_CEILING_BYTES).toBe(Math.max(...activeRates));
    expect(ACTIVE_VIEWER_SECOND_CEILING_BYTES).toBeGreaterThan(0);
  });
});

describe('desktop egress accounting — an idle desktop costs exactly zero (D-035 finding 1)', () => {
  it('measured idle egress is zero at both geometries, not merely small', () => {
    expect(IDLE_VIEWER_SECOND_BYTES).toBe(0);
    for (const name of ['xga-idle', 'hd-idle'] as const) {
      expect(cell(name).steadyBytesPerSec).toBe(0);
      expect(cell(name).changedPixels).toBe(0);
    }
  });

  it('bills a whole idle hour at zero beyond its single first paint', () => {
    const estimate = estimateDesktopStreamEgressBytes([
      { geometry: HD, attaches: 1, activeViewerSeconds: 0 },
    ]);
    expect(estimate.breakdown.steadyStateBytes).toBe(0);
    expect(estimate.bytes).toBe(estimateFirstPaintBytes(HD).bytes);
  });

  // PERMANENT CONTROL. This is the mistake the module's shape exists to prevent: a caller holding
  // a wall-clock attachment window must not be able to turn it into a bill. The only sanctioned
  // route from a timeline to a billable duration is this helper, and for an idle hour it is 0.
  it('cannot convert a wall-clock idle hour into billable seconds', () => {
    const billable = activeViewerSecondsFromFrameActivity({
      attachedSeconds: HOUR_SECONDS,
      framebufferUpdateSeconds: 0,
    });
    expect(billable).toBe(0);
    expect(estimateDesktopStreamEgressBytes([
      { geometry: XGA, attaches: 0, activeViewerSeconds: billable },
    ]).bytes).toBe(0);
  });

  it('clamps claimed activity to the attachment window rather than trusting it', () => {
    expect(activeViewerSecondsFromFrameActivity({
      attachedSeconds: 30,
      framebufferUpdateSeconds: 900,
    })).toBe(30);
  });
});

describe('desktop egress accounting — resolution is not a cost lever (D-035 finding 2)', () => {
  // The finding this pins is the one most likely to be quietly reversed later, because
  // "stream a smaller desktop to cut the bill" is such a natural-sounding optimisation.
  // It is measurably false: at equal changed area the two geometries landed 8% apart, with
  // 1080p marginally LOWER. Geometry therefore cannot enter the steady-state term at all.
  it('charges identical steady-state egress for XGA and 1080p at identical activity', () => {
    const xga = estimateDesktopStreamEgressBytes([
      { geometry: XGA, attaches: 0, activeViewerSeconds: HOUR_SECONDS },
    ]);
    const hd = estimateDesktopStreamEgressBytes([
      { geometry: HD, attaches: 0, activeViewerSeconds: HOUR_SECONDS },
    ]);
    expect(hd.breakdown.steadyStateBytes).toBe(xga.breakdown.steadyStateBytes);
  });

  it('makes downscaling an hour of active viewing worth well under 1% of the bill', () => {
    const usage = (geometry: typeof XGA) => [{ geometry, attaches: 1, activeViewerSeconds: HOUR_SECONDS }];
    const hd = estimateDesktopStreamEgressBytes(usage(HD)).bytes;
    const xga = estimateDesktopStreamEgressBytes(usage(XGA)).bytes;
    const saving = (hd - xga) / hd;
    expect(saving).toBeGreaterThan(0); // the first paint really is smaller
    expect(saving).toBeLessThan(0.01); // ...and that is the entire saving
  });

  it('attributes the whole downscaling saving to first paint, never to the stream', () => {
    const hd = estimateDesktopStreamEgressBytes([{ geometry: HD, attaches: 1, activeViewerSeconds: 600 }]);
    const xga = estimateDesktopStreamEgressBytes([{ geometry: XGA, attaches: 1, activeViewerSeconds: 600 }]);
    expect(hd.bytes - xga.bytes)
      .toBe(hd.breakdown.firstPaintBytes - xga.breakdown.firstPaintBytes);
  });
});

describe('desktop egress accounting — per-attach cost (D-035 finding 4)', () => {
  it('charges a first paint per attach, so re-attach cycling is the expensive behaviour', () => {
    const oneLongWatch = estimateDesktopStreamEgressBytes([
      { geometry: HD, attaches: 1, activeViewerSeconds: 300 },
    ]);
    const sameViewingFlapping = estimateDesktopStreamEgressBytes([
      { geometry: HD, attaches: 60, activeViewerSeconds: 300 },
    ]);
    expect(sameViewingFlapping.bytes).toBeGreaterThan(oneLongWatch.bytes);
    expect(sameViewingFlapping.breakdown.steadyStateBytes)
      .toBe(oneLongWatch.breakdown.steadyStateBytes);
  });

  it('sums independent viewers', () => {
    const both = estimateDesktopStreamEgressBytes([
      { geometry: XGA, attaches: 1, activeViewerSeconds: 100 },
      { geometry: HD, attaches: 2, activeViewerSeconds: 50 },
    ]);
    expect(both.bytes).toBe(
      estimateDesktopStreamEgressBytes([{ geometry: XGA, attaches: 1, activeViewerSeconds: 100 }]).bytes
      + estimateDesktopStreamEgressBytes([{ geometry: HD, attaches: 2, activeViewerSeconds: 50 }]).bytes,
    );
  });

  it('reports the estimate as a saturation ceiling, never as an expected value', () => {
    const estimate = estimateDesktopStreamEgressBytes([
      { geometry: XGA, attaches: 1, activeViewerSeconds: 1 },
    ]);
    expect(estimate.basis).toBe('saturation-ceiling');
    expect(estimate.evidenceRef).toContain('D-035');
  });
});

describe('desktop egress accounting — pricing into the hosted cost model', () => {
  const priced = {
    centsPerGiB: 12,
    currency: 'USD',
    priceSource: 'gcp-network-egress-2026-08',
    estimatedAt: '2026-08-30T00:00:00Z',
  };

  it('produces a HostedCostEstimate-shaped record carrying the measurement provenance', () => {
    const estimate = estimateDesktopEgressCost({
      ...priced,
      usage: [{ geometry: HD, attaches: 1, activeViewerSeconds: HOUR_SECONDS }],
    });
    expect(estimate.currency).toBe('USD');
    expect(estimate.source).toBe('desktop-egress:gcp-network-egress-2026-08');
    expect(estimate.evidenceRef).toContain('D-035');
    expect(Number.isSafeInteger(estimate.cents)).toBe(true);
    // ~3.5 GB/hr at 12c/GiB is a few tens of cents; pinned loosely so a re-measure can move it.
    expect(estimate.cents).toBeGreaterThan(20);
    expect(estimate.cents).toBeLessThan(80);
  });

  it('charges an idle hour nothing at all', () => {
    const estimate = estimateDesktopEgressCost({
      ...priced,
      usage: [{ geometry: HD, attaches: 0, activeViewerSeconds: 0 }],
    });
    expect(estimate.cents).toBe(0);
    expect(estimate.bytes).toBe(0);
  });

  it('rounds a sub-cent window up, so activity can never accumulate free', () => {
    const estimate = estimateDesktopEgressCost({
      ...priced,
      usage: [{ geometry: XGA, attaches: 0, activeViewerSeconds: 1 }],
    });
    expect(estimate.cents).toBe(1);
  });

  it('refuses to invent a price, a currency, or provenance', () => {
    const usage = [{ geometry: XGA, attaches: 1, activeViewerSeconds: 10 }];
    expect(() => estimateDesktopEgressCost({ ...priced, usage, centsPerGiB: Number.NaN }))
      .toThrow(/centsPerGiB/);
    expect(() => estimateDesktopEgressCost({ ...priced, usage, centsPerGiB: -1 }))
      .toThrow(/centsPerGiB/);
    expect(() => estimateDesktopEgressCost({ ...priced, usage, currency: 'dollars' }))
      .toThrow(/ISO-4217/);
    expect(() => estimateDesktopEgressCost({ ...priced, usage, priceSource: '  ' }))
      .toThrow(/priceSource/);
    expect(() => estimateDesktopEgressCost({ ...priced, usage, estimatedAt: 'yesterday' }))
      .toThrow(/estimatedAt/);
  });

  it('rejects a nonsensical geometry rather than pricing it', () => {
    expect(() => estimateFirstPaintBytes({ width: 0, height: 768 })).toThrow(/positive finite/);
  });
});
