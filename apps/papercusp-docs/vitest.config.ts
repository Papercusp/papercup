import { defineConfig } from 'vitest/config';
import { gateParticipationConfig, sharedHostWorkerCap } from '@papercusp/test-config/vitest-config';

// Hand-rolled like apps/papercusp-publish: gateParticipationConfig() wires the
// /admin/testing reporter and the gate's pass-proof recorder; sharedHostWorkerCap()
// keeps a direct `npx vitest run` from forking one worker per host core (WI-4300).
// The only suite here is the served-build parity guard (WI-10006957).
export default defineConfig({
  test: {
    include: ['lib/**/*.test.ts'],
    ...sharedHostWorkerCap(),
    ...gateParticipationConfig(),
  },
});
