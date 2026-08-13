import { defineVitestConfig } from '@papercusp/test-config/vitest-config';

// operator-core unit tests. Resolution of internal imports is relative
// (no @/ alias in this package); @papercusp/* workspace deps resolve via the
// hoisted node_modules symlinks. The defineVitestConfig tsconfigPaths plugin
// reads this package's tsconfig (no paths) — harmless. The admin test-runs
// reporter (the /admin/testing status chips) is AUTO-WIRED by defineVitestConfig
// — no per-config wiring needed.
// laneSplit: this workspace OPTS IN to the pure/stateful lane split
// (plan gate-suite-speedup-2026-08-12). It is inert unless PC_TEST_LANE names a lane, so
// `npm run test` — including every re-run the green-checkpoint gate performs — is byte-for-byte
// unchanged: the full suite, isolated. Only the dedicated lane legs opt in.
//
// operator-core is the workspace this exists for: its leg is ~50% of the gate's entire serial
// test phase (D-031), and ~69% of its 4,105 unit files never touch the module registry, so they
// can share a fork instead of cold-transpiling the operator-core graph once per file.
export default defineVitestConfig({ layer: 'unit', laneSplit: true });
