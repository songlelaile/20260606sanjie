# Image Studio Optimization — Claude Source Review (2026-10-17)

- Branch: `codex/image-studio-optimize` (base `d161f31`), worktree `/Users/shaozhuang/.codex/worktrees/image-studio-optimize/6.6新三阶`
- Scope: read-only source review. No builds, tests, browsers, live model requests, or app-source edits were performed. **Nothing in this document is live acceptance.** Every finding is from reading source, and each one needs to be verified in a running studio.
- Files reviewed: `src/components/creative/CreativeStudio.tsx` and `CreativeStudio.module.css`; `public/creative/labs/image-prompt-lab/{promptlab.html, workspace-ux.css, studio-genesis-ui.js, image-archive-store.js}`; `public/creative/web-chrome.js`. I also read these dependencies only where a finding needed them: `studio-genesis.css`, `promptlab.js` (account-key and setApiBusy paths), `background.js` (account-key derivation), `src/middleware.ts`, `src/app/api/creative/assets/[...path]/route.ts`, and `src/lib/creative-history-entry.ts`.
- Concurrent edits: Codex's uncommitted diff was read at two points during the review. Line numbers refer to the working tree at review time and may drift as the diff keeps changing.

## Summary

| # | Severity | Area | Finding |
|---|----------|------|---------|
| 1 | High | Performance / reliability | Every surface iframe loads the full 38-script + 13-stylesheet bundle. These requests count against a 300/min per-account asset rate limit and are revalidated on each load. |
| 2 | High | Multi-tenant reliability | A transient `/api/auth/me` failure is treated as an account change and blocks the iframe permanently. Archive and storage writes then fail until reload. |
| 3 | Medium | Performance | Each storage operation and each IndexedDB transaction does its own uncached `/api/auth/me` round trip, and every cached iframe re-checks auth on focus and visibility events. |
| 4 | Medium | Performance / memory | The number of cached iframes is unbounded, and the shell polls `getTaskState()` on every frame once a second, even while the tab is hidden. |
| 5 | Medium | Tenant isolation (concurrent edit) | The new archive identity gate is correct, but the account-key derivation is duplicated in four places, and an account that is not yet ready is reported as "account changed". |
| 6 | Medium | Responsive layout | The iframe height is fixed at `100dvh - 180px` while the chrome above it grows with notices and task rows, so pages get nested scrolling exactly while tasks run. |
| 7 | Low–Medium | Concurrent edit | The new rAF-batched `scheduleRender` also defers `setApiBusy` and credit hints, and rAF does not run in background tabs and may not run in `display:none` cached frames. |
| 8 | Low | Duplicate UI | The breadcrumb merges two separate workspaces, icons repeat, and there are two batch entry points. |

---

## Finding 1 — High: Full bundle per iframe vs. per-account asset rate limit

**Evidence**
- `promptlab.html:105-119` loads `web-chrome.js` plus 13 stylesheets. `promptlab.html:1857-1893` loads another 37 scripts unconditionally, whatever the `mode`/`tool` is. The largest are `promptlab.js` (~1.36 MB), `background.js` (~0.89 MB), `reference-detail-batch.js`, `studio-genesis-ui.js`, and `reference-detail-blueprint.js` (~130–140 KB each), all unminified.
- `CreativeStudio.tsx:142-146, 613-618` keeps one iframe per visited cached surface. There are up to 12: main, detail, ad, batch, mirror, list-main, list-legacy, reference, sku, and the 3 viral surfaces. Each one is a separate `promptlab.html` load.
- `src/middleware.ts:55-59` sends every `/creative/*` request through `consumeSecurityRateLimit("web-assets", account, 300, 60)`. `route.ts:87-89` serves JS/CSS with `Cache-Control: private, no-cache`, so every reload or new iframe revalidates each file. A 304 response is still a request that the middleware counts first.

**User impact:** One iframe costs about 52 counted requests (the HTML, 38 scripts, and 13 stylesheets). If a user opens about 6 surfaces within a minute, the account passes 300 requests. The same happens with 2–3 browser tabs of the same account, because they share the budget. Later script loads then get 429, the iframe ends in `labStartup = "error"`, and the shell shows "工作台暂未就绪". Memory and parse cost also grow with each visited surface. This is plausible from source; I did not reproduce it live.

**Safe fix (no mode removed)**
1. When the URL has `?v=` (all tags already have one), serve JS/CSS with `Cache-Control: private, max-age=31536000, immutable` while keeping `Vary: Cookie`. Keep `no-cache` only for unversioned requests and the HTML. The first fetch stays behind the same authorization gate, and later iframes are served from the browser cache without reaching the middleware.
2. Do not count 304 and cache-hit asset requests in `web-assets`, or count one unit per page load (the HTML) instead of one per file.
3. Medium term: declare a per-mode script manifest in `promptlab.html`, for example a small loader that maps `mode`/`tool`/`studio` to the scripts they need. Keep `promptlab.js` and `background.js` as the shared core, and load the mirror, link-image, SKU, reference and viral modules only for their modes. Existing bridges (`SanjieStudioGenesisBridge`, `SanjieLinkImageBridge` and others) keep their names.

