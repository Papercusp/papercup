# Validation Contract — Spreadsheet Clone Phase 1

All checks assume the app is running from `docker compose up` with the frontend reachable at `http://localhost:${HARNESS_PORT:-5173}` and the backend API at `http://localhost:8000`. Use a fresh sheet id per test unless the assertion explicitly checks persistence for the same id.

### VAL-001: Sheet route renders the grid shell
**Verify:** Open `GET http://localhost:${HARNESS_PORT:-5173}/sheet/newsheet` in Playwright.
**Evidence:** HTTP status is 200 and the page shows a spreadsheet grid with visible row numbers and column headers A through Z.
**Status:** [TODO]

### VAL-002: The grid exposes exactly 100 rows and 26 columns
**Verify:** In Playwright, navigate to `/sheet/bounds`, inspect available headers, and attempt to navigate to row 100/column Z and beyond the edges.
**Evidence:** Row 100 and column Z are reachable; no row 101 or column AA cell is selectable or rendered as part of the sheet.
**Status:** [TODO]

### VAL-003: Clicking a cell selects it with a visible blue outline
**Verify:** Click cell B2 in Playwright.
**Evidence:** B2 is the active cell and has a clearly visible blue selection outline; other cells are not marked active.
**Status:** [TODO]

### VAL-004: Scrolling uses two-axis virtualization
**Verify:** In Playwright, record the number of rendered cell elements at the top-left, scroll until row 100 is visible, and inspect the DOM.
**Evidence:** Row 100 renders correctly, row 1 cell elements are absent while row 100 is visible, and rendered cell count stays within roughly three times the visible viewport.
**Status:** [TODO]

### VAL-005: Typing on a selected cell replaces its content and Enter commits downward
**Verify:** Click A1, type `42`, press Enter.
**Evidence:** A1 displays `42` and the active selection moves to A2.
**Status:** [TODO]

### VAL-006: F2 edits the selected cell without replacing the existing value
**Verify:** Put `hello` in C3, select C3, press F2, append `!`, then press Enter.
**Evidence:** C3 displays `hello!`; the original `hello` was present in the editor before appending.
**Status:** [TODO]

### VAL-007: Enter on a selected non-editing cell enters edit mode without replacing
**Verify:** Put `abc` in D4, select D4, press Enter, append `d`, then press Enter again.
**Evidence:** D4 displays `abcd`; the first Enter opened editing instead of clearing the cell.
**Status:** [TODO]

### VAL-008: Escape cancels an edit and restores the prior value
**Verify:** Put `keep` in E5, edit it to `discard`, press Escape.
**Evidence:** E5 displays `keep` and no persisted value changes after reload.
**Status:** [TODO]

### VAL-009: Tab commits an edit and moves selection right
**Verify:** Select F6, type `tabbed`, press Tab.
**Evidence:** F6 displays `tabbed` and the active selection moves to G6.
**Status:** [TODO]

### VAL-010: Arrow keys navigate selected cells within sheet boundaries
**Verify:** Select B2, press ArrowRight, ArrowDown, ArrowLeft, ArrowUp, then test arrows from A1 and Z100.
**Evidence:** Selection moves one cell per key inside the grid and remains clamped at A1/Z100 boundaries.
**Status:** [TODO]

### VAL-011: Plain strings, numbers, and booleans display as cell values
**Verify:** Enter `plain text` in A1, `123.5` in A2, `TRUE` in A3, and `FALSE` in A4.
**Evidence:** Each cell displays the entered value as a plain cell value rather than a formula or error.
**Status:** [TODO]

### VAL-012: Arithmetic formulas evaluate operators, exponentiation, and parentheses
**Verify:** Enter `=(2+3)*4-5^2/5` in B1.
**Evidence:** B1 displays `15`.
**Status:** [TODO]

### VAL-013: Cell-reference formulas evaluate and update when direct dependencies change
**Verify:** Enter `10` in A1, `20` in A2, and `=A1+A2` in A3; then change A1 to `5`.
**Evidence:** A3 first displays `30`, then displays `25` within 200 ms of changing A1.
**Status:** [TODO]

### VAL-014: Range formulas evaluate and update for SUM
**Verify:** Enter `5` in A1, `20` in A2, `=SUM(A1:A2)` in A3, then change A2 to `100`.
**Evidence:** A3 first displays `25`, then displays `105` within 200 ms.
**Status:** [TODO]

### VAL-015: Transitive dependencies recalculate within 200 ms
**Verify:** Enter `1` in A1, `=A1` in B1, `=B1` in C1, then change A1 to `7`.
**Evidence:** B1 and C1 both display `7` within 200 ms without reloading.
**Status:** [TODO]

