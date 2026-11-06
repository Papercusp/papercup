import { monitorEventLoopDelay } from 'node:perf_hooks';

/** Reports a sidecar's event-loop delay over a response window. */
export function createSidecarLoopDelay(resolution = 10) {
  const histogram = monitorEventLoopDelay({ resolution });
  histogram.enable();

  return {
    readP99Ms(reset = true): number {
      const p99Ms = histogram.count > 0 ? histogram.percentile(99) / 1e6 : 0;
      if (reset) histogram.reset();
      return p99Ms;
    },
    reset(): void {
      histogram.reset();
    },
    close(): void {
      histogram.disable();
    },
  };
}
