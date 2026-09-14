# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A collection of standalone **Tampermonkey/Greasemonkey userscripts** (`*.user.js`) that automate internal finance workflows in two Angular single-page apps:

- `https://finplan.saigontechnology.vn/*` — Purchase Orders, Payment Items (bulk approve / mark-as-paid / tag changes)
- `https://pop.saigontechnology.vn/*` — Proof-of-Payment reports (bulk approve)

There is no build system, package manager, test suite, or git repository. Each file is deployed by installing it in the browser's Tampermonkey extension. Comments and all user-facing UI text are in **Vietnamese**; keep new strings consistent with that.

## Commands

- **Syntax-check a script:** `node --check "<file>.user.js"` — the only automated validation available. Run it after editing any script.
- **Deploy:** install/update the file in Tampermonkey (drag the file into the dashboard, or paste its contents). `Finplan_Shared_Library.user.js` must be installed and enabled for every other script to work.
- There are no unit tests; real verification is manual in the target web app.

## Architecture

### The shared library is a hard dependency

`Finplan_Shared_Library.user.js` (`@run-at document-start`, matches both domains) defines two things on `unsafeWindow`:

1. **`unsafeWindow.FinplanUtils`** — DOM automation helpers used by every other script:
   `waitForElement(selectors, timeout=10000, filter)`, `waitForElementToDisappear`, `waitForElementsRemoved(els, timeout)`, `waitForLoadingToComplete(selector='.box-loading', timeout=30000)`, `waitForServerResponse` (waits for a `div[aria-label="Error"|"Success"]` toast), `findAncestorRow(el, selector='TR')`, `findElementInSameRow(el, selector, filterFn, rowTag='TR')`, `simulateClick(el)` (dispatches `mousedown`+`mouseup`+`click`), `sleep(ms)`, `isVisible(el)`.

2. **Floating Button Manager** — a single shared bottom-left vertical stack of pill buttons so multiple scripts don't overlap. API (also on `FinplanUtils`): `registerButton(id, {icon, text, tooltip, onClick, visible, order})`, `unregisterButton(id)`, `setButtonVisible(id, visible)`, `updateButton(id, partial)`. Max 3 visible; extras collapse into a "(n) more..." popup. Ordering is `order` asc then `id` asc (stable across load order).

**Getting a reference to `FinplanUtils` — one pattern, in all five consumers.** The shared library exposes no readiness hook (and one wouldn't help — Tampermonkey doesn't guarantee inter-script load order), so every consumer polls:
- Holds it in module-scope `let utils = null;`.
- Populates it via an identical local helper `waitForFinplanUtils(timeout = 15000)` (polls `unsafeWindow.FinplanUtils` every 100 ms; rejects with `Không tìm thấy FinplanUtils (Finplan_Shared_Library chưa được nạp hoặc đang tắt).`).
- Does all `utils.*` work only *after* the `await` resolves. The three list-page scripts wrap their bottom `setInterval(checkUrl, 2000); checkUrl();` in an `(async () => { try { utils = await waitForFinplanUtils(); } catch (err) { console.error('[<name>]', err.message); return; } … })();` IIFE; `PoP_Auto_Approve` and `Mark_Auto-Charge_Items_Paid` `await` inside their `async function init()`.
- New or reworked consumer scripts must copy this helper verbatim and follow the same shape. (`Copy_Part_Column.user.js` doesn't use `FinplanUtils` at all.)

### Common structure of the bulk-action scripts

`Approve_All_Items`, `Approve_All_POs`, `Mark_All_as_Paid_Clean_Quotes`, `PoP_Auto_Approve` all share the same three-block layout (stated in each file's header comment):

1. **Processing loop** — `findNextApproveTarget()` / `processSingleX()` / `startProcessing()`. Each iteration scans the page for one not-yet-handled row, clicks its action button, handles the confirm modal, and waits for the loading overlay to clear. The row is pushed into an in-memory log array (`itemLog` / `reportLog`) **as soon as it's found**, so a failed row is never retried in the same run. Log entries are `{ <idField>, status: 'processing'|'success'|'error', message }`. An `isRunning` flag is the stop signal; the loop checks it between steps.
2. **Floating button** — registered via the shared Button Manager with a hardcoded stable `BUTTON_ID`. It only *launches* a run or re-opens a hidden progress dialog; it does not reflect run state.
3. **Floating progress dialog** — draggable modal rebuilt from scratch on every state change via `renderDialog()` + `build*()` helpers. Drag position is persisted to `localStorage` under a per-script key (`aai_dialog_position_v1`, `aap_dialog_position_v1`, `map_dialog_position_v1`, `ppa_dialog_position_v1`, `fpmp_modal_position_v1`). Footer actions: Dừng lại (stop) / Ẩn cửa sổ (hide, keep running) / Đóng.

### SPA navigation handling

The finplan app never does a full page load on route change. Scripts that should only be active on specific list pages keep an `ALLOWED_URLS` array and `setInterval(checkUrl, 2000)` to register/unregister their button as the user navigates. Exceptions:
- `PoP_Auto_Approve` — its `@match` is already scoped to `pop-reports*`, so it registers its button once with no URL polling.
- `Copy_Part_Column` — uses a `MutationObserver` on `document.body` to re-inject its button whenever Angular re-renders the table; does not use the shared library or Button Manager.

### Notable per-script differences

- **`Mark_Auto-Charge_Items_Paid.user.js`** is the outlier. It persists full job state to `localStorage` (`fpmp_autocharge_job_v1`: `{ids, index, stopped, log[]}`) so a run survives the page reloads it triggers while navigating item detail pages built from `BASE_URL`. Each item has three independent stages (`tag`, `paid`, `postCheck`), each recorded separately. It moves the tag `Ready for Auto Charge` → `Ready for Auto Charge ► Checked`.
- **`Mark_All_as_Paid_Clean_Quotes.user.js`** bundles two unrelated features: the bulk "Paid" / "Cash Advanced" loop (rows tagged `Tạm ứng` get "Cash Advanced" instead of "Paid"), and a small "Clean Quotes" button injected next to the search box that strips stray `"` characters from pasted item codes and re-triggers search. Only the first uses the Button Manager.

### Recurring DOM selectors in the target apps

`table.m-datatable__table` (data grids), `.box-loading` (loading overlay), confirm-modal primary button `.button_dialog .btn-primary, .modal-footer .btn-primary, .modal-content .btn-primary`, result toast `div[aria-label="Success"]` / `div[aria-label="Error"]`, payment-item number `.cell-body-part .text-bold`.
