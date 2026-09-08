# Dreaming settings concepts

Design deliverable for WI-10000833, requested by Avi on 2026-09-08. Open `index.html`; the A/B/C tabs, switches, search, and mode menu are interactive. All data is illustrative and no control calls a service.

- A: independent Learning and Dreaming switches in the all-pots list. Recommended for visibility; a pot opens its detailed settings.
- B: separate cards within a pot’s settings, including Dreaming’s idle behavior, spending limit, and manual start. Pairs well with A.
- C: a compact Dreaming mode selector: Off, Manual only, When idle. Keeps the distinction between permission to run and automatic scheduling visible.

Current source places `DreamControl` immediately after the learning master in `LearningPotDrawer.tsx`. It exposes manual Start/Pause and an Auto-dream checkbox, behind `FLAGS.DREAM_CYCLE`. The current backend still gates Dreaming on the learning master.

These concepts propose independent Learning and Dreaming settings. Implementing that independence requires a separate per-pot Dreaming permission and a corresponding change to admission, not just new UI labels. Keep the existing distinction between enabled, actually running, and paused by budget; disabling must remain available at a budget/error boundary. Turning either setting off must not erase the other’s saved settings. A global pause may still pause both without altering them. New pots default to Dreaming off. Showing this proposal does not change the current default-OFF Auto-dream setting or start a run.

Reuse: existing LearningPotPicker/LearningPotDrawer entry points and current Button/Checkbox/Modal styles; registry `control.checkbox`, `control.text`, `control.select`, `action.primary`, `action.secondary`. The registry’s checkbox entry points to the current harness primitive; a switch presentation is a concept treatment of that controlled boolean, not a proposed parallel UI framework. UI IR is in `ui-ir.json`.

The approved paid Dream study and shipment work remain on WI-10000445 / WI-40148. D-016 records Avi’s actual spending/master authorization; this mockup task does not replace that work.
