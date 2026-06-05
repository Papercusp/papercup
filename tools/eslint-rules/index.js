/**
 * Custom ESLint rules for the papercusp monorepo.
 *
 * Wire-up:
 *   import papercuspRules from './tools/eslint-rules/index.js';
 *   export default [
 *     {
 *       plugins: { papercusp: papercuspRules },
 *       rules: {
 *         'papercusp/no-bare-db-in-tx': 'error',
 *       },
 *     },
 *   ];
 */
'use strict';

module.exports = {
  rules: {
    'no-bare-db-in-tx': require('./no-bare-db-in-tx.js'),
    'no-raw-route-handlers': require('./no-raw-route-handlers.js'),
    'no-bare-jsonb-cast': require('./no-bare-jsonb-cast.js'),
  },
};
