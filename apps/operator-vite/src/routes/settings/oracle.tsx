import { createFileRoute } from '@tanstack/react-router';
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '../../lib/require-flag';
import OracleClient from '@/app/settings/oracle/OracleClient';

/**
 * /settings/oracle — Oracle assistant settings. Translated from
 * `apps/operator/app/settings/oracle/page.tsx`. The `requireFlag(FLAGS.ORACLE)`
 * gate is ported to a `beforeLoad` check — see `lib/require-flag.ts`.
 */
export const Route = createFileRoute('/settings/oracle')({
  beforeLoad: () => requireFlag(FLAGS.ORACLE),
  component: OracleClient,
});
