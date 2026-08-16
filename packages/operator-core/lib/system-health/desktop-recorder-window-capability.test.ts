/**
 * A Tauri window that the desktop code CREATES must be covered by the capability
 * allowlist, or every `event.emit` from it is denied at runtime.
 *
 * This guard exists because the two drifted and nothing noticed for months
 * (WI-39487, found while measuring P-021 of perf-testing-sweep-2026-07-27).
 * `ChaosDesktopPanel` creates its recorder window as `pc-perf-recorder-<runId>`,
 * while `capabilities/default.json` allowlisted `papercusp-perf-recorder-*` —
 * which is the BroadcastChannel constant (`recorder-channel.ts` CHANNEL_NAME),
 * not the window label. The prefixes never matched.
 *
 * The failure is silent in the worst way: the recorder window still opens and
 * still clicks, so the chaos suite reported "12 clicks" and looked alive, while
 * every interaction event it tried to emit was refused. The desktop-performance
 * suite consequently reported `p95=0ms · max=0ms` (a dead sensor reading exactly
 * like a fast one) and drowned each 10s run in ~3,000 `event.emit not allowed`
 * errors that were mistaken for defects on the surfaces under test.
 *
 * The FIXTURE controls below are load-bearing: once the live assertion goes
 * green it stops being evidence that the detector works at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// lib/system-health → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CAPABILITIES = join(ROOT, 'papercusp-desktop/src-tauri/capabilities/default.json');
const CHAOS_PANEL = join(ROOT, 'libs/testing-shell/src/desktop/ChaosDesktopPanel.tsx');

/**
 * Window labels the source creates, as literal prefixes. Matches the
 * `const label = \`some-prefix-${expr}\`` shape and keeps the literal head, so a
 * renamed run-id expression does not change the answer.
 */
export function createdWindowLabelPrefixes(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/label\s*=\s*`([^`$]*)\$\{/g)) {
    const literal = m[1];
    if (literal) out.add(literal);
  }
  return [...out];
}

/** Tauri capability window patterns support a trailing `*` wildcard. */
export function capabilityCoversLabel(pattern: string, label: string): boolean {
  if (!pattern.includes('*')) return pattern === label;
  const [head, ...rest] = pattern.split('*');
  return label.startsWith(head) && rest.every((part) => part === '' || label.includes(part));
}

export function uncoveredLabelPrefixes(prefixes: string[], patterns: string[]): string[] {
  return prefixes.filter((prefix) => !patterns.some((pattern) => capabilityCoversLabel(pattern, prefix)));
}

describe('desktop recorder window capability coverage', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches the WI-39487 drift — allowlist names the channel, not the window', () => {
      const prefixes = createdWindowLabelPrefixes('const label = `pc-perf-recorder-${runId}`;');
      expect(prefixes).toEqual(['pc-perf-recorder-']);
      expect(uncoveredLabelPrefixes(prefixes, ['main', 'papercusp-perf-recorder-*'])).toEqual([
        'pc-perf-recorder-',
      ]);
    });

    it('accepts a label the allowlist genuinely covers', () => {
      expect(uncoveredLabelPrefixes(['pc-perf-recorder-'], ['main', 'pc-perf-recorder-*'])).toEqual([]);
    });

    it('does not treat a wildcard as matching every label', () => {
      expect(uncoveredLabelPrefixes(['other-window-'], ['pc-perf-recorder-*'])).toEqual(['other-window-']);
    });

    it('requires an exact match when the pattern has no wildcard', () => {
      expect(capabilityCoversLabel('main', 'main')).toBe(true);
      expect(capabilityCoversLabel('main', 'main-2')).toBe(false);
    });
  });

  it('every window label ChaosDesktopPanel creates is allowlisted in capabilities/default.json', () => {
    const panel = readFileSync(CHAOS_PANEL, 'utf8');
    const capabilities = JSON.parse(readFileSync(CAPABILITIES, 'utf8')) as { windows?: string[] };
    const patterns = capabilities.windows ?? [];
    const prefixes = createdWindowLabelPrefixes(panel);

    // Calibration: if the extractor stops finding the recorder window, this guard
    // would pass vacuously — an absent signal reading as a green.
    expect(prefixes.length).toBeGreaterThan(0);
    expect(patterns.length).toBeGreaterThan(0);

    expect(uncoveredLabelPrefixes(prefixes, patterns)).toEqual([]);
  });
});
