/**
 * watermark-store.test.ts — run the shared WatermarkStore conformance suite
 * against the in-memory double (the package-level P-050 proof). The PG impl
 * is proven by the operator's live-PG integration test, mirroring presence +
 * event-log.
 */

import { describeWatermarkStoreConformance } from './conformance';
import { InMemoryWatermarkStore } from './memory-store';

describeWatermarkStoreConformance('InMemoryWatermarkStore', () => new InMemoryWatermarkStore());