---

## Finding 2 — High: A transient auth failure becomes a permanent account lockout

**Evidence:** `web-chrome.js:673-692` (`global.authCheck`):
- `.then(response => response.ok ? response.json() : null)`: any non-2xx response, including 5xx, gives `body = null`.
- `if (!data ...) { if (pinnedAccount) blockAccount(); ... }`, and `.catch(() => { if (pinnedAccount) blockAccount(); })`.
- `blockAccount()` (`web-chrome.js:145-157`) sets `accountBlocked = true` permanently, so every later `authCheck()` returns `account_changed`.
- `src/middleware.ts:51-52` can return **503 `SECURITY_UNAVAILABLE`** for any request, including `/api/auth/me`.
- Every `chrome.storage.*` operation (`storageArea → operation → requireAccount`, around `web-chrome.js:236`) and every archive transaction (`image-archive-store.js:334+`, `openDb` → `SZ_WEB_ACCOUNT.require()`) depends on `authCheck`.

**User impact:** A single network blip, a proxy 502, or a security-service 503 while a generation is running marks the iframe as "account changed". All later receipt and draft persistence and every archive save in that iframe fail until reload. A paid result can survive only as a pending receipt, and the overlay tells the user their login changed when it did not. Each cached iframe is affected on its own.

**Safe fix:** Only call `blockAccount()` when the response proves a change: a 200 response with a different `tenantId:username`, or a 401/403. For network errors, 5xx and 429, return `{ ok: false, reason: "auth_transient" }`, leave `pinnedAccount` unchanged, and retry with backoff (for example 1 s, then 3 s, then 10 s). Callers keep throwing a retryable `ACCOUNT_UNAVAILABLE` (the existing code), so writes are rejected and never land under the wrong tenant. Account isolation is unchanged; only false positives are removed.

---

## Finding 3 — Medium: One auth round trip per storage operation and per IndexedDB transaction

**Evidence**
- `authInFlight` (`web-chrome.js:675-676`) only deduplicates *concurrent* calls inside one window. There is no time-to-live (TTL) cache.
- `image-archive-store.js:1583-1595` `list()` runs `purgeExpired` → `recordsForAccount` (a transaction), then sometimes `permanentlyRemove` and `removeEmptyBatches` (two more transactions), then `recordsForAccount` again, and sometimes another `permanentlyRemove`. Every transaction calls `openDb()` → `SZ_WEB_ACCOUNT.require()` → a `no-store` fetch of `/api/auth/me`. `summary()` behaves the same way, and each `saveResult`/`saveProvisionalResult` uses at least two transactions.
- `web-chrome.js:695-700` registers `focus`, `pageshow` and `visibilitychange` auth refreshes **in each iframe**, so N cached frames send N parallel `/api/auth/me` requests whenever the tab becomes visible again.

**User impact:** Opening history costs 2–5 *sequential* auth round trips. With 100-way generation concurrency (`studio-genesis-ui.js:238`, `concurrency:100`), archive saves serialise behind auth fetches. Server load also rises, since each `/api/auth/me` runs a database check.

**Safe fix:** Do one identity check per *logical operation* rather than per transaction. Resolve the account once in `list`/`summary`/`save*`, open IndexedDB once, and pass the `db` and the verified key to the inner transactions. The concurrent `openDb(expectedAccountKey)` check can stay at that single entry point. Optionally, cache a *successful* identity for 2–3 s and invalidate it on `focus`/`visibilitychange`/`pageshow` or on a 401. Let the parent shell share its auth result with frames through `postMessage` so N frames do not each fetch.

---

## Finding 4 — Medium: Unbounded iframe cache and unconditional 1 s polling

**Evidence**
- `CreativeStudio.tsx:170-173, 390-392` only ever adds ids to `visitedWorkflows`, and `613-618` renders all of them, so nothing is ever evicted.
- `CreativeStudio.tsx:241-295`: `setInterval(readTasks, 1000)` calls `getTaskState()` on every visited task frame. It does this even while `document.hidden` is true, and it compares results with `JSON.stringify(previous) === JSON.stringify(next)`. `busyCachedLabel()` repeats the same scan.
- `studio-genesis-ui.js:643-654` `getTaskState()` rebuilds every task row, scans all retained workspaces, and computes groups and `planProgress` on each call.

