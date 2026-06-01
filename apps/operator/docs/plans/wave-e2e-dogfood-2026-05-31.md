---
title: "Wave E2E dogfood (throwaway)"
slug: wave-e2e-dogfood-2026-05-31
status: superseded
created: 2026-05-31
updated: 2026-06-01
owner: aviynw3@gmail.com
---
# Wave E2E dogfood
## Now
throwaway.

<!-- plan-pipeline-status -->
**Promote-status:** 0 feature(s) in `sheets-from-template-e2e`: 0 in-flight · 0 passed

## Promoted

<!-- plan-pipeline: do not edit this block manually -->
- [ ] F-AUTO-MPUUQHMLZH9Z — E2E wave: add a column header <!-- P-001 -->
- [ ] F-AUTO-MPUUQHML9NAQ — E2E wave: cell formatting <!-- P-002 -->
## Promote
```yaml
target_harness: sheets-from-template-e2e
waves:
  - id: tier1
    features:
      - title: "E2E wave: add a column header"
        from_items: [P-001]
      - title: "E2E wave: cell formatting"
        from_items: [P-002]
```
## Phase A
- **P-001** `done` x
- **P-002** `done` y
