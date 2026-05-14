import { defineVitestConfig } from '@papercusp/test-config';

export default defineVitestConfig({
  layer: 'integration',
  include: [
    'test/**/*.integration.test.ts',
    'app/**/*.integration.test.ts',
    'lib/**/*.integration.test.ts',
  ],
});
