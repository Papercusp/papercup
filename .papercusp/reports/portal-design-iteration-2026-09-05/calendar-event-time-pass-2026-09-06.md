Calendar event labels — completed 2026-09-06

Work: WI-2147155 / P-005, portal-design-iteration-2026-09-05. The existing Calendar toolbar/container fixes were already present. This pass repaired the remaining event-label clipping and verified the composed Calendar surface.

The portal imports the operator's shared `:where(button, .pc-btn)` baseline, which sets `display: inline-flex` and centers content. Calendar's event chip did not declare its own display mode. That made its time span and title flex items, centered across a chip narrower than their combined width. In the actual portal at 1440×900, the time began 24.81px outside a 103.14px chip, hiding the start digits.

The fix adds `display: block` to Calendar's existing scoped `.event-chip` rule. Time and title now remain one text line, so the existing ellipsis cuts the end of the label. The source is `/home/marsh-office/papercupai-workspace/calendar/packages/ui/src/styles.css`; Calendar's registered pot path and staging branch were verified before editing. The shared button baseline is unchanged.

The rebuilt portal release `TJuwLhkMI4Q8N69bJTIST-20260906033829389-1553586-1c1bca33` was published and handed to the existing portal service. The deployment helper confirmed a matching source digest and a successful health check. These checks were made on actual :3081 after a fresh navigation, with no temporary inline style:

| Check | Result |
| --- | --- |
| Light, 1440×900 | Start time fully inside the 103.14px chip; left inset 10px; ellipsis retained |
| Dark, 900×800 | Start time fully inside the 72.28px chip; left inset 10px |
| Dark, 2300×1000 | Start time fully inside the 200.56px chip; left inset 10px |
| Toolbar and month grid | No horizontal overflow in the checked laptop and compact layouts |
| Event selection | Opens the matching event inspector |
| Keyboard focus | Event button receives focus after the layout change |
| Week / Day / Agenda | View switching works; seven week headings, day grid, truthful empty Agenda range |
| Preference cleanup | System theme restored; GET /api/preferences confirmed preferences.theme=system |

All three screenshots were opened and inspected: [light laptop](calendar-event-time-light-1440.png), [compact dark](calendar-event-time-dark-900.png), [wide dark with inspector](calendar-event-time-dark-2300.png).

The existing responsive-layout, UI-composition, and calendar-model suites passed 10 tests with zero failures or skips. Exact-file testing receipt: `3b10db06-2b3d-4685-8fb7-2dbeb3f19995`. The production build completed with exit 0; its durable log is `.papercusp/scratch/bash-bae30976-9f9.log` in the Papercusp tree. `git diff --check` passed. No event was created, edited, or deleted. Full cross-portal accessibility and layout auditing remains under P-010.
