/**
 * _carry-row-id — the ONE optional stable row-identity schema shared by every
 * carry surface's walls/checks rows (P-013).
 *
 * loop:checkpoint and work_items:checkpoint deliberately expose the SAME row
 * contract, and the storage/merge/render layer beneath them is already shared
 * (`carryRowKey` / `sanitizeCarryRowId` in ../carry-note). Only the two Zod
 * schemas were copies — and they drifted: work_items:checkpoint's rows rejected
 * `id` outright while loop:checkpoint's accepted it, so the SAME payload was
 * valid on one surface and `invalid_args` on the other. That drift was filed
 * five separate times (EI-20253834997694796, EI-20236147445680077,
 * EI-20228409648836355, EI-20254509551788706, EI-20212648190769643) before it
 * was fixed, which is the tell that a copied contract was the wrong shape.
 * Both tools now import this constant, so the contract cannot drift again.
 *
 * The 40-character bound is a real STORED identity limit: rendered/parser
 * anchors and `sanitizeCarryRowId` use the same bound. The INPUT backstop is
 * deliberately looser so a recovery payload can be repaired at the handler
 * boundary and told that its identity changed, rather than rejected whole.
 */
import { z } from 'zod';

import { CARRY_CAP_HARD_MULTIPLE, CARRY_ROW_ID_MAX } from '../carry-note';

const CARRY_ROW_ID_INPUT_HARD_MAX = CARRY_ROW_ID_MAX * CARRY_CAP_HARD_MULTIPLE;

export const CARRY_ROW_ID_SCHEMA = z
  .string()
  .max(CARRY_ROW_ID_INPUT_HARD_MAX)
  .optional()
  .describe(
    "Stable id for this row (e.g. 'gate-green'), independent of wording. Lets you RE-WORD the claim without " +
      'losing its evidence/age, and is what rowsMode:\'merge\' upserts on. Stored identities are limited to 40 characters; bounded longer inputs are repaired and reported, while inputs over the hard backstop are rejected. Omitted ⇒ identity is the claim text.',
  );
