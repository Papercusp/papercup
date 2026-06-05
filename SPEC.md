# SPEC — Spreadsheet Clone Phase 1

## Vision

Build a minimal viable spreadsheet clone that demonstrates core spreadsheet functionality: grid-based cell editing, formula evaluation with dependencies, and data persistence. This serves as both a demo application for Papercusp and a test harness for autonomous agent coordination.

## Scope: Phase 1 MVP

### Core Features

1. **Grid Rendering** — A fixed 100-row × 26-column (A–Z) spreadsheet grid with rows numbered and columns lettered, rendered efficiently with two-axis virtualization.

2. **Cell Editing** — Users can select cells and edit their content using keyboard shortcuts (Enter to commit downward, Tab right, Escape to cancel, F2 for in-place edit).

3. **Formula Evaluation** — Basic formula support including arithmetic operators, cell references, ranges, and error values (#NAME?, #CYCLE!, #DIV/0!, #REF!, #VALUE!).

4. **Dependency Tracking** — When a formula changes, all transitive dependents recalculate within 200 ms.

5. **Clipboard Operations** — Copy/paste raw cell contents and tab-separated rectangular data.

6. **Data Persistence** — Client-side debounce persistence to a backend API with automatic recovery after page reload.

7. **Backend API** — RESTful endpoint to store and fetch sheet data by id, with validation and isolation between sheets.

8. **Docker Compose** — Both frontend and backend start together from a clean checkout.

## Technical Constraints

- **Frontend:** Single-page application served at `http://localhost:${HARNESS_PORT:-5173}`.
- **Backend:** Node.js API at `http://localhost:8000/api/sheet`.
- **Performance:** 2,600-cell dense sheet opens in under 2 seconds; DOM stays virtualization-bounded.
- **Keyboard:** Standard spreadsheet navigation (arrows, Enter, Tab, F2, Escape).
- **Clipboard:** Ctrl/Cmd+C, Ctrl/Cmd+V support for text and formulas.
- **Isolation:** Sheet ids are completely isolated from one another.

## Out of Scope (Phase 1)

- Multi-user collaboration or sharing
- Advanced functions (VLOOKUP, conditional formatting, etc.)
- Undo/redo
- Sorting, filtering, or pivot tables
- Export to Excel/CSV
- Styling or formatting controls
- Named ranges
- Macro or scripting support

## Validation

All behavior is validated via 30 black-box assertions (see `.papercusp/validation-contract.md`). Each assertion is independently testable without knowledge of implementation.

## Dependencies

None on other harnesses. This is a self-contained demo.

## Success Criteria

All 30 VAL-* assertions pass on a fresh Docker Compose build.
