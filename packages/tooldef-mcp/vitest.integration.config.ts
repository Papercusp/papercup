import { defineVitestConfig } from '@papercusp/test-config/vitest-config';

// Exercise the SDK transport, published schemas and production dispatch bridge together.
export default defineVitestConfig({
  layer: 'integration',
  include: ['src/**/*.integration.test.ts'],
});
