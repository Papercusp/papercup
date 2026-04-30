import { defineVitestConfig } from '@papercusp/test-config';

export default defineVitestConfig({
  layer: 'unit',
  exclude: ['**/test/**', '**/node_modules/**', '**/.next/**'],
});
