/**
 * TEMPORARY mutation probe for the P-014 guard — deleted immediately after the check.
 * Carries the exact D-007 defect shape (an inline blocking predicate with a hardcoded
 * blocker-leg workspace) so we can confirm the guard FAILS on it rather than passing
 * vacuously. Valid, compiling TypeScript on purpose: if a git-sync tick sweeps the tree
 * mid-check, this file cannot break anyone's build.
 */
export const PROBE_INLINE_BLOCKING_PREDICATE = `
  NOT EXISTS (
    SELECT 1 FROM harness_shared.work_item_deps d
     WHERE d.workspace_id = 'default'
       AND d.dep_type = 'blocks'
       AND d.blocked_ref = wi.feature_id
       AND EXISTS (
         SELECT 1 FROM harness_shared.engineer_issues bi
          WHERE bi.workspace_id = 'default'
            AND bi.issue_id = d.blocker_ref
       )
  )
`;
