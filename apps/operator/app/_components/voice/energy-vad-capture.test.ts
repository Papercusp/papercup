/**
 * Tests for the energy-VAD always-on segmenter — the WebKitGTK-safe
 * replacement for Silero. Covers the pure RMS helpers and the adaptive
 * speech-start/end state machine (noise-floor tracking + hysteresis +
 * hangover + max-length cap).
 */

import { describe, it, expect } from 'vitest';
import {
  EnergyVadSegmenter,
  frameRms,
  mergeFrames,
  type VadParams,
} from './energy-vad-capture';

describe('frameRms', () => {
  it('is 0 for silence', () => {
    expect(frameRms(new Float32Array(512))).toBe(0);
  });
  it('equals the amplitude for a constant signal', () => {
    expect(frameRms(new Float32Array(100).fill(0.5))).toBeCloseTo(0.5, 6);
  });
});

describe('mergeFrames', () => {
  it('concatenates in order', () => {
    const out = mergeFrames([new Float32Array([1, 2]), new Float32Array([3]), new Float32Array([4, 5])]);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });
  it('handles the empty case', () => {
    expect(mergeFrames([]).length).toBe(0);
  });
});

// Deterministic params: low absoluteFloor, tiny start/hangover so sequences
// are short and obvious. floorAttack 0 freezes the floor at absoluteFloor so
// thresholds are predictable: trigger=0.01*3=0.03, release=0.01*1.8=0.018.
const P: Partial<VadParams> = {
  floorAttack: 0,
  absoluteFloor: 0.01,
  triggerMult: 3,
  releaseMult: 1.8,
  startFrames: 2,
  hangoverFrames: 3,
  maxUtteranceFrames: 50,
};

describe('EnergyVadSegmenter', () => {
  it('exposes the derived trigger threshold', () => {
    expect(new EnergyVadSegmenter(P).triggerThreshold).toBeCloseTo(0.03, 6);
  });

  it('does not start on a single loud frame (needs startFrames consecutive)', () => {
    const s = new EnergyVadSegmenter(P);
    expect(s.push(0.05).type).toBe('none'); // 1 loud frame
    expect(s.isSpeaking).toBe(false);
    expect(s.push(0.001).type).toBe('none'); // dropped below → run resets
    expect(s.push(0.05).type).toBe('none'); // count restarts at 1
    expect(s.isSpeaking).toBe(false);
  });

  it('starts after startFrames consecutive above-trigger frames', () => {
    const s = new EnergyVadSegmenter(P);
    expect(s.push(0.05).type).toBe('none');
    const ev = s.push(0.05);
    expect(ev.type).toBe('start');
    expect(s.isSpeaking).toBe(true);
  });

  it('ends after hangoverFrames of silence, reporting trailing frames to drop', () => {
    const s = new EnergyVadSegmenter(P);
    s.push(0.05); s.push(0.05); // start
    expect(s.push(0.05).type).toBe('none'); // still speaking
    expect(s.push(0.001).type).toBe('none'); // silence 1
    expect(s.push(0.001).type).toBe('none'); // silence 2
    const ev = s.push(0.001); // silence 3 → end
    expect(ev).toEqual({ type: 'end', dropTrailingFrames: 3 });
    expect(s.isSpeaking).toBe(false);
  });

  it('resets the silence run when speech resumes mid-utterance', () => {
    const s = new EnergyVadSegmenter(P);
    s.push(0.05); s.push(0.05); // start
    s.push(0.001); s.push(0.001); // 2 silence frames (not yet end)
    expect(s.push(0.05).type).toBe('none'); // speech resumes → silenceRun resets
    s.push(0.001); s.push(0.001);
    expect(s.push(0.001).type).toBe('end'); // needs 3 fresh silence frames
  });

  it('force-ends at maxUtteranceFrames with no trailing drop', () => {
    const s = new EnergyVadSegmenter({ ...P, maxUtteranceFrames: 5 });
    s.push(0.05); s.push(0.05); // start (uttFrames=2)
    expect(s.push(0.05).type).toBe('none'); // 3
    expect(s.push(0.05).type).toBe('none'); // 4
    const ev = s.push(0.05); // 5 → cap
    expect(ev).toEqual({ type: 'end', dropTrailingFrames: 0 });
  });

  it('adapts the trigger upward as the ambient noise floor rises', () => {
    const s = new EnergyVadSegmenter({ ...P, floorAttack: 0.5 }); // fast tracking
    const before = s.triggerThreshold;
    for (let i = 0; i < 10; i++) s.push(0.02); // sustained ambient below trigger
    expect(s.triggerThreshold).toBeGreaterThan(before);
    expect(s.isSpeaking).toBe(false); // never triggered on the noise itself
  });
});
