/**
 * Wire the db-org local diagnostic correlation seam to the existing named-hop
 * AsyncLocalStorage. The db package owns the optional channel; operator-core
 * owns the stage/attempt policy and supplies the current local context.
 *
 * This is observation-only: the returned tuple never enters LocalWriteOp,
 * crypto AAD, SQL, parameters, or a federated envelope.
 */

import {
  setPgDiagnosticContextResolver,
  type PgResultDiagnosticCorrelation,
} from '@papercusp/db-org';
import { currentStageAttempt } from '../sync/hyperbee/stage-stall-log';

setPgDiagnosticContextResolver((): PgResultDiagnosticCorrelation | null => {
  const attempt = currentStageAttempt();
  if (!attempt) return null;
  const active = attempt.snapshot().activeHops;
  const hop = active.length > 0 ? active[active.length - 1] : undefined;
  return {
    ...attempt.context,
    hopId: hop?.hopId ?? null,
    stage: hop?.stage ?? null,
    boundary: hop?.boundary ?? null,
  };
});
