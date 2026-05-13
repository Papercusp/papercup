import { FLAGS } from '@papercusp/flags';

import { requireFlag } from '@/lib/require-flag';

import OracleClient from './OracleClient';

export default async function OraclePage() {
  await requireFlag(FLAGS.ORACLE);
  return <OracleClient />;
}
