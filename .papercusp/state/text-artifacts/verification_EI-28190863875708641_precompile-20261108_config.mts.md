---
rel_path: "verification/EI-28190863875708641/precompile-20261108/config.mts"
updated_at: 1794112403994
_body: "content"
---

import base from '/tmp/latency-baseline-source-20261108-r1/apps/operator/vitest.config.ts';
import { mergeConfig } from '/tmp/latency-baseline-source-20261108-r1/node_modules/vitest/dist/config.js';

// Retain the maintained project setup and acceptance hooks. Only the compiler
// dependency comes from the prepared independent install while the live install
// is owned by another session; tests and subject remain canonical current bytes.
export default mergeConfig(base, {
  root: '/home/marsh-office/papercupai-workspace/papercusp/apps/operator',
  resolve: { alias: { esbuild: '/tmp/latency-baseline-source-20261108-r1/node_modules/esbuild/lib/main.js' } },
});

