/**
 * EI-20340243384897336 — the clustered :3070 operator needs a service-wide
 * cgroup envelope in addition to each process's recycle watchdog.
 *
 * This reads the versioned systemd source rather than the mutable live symlink,
 * so CI catches a lost policy before a fresh machine installs it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dropInPath = fileURLToPath(
  new URL('../../../apps/operator/scripts/systemd/papercup-dev-api.service.d/55-memory-envelope.conf', import.meta.url),
);

function directive(text: string, name: string): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

describe('papercup-dev-api service memory envelope (EI-20340243384897336)', () => {
  const dropIn = readFileSync(dropInPath, 'utf8');

  it('removes the stale process-wide watchdog override', () => {
    expect(directive(dropIn, 'UnsetEnvironment')).toBe('PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB');
    expect(dropIn).not.toMatch(/^Environment=PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB=/m);
  });

  it('keeps a reclaim-first aggregate envelope with ordered limits', () => {
    const highGiB = Number.parseInt(directive(dropIn, 'MemoryHigh') ?? '', 10);
    const maxGiB = Number.parseInt(directive(dropIn, 'MemoryMax') ?? '', 10);
    const swapMaxGiB = Number.parseInt(directive(dropIn, 'MemorySwapMax') ?? '', 10);

    expect(directive(dropIn, 'MemoryAccounting')).toBe('yes');
    expect(highGiB).toBe(48);
    expect(maxGiB).toBe(64);
    expect(swapMaxGiB).toBe(16);
    expect(highGiB).toBeLessThan(maxGiB);
    expect(swapMaxGiB).toBeLessThan(highGiB);
  });
});
