import { defineVitestConfig } from '@papercusp/test-config';

// operator-core unit tests. Resolution of internal imports is relative
// (no @/ alias in this package); @papercusp/* workspace deps resolve via the
// hoisted node_modules symlinks. The defineVitestConfig tsconfigPaths plugin
// reads this package's tsconfig (no paths) — harmless. The admin test-runs
// reporter (the /admin/testing status chips) is AUTO-WIRED by defineVitestConfig
// — no per-config wiring needed.
export default defineVitestConfig({ layer: 'unit' });
