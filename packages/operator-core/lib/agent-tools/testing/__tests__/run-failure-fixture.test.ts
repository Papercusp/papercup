import { expect, it } from 'vitest';

/**
 * A checked-in RED fixture for testing:run's assertion-detail projection.
 *
 * It is skipped in every ordinary suite. The owning integration test enables it only in the
 * nested test process, avoiding the old source-tree create/remove race with concurrent lane
 * censuses while still exercising a real Vitest assertion failure end to end.
 */
it.skipIf(process.env.PAPERCUSP_TESTING_RUN_ASSERTION_FIXTURE !== '1')(
  'preserves the assertion values',
  () => {
    expect({ service_select: false, other: 'actual' }).toEqual({
      service_select: true,
      other: 'expected',
    });
  },
);