**User impact:** Each visited surface keeps a full JS realm alive, with its own timers, listeners and `background.js` instance. Once 5–10 surfaces have been visited, the shell spends main-thread time every second walking task state in every frame, including in background tabs. That time competes with the studio's own rendering and drains battery on laptops.

**Safe fix (keeps pending-receipt and history behavior)**
1. Skip `readTasks` while `document.visibilityState === "hidden"`, and run it once on `visibilitychange` back to visible.
2. Have each bridge post a cheap event, `window.parent.postMessage({ type: "sanjie:task-state", id, activeCount, pendingReceiptCount, summary }, origin)`, when its counts change. Keep a 5 s poll as a fallback.
3. Add LRU eviction of idle frames beyond about 4. Evict a frame only when `getTaskState()` reports `!busy && activeCount === 0 && pendingReceiptCount === 0` and `canDeactivate()` returns `allowed`. **Never** evict a frame that has pending receipts. An evicted surface reloads from its persisted draft the next time it is opened.

---

## Finding 5 — Medium: Archive tenant gate (concurrent edit): correct, but the key derivation is fragile and the error is misleading

**Evidence (working tree)**
- `image-archive-store.js:330-332` adds `webAccountKey(id)`, and `openDb(expectedAccountKey)` (`334+`) now rejects whenever `normalizeAccountKey(expectedAccountKey) !== webAccountKey(currentId)`. Every `transaction(...)` caller now passes its account key. This is a real isolation improvement: previously a hosted caller holding `'local'` could write into a bucket shared by every user of that browser.
- The same `"user:" + id.replace(/[^\w@.+:-]/g, "_").slice(0,120)` formula now exists in four places: `web-chrome.js:199-201` (`profileKey`), `background.js:542-546` (`configAccountKeyFromAuth`), `image-archive-store.js:330-332`, and an inline copy at `image-archive-store.js:1400-1403` (`purgeAllExpired`). The `background.js` version also differs: it falls back through `userId/uid/email/username/...`, while the archive version uses only `auth.user.id`.
- Hosted callers can still arrive with `'local'`: `promptlab.js:11857/11893` uses `state.archiveAccountKey || 'local'`, and `queueArchiveResult` (`promptlab.js:713-717`) uses `state.archiveAccountKey` before the profile has resolved.

**User impact:** If any one of the four formulas drifts, or the `background.js` fallback chain ever picks a different field, *every* archive read and write fails with "登录账号已变化…". That error tells the user to refresh, and refreshing does not help. Saves made before the profile is ready (`'local'`) also get that misleading message instead of "account not ready".

**Safe fix:** Export one helper, `SZ_WEB_ACCOUNT.storageKey(id)`, from `web-chrome.js` and use it in all four places, with `purgeAllExpired` reusing `webAccountKey`. Add a parity unit test (key format and truncation). In `openDb`, report a missing or `'local'` expected key in hosted mode with a distinct code (`ARCHIVE_ACCOUNT_NOT_READY`) and a "please wait and retry" message. Keep the gate itself.

---

## Finding 6 — Medium: Fixed iframe height under variable-height chrome

**Evidence:** `CreativeStudio.module.css:168-175` sets `.frame iframe { height: calc(100dvh - 180px); min-height: 480px }`. In the working tree this changed from `100dvh - 100px` and `640px`. Above the frame, `CreativeStudio.tsx:573-611` renders the toolbar, `<CreativeCredits />`, up to three notice rows, and a background-task panel with **one row per busy surface**. At ≤760 px wide, `CreativeStudio.module.css:280-283` sets `min-height: 560px`, and the rail becomes a two-row grid.

**User impact:** While tasks run, when users most need to watch progress, the task panel pushes the iframe below the fold. The page then has two vertical scrollbars, and the iframe's own footer actions (generate, download) sit beneath the outer scroll. On phones the 560 px minimum plus the wrapped rail always forces outer scrolling.

**Safe fix:** Bound `.studio` to the viewport (`height: calc(100dvh - <app header>)`) and make `.workspace` a flex column. Set `.frame { flex: 1; min-height: 0 }` and give `.frame iframe`/`.cachedFrame` `height: 100%`, with no `calc`. Collapse the background-task panel to a single summary line (`taskOverview`) with a disclosure for per-surface rows; the existing "返回原任务" buttons stay inside the disclosure. On mobile, replace the `560px` minimum with `min-height: 70dvh`.

---

## Finding 7 — Low–Medium: `scheduleRender` (concurrent edit) also defers `setApiBusy` and credits

