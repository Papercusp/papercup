import { expect, it } from 'vitest';
import { REPAIR_PREREQUISITE_CASE, runLiveRepairDelivery } from './codex-home-repair-delivery';

// Selecting this live case admits execution. Missing opt-in or proof fails;
// collection without execution never certifies a delivered artifact.
it(REPAIR_PREREQUISITE_CASE, async () => {
  expect(await runLiveRepairDelivery('prerequisite')).toMatchObject({ ok: true });
}, 240_000);
