import { defineVitestConfig } from '@papercusp/test-config';

export default defineVitestConfig({
  layer: 'integration',
  include: ['test/**/*.integration.test.ts'],
});
