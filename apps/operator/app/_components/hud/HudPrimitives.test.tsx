// @vitest-environment jsdom
//
// HudPrimitives — pure presentational SVG/markup glyphs (no app deps). These
// are render-smoke + structural assertions: the spoke count is driven by the
// `spokes` prop, the crosshair is opt-in, the corner frame renders four
// corners, and the telemetry marquee duplicates its segments across two
// tracks (the seamless-scroll trick). All are aria-hidden decoration.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import {
  HudFrameCorners,
  HudRingGlyph,
  HudReticleGlyph,
  HudTelemetryMarquee,
} from './HudPrimitives';

afterEach(cleanup);

describe('<HudFrameCorners />', () => {
  it('renders four corner spans inside an aria-hidden frame', () => {
    const { container } = render(<HudFrameCorners className="x" />);
    const frame = container.querySelector('.hud-frame-corners');
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute('aria-hidden')).toBe('true');
    expect(frame!.classList.contains('x')).toBe(true);
    expect(container.querySelectorAll('.hud-frame-corners__corner')).toHaveLength(4);
  });
});

describe('<HudRingGlyph />', () => {
  it('renders one spoke line per `spokes` (default 12) plus the three rings', () => {
    const { container } = render(<HudRingGlyph />);
    expect(container.querySelectorAll('.hud-ring-glyph__spoke')).toHaveLength(12);
    // orbit + inner + pulse circles.
    expect(container.querySelectorAll('circle')).toHaveLength(3);
    // No crosshair by default.
    expect(container.querySelectorAll('.hud-ring-glyph__crosshair')).toHaveLength(0);
  });

  it('honours a custom spoke count', () => {
    const { container } = render(<HudRingGlyph spokes={6} />);
    expect(container.querySelectorAll('.hud-ring-glyph__spoke')).toHaveLength(6);
  });

  it('adds four crosshair lines when withCrosshair is set', () => {
    const { container } = render(<HudRingGlyph withCrosshair />);
    expect(container.querySelectorAll('.hud-ring-glyph__crosshair')).toHaveLength(4);
  });
});

describe('<HudReticleGlyph />', () => {
  it('renders the frame paths, halo/core circles and four axis ticks', () => {
    const { container } = render(<HudReticleGlyph />);
    expect(container.querySelectorAll('.hud-reticle-glyph__frame')).toHaveLength(4);
    expect(container.querySelectorAll('.hud-reticle-glyph__axis')).toHaveLength(4);
    expect(container.querySelector('.hud-reticle-glyph__halo')).not.toBeNull();
    expect(container.querySelector('.hud-reticle-glyph__core')).not.toBeNull();
    // viewBox tracks the `size` prop (default 84).
    expect(container.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 84 84');
  });

  it('scales the viewBox with a custom size', () => {
    const { container } = render(<HudReticleGlyph size={100} />);
    expect(container.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 100 100');
  });
});

describe('<HudTelemetryMarquee />', () => {
  it('duplicates each segment across two tracks for the seamless scroll', () => {
    const segments = ['SIG-A', 'SIG-B', 'SIG-C'];
    const { container } = render(<HudTelemetryMarquee segments={segments} />);
    expect(container.querySelectorAll('.hud-telemetry-marquee__track')).toHaveLength(2);
    // 3 segments × 2 tracks = 6 rendered spans.
    const spans = container.querySelectorAll('.hud-telemetry-marquee__segment');
    expect(spans).toHaveLength(6);
    expect([...spans].map((s) => s.textContent)).toEqual([
      'SIG-A', 'SIG-B', 'SIG-C', 'SIG-A', 'SIG-B', 'SIG-C',
    ]);
  });

  it('renders empty tracks when there are no segments (still two tracks)', () => {
    const { container } = render(<HudTelemetryMarquee segments={[]} />);
    expect(container.querySelectorAll('.hud-telemetry-marquee__track')).toHaveLength(2);
    expect(container.querySelectorAll('.hud-telemetry-marquee__segment')).toHaveLength(0);
  });
});
