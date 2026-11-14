---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r44/config.mts"
updated_at: 1794203168786
_body: "content"
---

import base from '/tmp/latency-baseline-git-source-20261108-r1/packages/operator-core/vitest.config.ts';
import { mergeConfig } from '/tmp/latency-baseline-git-source-20261108-r1/node_modules/vitest/dist/config.js';

// Preserve maintained unit setup/reporting while reusing the independent install.
export default mergeConfig(base, {
  root: '/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core',
  resolve: { alias: { vitest: '/tmp/latency-baseline-git-source-20261108-r1/node_modules/vitest/dist/index.js' } },
});