**Evidence:** In `studio-genesis-ui.js:311-317`, the controller `onChange` now calls `scheduleRender()` instead of `render()`. `scheduleRender` (`888-901`) paints with `requestAnimationFrame`. `render()` (`902-908`) is also the only place that calls `bridge.setApiBusy('studio-genesis', locked())` and `renderCredits()`. `setApiBusy` bumps `configReadEpoch` when busy flips (`promptlab.js:24017-24020`). rAF is paused in background tabs, and some engines, notably Firefox, do not run rAF for `display:none` iframes. Inactive cached frames are hidden with `hidden` → `display:none !important` (`CreativeStudio.module.css:294`).

**User impact:** While the tab or frame is hidden, the API-busy flag and credit hints stay stale until the next paint. The error is mostly conservative, because busy stays true longer. However, config reads keyed on `configReadEpoch` are not invalidated when a background task finishes or starts through receipt recovery. Task counts in the shell are not affected, because `getTaskState()` reads controller state rather than the DOM.

**Safe fix:** In `scheduleRender`, call `bridge.setApiBusy('studio-genesis', locked())` synchronously (it is cheap) and defer only the DOM work. Fall back to `setTimeout(paint, 16)` when `document.visibilityState === 'hidden'`. Separately, `closeModal` (`1215-1219`) should return focus to the element that opened the preview, which is an accessibility regression compared with a native dialog.

---

## Finding 8 — Low: Duplicate or ambiguous navigation

**Evidence:** `CreativeStudio.tsx:473-479` shows the breadcrumb "主图与详情" for both `main` and `detail`, but these are *separate* cached iframes with separate drafts and tasks (`STUDIO_SURFACES`, `:139`). `ImageIcon` is used for both 主图 and 链接成图, and `WandSparkles` for both 广告图 and 产品精修 (`:70-120`). Batch has two entry points: the rail `batchNav` (`:557-570`) and the toolbar "创建批量任务" (`:579-587`).

**User impact:** Users cannot tell from the header which workspace holds their task. Repeated icons slow scanning, especially in the mobile horizontal rail, where labels wrap.

**Safe fix:** Use `current.label` in the breadcrumb, give each surface a distinct icon, and show the toolbar button only as the contextual "返回单个创作" while in batch mode, keeping the rail entry. No surface is removed, and legacy surfaces stay reachable by URL and background-task recovery.

---

## Notes on the concurrent edits (working tree at review time)

These look correct to me and preserve the existing behavior:
- `removeEmptyBatches` now counts and deletes inside one `readwrite` transaction, which closes the cross-tab race. It relies on the `archiveBatchId` index, which is created in the upgrade path (`image-archive-store.js:366`).
- `openDb` has a timeout, `onblocked` and `onversionchange` handling, and closes late connections. `transaction()` closes the database on every exit path.
- `summary()` now reads records once instead of calling `list()` twice.
- `syncResultSelection()` replaces full re-renders for checkbox changes, and the preview modal clears its `<img>` on close, which frees decoded memory.
- `requireAccess` makes one auth trip instead of two.
- The cache-busting `?v=` values were bumped for every edited asset in `promptlab.html`. Because assets are `no-cache` + ETag, this matters mainly for proxies, but it is good practice.
- The mobile breakpoints in `workspace-ux.css:213-240` restore single-column layouts. This resolves the specificity conflict that would otherwise let the unconditional `.sg-replica .sg-workspace` two-column rule (`workspace-ux.css:23`) override `studio-genesis.css:267`.

Watch items:
- `creative-history-entry.ts`: the new post-open check `bridge.archiveContext().accountKey !== account` runs *after* `openHistory` has already displayed the modal. If it fails, close the modal before rejecting so another account's list is not left on screen.
- `openDb`'s `onblocked` handler rejects immediately, while the native request would have succeeded once the other connection closed. With `onversionchange → close()` now in place this should be rare. A retry on the next call is fine, but users may see the "旧工作台占用" message once during a deploy that bumps `DB_VERSION`.
- With the `:has(> .sg-workspace)` grid at ≥1100 px (`workspace-ux.css:70-75`), the hero and top-actions are pinned to row 1. The legacy-draft banner (`legacyBanner()`, rendered first in the DOM) is therefore auto-placed *below* the hero, which visually reorders an important recovery notice. Pin the banner to `grid-row: 1` and shift the others, or render it after the hero.

## Verification still required (not done here)

- Live: open 6 or more surfaces within one minute and watch for 429 responses on `/creative/*` (Finding 1). Simulate a 503 from `/api/auth/me` during a generation and confirm the iframe recovers (Finding 2).
- Count `/api/auth/me` requests while opening history and on tab refocus with several cached frames (Finding 3).
- Profile the shell with 6 or more cached frames, with the tab visible and hidden (Finding 4).
- Check the layout at 375 px, 768 px, 1280 px and 1920 px with 2 or more background tasks running (Finding 6).
- Regression suite for pending receipts, history isolation per account, and credit display after the concurrent changes. I did not run it.
