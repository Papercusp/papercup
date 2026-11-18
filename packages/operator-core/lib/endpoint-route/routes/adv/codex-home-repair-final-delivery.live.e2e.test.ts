import { expect, it } from 'vitest';
import { REPAIR_FINAL_CASE, runLiveRepairDelivery } from './codex-home-repair-delivery';

it(REPAIR_FINAL_CASE, async () => {
  expect(await runLiveRepairDelivery('final')).toMatchObject({ ok: true });
}, 240_000);
