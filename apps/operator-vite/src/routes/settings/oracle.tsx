import { createFileRoute } from '@tanstack/react-router';
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '../../lib/require-flag';
import OracleClient from '@/app/settings/oracle/OracleClient';

/**
 * /settings/oracle — Oracle assistant settings. Translated from
 * `apps/operator/app/settings/oracle/page.tsx`. The flag gate is ported to a
 * `beforeLoad` check — see `lib/require-flag.ts`. Gated on TESTING: the Oracle
 * is a testing surface (papercusp-oracle folded into papercusp-testing,
 * owner ask 2026-06-10).
 */
export const Route = createFileRoute('/settings/oracle')({
  beforeLoad: () => requireFlag(FLAGS.TESTING),
  component: OracleClient,
});
