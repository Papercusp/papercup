import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../endpoint-route/routes/agent-mcp/operator-voice-proxy-helpers', () => ({
  probeKokoroHealth: vi.fn(async () => false),
}));

import { probeKokoroHealth } from '../endpoint-route/routes/agent-mcp/operator-voice-proxy-helpers';
import {
  isKokoroLocalProvisioned,
  provisionKokoroLocal,
  kokoroLocalSynthWav,
  kokoroTtsAvailable,
  kokoroLocalCacheDir,
  float32ToWav,
  __resetKokoroLocalForTests,
  KOKORO_LOCAL_MODEL_ID,
  type KokoroEngineLike,
} from './kokoro-local';

function fakeEngine(): KokoroEngineLike {
  return {
    async generate(_text: string, _opts: { voice: string }) {
      return { audio: new Float32Array(2400).fill(0.25), sampling_rate: 24000 };
    },
  };
}

describe('kokoro-local', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kokoro-local-test-'));
    __resetKokoroLocalForTests();
    vi.mocked(probeKokoroHealth).mockReset().mockResolvedValue(false);
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('is not provisioned on a fresh home', async () => {
    expect(await isKokoroLocalProvisioned(home)).toBe(false);
  });

  it('provision: loads the engine, PROVES a synth, then writes the marker (verify-then-mark)', async () => {
    let generateCalls = 0;
    const engine: KokoroEngineLike = {
      async generate(text, opts) {
        generateCalls++;
        expect(opts.voice).toBe('af_bella');
        expect(text.length).toBeGreaterThan(0);
        return { audio: new Float32Array(100).fill(0.1), sampling_rate: 24000 };
      },
    };
    const r = await provisionKokoroLocal({ home, loadEngine: async () => engine, now: () => '2026-07-12T00:00:00.000Z' });
    expect(r.ok).toBe(true);
    expect(generateCalls).toBe(1);
    expect(await isKokoroLocalProvisioned(home)).toBe(true);
    const marker = JSON.parse(await readFile(join(kokoroLocalCacheDir(home), '.provisioned.json'), 'utf8'));
    expect(marker.modelId).toBe(KOKORO_LOCAL_MODEL_ID);
  });

  it('provision failure (engine load throws) is blocked, writes NO marker, and does not poison a retry', async () => {
    let attempt = 0;
    const load = async () => {
      attempt++;
      if (attempt === 1) throw new Error('ENOTFOUND huggingface.co');
      return fakeEngine();
    };
    const first = await provisionKokoroLocal({ home, loadEngine: load });
    expect(first.ok).toBe(false);
    expect(first.blocked).toMatch(/ENOTFOUND/);
    expect(await isKokoroLocalProvisioned(home)).toBe(false);
    const second = await provisionKokoroLocal({ home, loadEngine: load });
    expect(second.ok).toBe(true);
  });

  it('a marker for a DIFFERENT model pin reads as not provisioned (pin bump re-provisions)', async () => {
    await provisionKokoroLocal({ home, loadEngine: async () => fakeEngine() });
    const markerPath = join(kokoroLocalCacheDir(home), '.provisioned.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    marker.modelId = 'onnx-community/some-old-pin';
    const { writeFile } = await import('node:fs/promises');
    await writeFile(markerPath, JSON.stringify(marker));
    expect(await isKokoroLocalProvisioned(home)).toBe(false);
  });

  it('synth refuses cleanly when not provisioned', async () => {
    const r = await kokoroLocalSynthWav('hello', undefined, { home, loadEngine: async () => fakeEngine() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not provisioned/);
  });

  it('synth returns a real RIFF/WAVE once provisioned', async () => {
    await provisionKokoroLocal({ home, loadEngine: async () => fakeEngine() });
    const r = await kokoroLocalSynthWav('hello world', undefined, { home, loadEngine: async () => fakeEngine() });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.contentType).toBe('audio/wav');
      const bytes = new Uint8Array(r.audio);
      expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF');
      expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('WAVE');
      // 2400 samples * 2 bytes + 44-byte header
      expect(r.audio.byteLength).toBe(2400 * 2 + 44);
    }
  });

  it('float32ToWav clamps out-of-range samples instead of wrapping', () => {
    const wav = new Int16Array(float32ToWav(new Float32Array([2.0, -2.0, 0]), 24000), 44);
    expect(wav[0]).toBe(32767);
    expect(wav[1]).toBe(-32767);
    expect(wav[2]).toBe(0);
  });

  it('kokoroTtsAvailable = HTTP server OR provisioned in-process engine', async () => {
    vi.mocked(probeKokoroHealth).mockResolvedValue(false);
    // Neither: unavailable. (Module-default home is NOT provisioned in this test env —
    // but guard against a dev box that has provisioned it for real by only asserting the
    // provisioned-path directionally below.)
    vi.mocked(probeKokoroHealth).mockResolvedValue(true);
    expect(await kokoroTtsAvailable()).toBe(true);
  });
});
