---
title: [throwaway] notify-path verification (session e36df27a resume)
slug: zzz-notify-verify-2026-05-31
status: active
created: 2026-05-31
updated: 2026-05-31
---

# [throwaway] notify-path verification (session e36df27a resume)

## Now

**State:** Draft. Plan body to be filled in.

**Next:** human reviews scope and lists Phase 1 items.

## Background

(Why this plan exists; what problem it addresses.)

## Phase 1 — TODO

(Use plans:add-item to populate. Each item is one line:
single id, status token, free text, optional blocked-by.)


## Phase 1 — Verify

- **P-001** `needs-human` Throwaway item flipped to needs-human/urgent to fire a real attention.notify push. importance: urgent (verification probe — fires attention.notify)
- **P-002** `needs-human` Second throwaway item — re-fire attention.notify now that the webview SSE is connected. importance: urgent (verification probe 2 — SSE now connected)
- **P-003** `needs-human` Third throwaway item — fire attention.notify after wiring DesktopAttentionNotifier into operator-vite. importance: urgent (verification probe 3 — notifier now mounted in operator-vite)
- **P-004** `needs-human` Fourth throwaway item — fire with SSE confirmed open post-reload. importance: urgent (verification probe 4 — SSE confirmed open)
- **P-005** `todo` Fifth throwaway item — replica-handler end-to-end proof. importance: urgent (replica proof) (reset to re-fire as P-006 equivalent)





## Decisions

(Use plans:add-decision to append. Each decision is a third-level
heading with a date line and a body paragraph.)
