import { defineConfig } from 'vitest/config';
import { gateParticipationConfig, sharedHostWorkerCap } from '@papercusp/test-config/vitest-config';

const participation = gateParticipationConfig();

// Hand-rolled config (not defineVitestConfig). gateParticipationConfig() wires what the
// green-checkpoint gate needs from every unit config: the /admin/testing reporter, the
// per-file pass-proof recorder + input capture when the runner arms them, and the reuse skip
// list (WI-10003716). Everything else stays vitest-default. Reporter opt-out via env.
export default defineConfig({
  test: {
    // WI-4300: the shared-host worker cap — without it a direct `npx vitest run` in
    // this workspace forks ~one worker per host core (128 on the shared dev box).
    ...sharedHostWorkerCap(),
    ...participation,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          exclude: [...participation.exclude, '**/treasury.test.ts'],
          provide: { papercuspTestLayer: 'unit' },
        },
      },
      {
        extends: true,
        test: {
          name: 'treasury-integration',
          include: ['src/__tests__/treasury.test.ts'],
          provide: { papercuspTestLayer: 'integration' },
        },
      },
    ],
  },
});