### VAL-016: Unknown formula names render `#NAME?`
**Verify:** Enter `=FOO()` in any empty cell.
**Evidence:** The cell displays `#NAME?`.
**Status:** [TODO]

### VAL-017: Formula cycles render `#CYCLE!`
**Verify:** Enter `=A1` in A1; separately enter `=B2` in A2 and `=A2` in B2.
**Evidence:** The self-referential cell displays `#CYCLE!`; both cells in the mutual cycle display `#CYCLE!`.
**Status:** [TODO]

### VAL-018: Division by zero renders `#DIV/0!`
**Verify:** Enter `=1/0` in any empty cell.
**Evidence:** The cell displays `#DIV/0!`.
**Status:** [TODO]

### VAL-019: Out-of-range references render `#REF!`
**Verify:** Enter formulas referencing cells outside A1:Z100, such as `=AA1` and `=A101`.
**Evidence:** Each cell displays `#REF!`.
**Status:** [TODO]

### VAL-020: Formula type mismatches render `#VALUE!`
**Verify:** Enter `text` in A1 and `=A1+1` in A2.
**Evidence:** A2 displays `#VALUE!`.
**Status:** [TODO]

### VAL-021: Copying a selected formula copies raw formula text
**Verify:** Enter `=1+2` in A1, select A1, press Ctrl/Cmd+C, click A2, press Ctrl/Cmd+V.
**Evidence:** A2 contains the raw formula `=1+2` and displays the evaluated result `3`.
**Status:** [TODO]

### VAL-022: Pasting tab/newline-separated data fills a rectangular range
**Verify:** Copy the text `1\t2\n3\t4`, select A1, and paste.
**Evidence:** A1 displays `1`, B1 displays `2`, A2 displays `3`, and B2 displays `4`.
**Status:** [TODO]

### VAL-023: Backend POST and GET round-trip a sheet cell map
**Verify:** `curl -X POST http://localhost:8000/api/sheet/foo -H 'content-type: application/json' -d '{"cells":{"A1":"99"}}'`, then `curl http://localhost:8000/api/sheet/foo`.
**Evidence:** POST returns 200; GET returns a JSON body containing exactly the stored `cells` map for sheet `foo`.
**Status:** [TODO]

### VAL-024: A new sheet id starts empty and is created on first write
**Verify:** GET a never-used sheet id, POST a non-empty cell map to that id, then GET it again.
**Evidence:** The first GET returns an empty `cells` object; after POST, GET returns the posted cells.
**Status:** [TODO]

### VAL-025: Client edits persist after debounce and page reload
**Verify:** In Playwright, edit A1 on `/sheet/persist-ui`, wait at least 600 ms, reload the page.
**Evidence:** A1 still displays the edited value after reload.
**Status:** [TODO]

### VAL-026: Sheet ids are isolated from one another
**Verify:** Store `A1=alpha` in sheet `one` and `A1=beta` in sheet `two`, then GET and open both sheets.
**Evidence:** Sheet `one` shows only `alpha`; sheet `two` shows only `beta`; neither sheet leaks the other value.
**Status:** [TODO]

### VAL-027: Rapid editing 100 cells completes and persists
**Verify:** Run a Playwright script that types distinct values into 100 different cells back-to-back, waits for persistence, reloads, and checks all 100 cells.
**Evidence:** All 100 values survive reload and the full scenario completes in under 5 seconds.
**Status:** [TODO]

### VAL-028: A densely populated sheet opens quickly with bounded DOM size
**Verify:** Preload one sheet with 2,600 populated cells through the API, open it in Playwright, and measure first usable grid paint plus rendered cell count.
**Evidence:** First usable grid paint occurs in under 2 seconds on a mid-range laptop and the DOM remains virtualization-bounded.
**Status:** [TODO]

### VAL-029: Docker Compose starts both app surfaces from a clean checkout
**Verify:** Run `docker compose up --build` and request the frontend sheet route plus the backend sheet API.
**Evidence:** Frontend responds on `${HARNESS_PORT:-5173}`, backend responds on port 8000, and both continue serving after rebuild.
**Status:** [TODO]

### VAL-030: Invalid sheet API requests return 4xx without mutating stored data
**Verify:** POST malformed JSON or a payload whose `cells` field is not an object to `/api/sheet/invalid`, then GET the same id.
**Evidence:** The invalid POST returns a 4xx response and subsequent GET does not show the invalid payload stored.
**Status:** [TODO]
