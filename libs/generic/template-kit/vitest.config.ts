import { defineVitestConfig } from '@papercusp/test-config/vitest-config';

export default defineVitestConfig({
  layer: 'unit',
  include: [
    'src/**/*.test.ts',
    // EI-21113741017731833: the mobile templates' fixture suites are the
    // in-repo FALSIFIABILITY harness for their contracts, and nothing was
    // executing them — they skipIf(materialized) inside a materialized app,
    // and no vitest config owned them in the repo. They run HERE because
    // scripts/affected-tests.mjs already routes `templates/` to this
    // workspace, so a change to a template contract selects the suite that
    // guards it. (The non-fixture `composition-integrity.test.ts` siblings
    // are deliberately NOT included: those are the checks a MATERIALIZED app
    // runs against its own checks-config.json, which the repo does not have.)
    '../../../templates/*/checks/*.fixture.test.ts',
  ],
});
