# Video recovery and source preservation — 2026-10-18

A failed plan containing a saved successful shot and an exhausted failed shot could neither retry nor start a separate plan. Explicitly choosing **新建成片计划** now preserves the old requests, results, attempts and fees, releases only the active pointer, and lets the normal Generate action estimate and submit a fresh plan from the current draft. Old 720p shots are not silently reused as new 480p generation. Retry caps remain frozen per plan.

Claude desktop independently reproduced the defects in a new isolated Code session, added failing regressions and committed `23488ec`. Root reviewed and integrated that commit, then added protection for conflicting status/state and nested task/job identities. Active, uncertain, cancellation-pending or contradictory submissions remain blocked.

Removing a draft source now checks all saved production references and in-memory plans. Source/result/reference/audio IDs are retained in one assets+runs transaction; malformed history, failed identity proof and unknown ownership preserve the local copy. Async deletion and draft writes recheck account/mode/draft identity. Source mutation locks editing and generation through final persistence/identity confirmation. This keeps old plans usable while the current draft is edited. No schema migration, garbage collector or cross-tab task-start protocol is introduced.

Root acceptance: **216/216 video tests in nine files**, **4/4 provider-error tests**, TypeScript, changed-test ESLint, JavaScript syntax, diff check and the standard Next.js build all passed (30 static pages; existing unrelated warnings remain). The four old lint errors in the portrait fixture were repaired with explicit test-boundary types, retaining all runtime assertions. A separate localhost browser verified real IndexedDB retention/deletion and stale-operation rejection with no customer records or supplier requests. See `validation.json` and the saved command logs.

Real supplier acceptance is recorded separately in `../video-live-480p-acceptance-20261018`: three 480p shots, decoded final 480 × 854, 15 seconds and complete narration. Other resolutions have free request/budget/export coverage; no additional paid resolution matrix was run.

Deployment is restricted to the reviewed Store, studio JS and HTML, in that order, with hashes, protected-process/routing checks and rollback copies. Video core, backend/provider configuration, billing tables and database schema are unchanged. Automatic portrait reporting remains a separate candidate requiring AK/SK configuration.

## Deployed acceptance

Root pushed source commit `54f91f366e3b7559f88c42a2054a903b9e8d93c0` and deployed the exact three hashes in `deployment-receipt.json` to the verified active release. The six protected PM2 PIDs, Nginx hash and expected anonymous health statuses remained unchanged. No process restart, database or provider configuration mutation occurred.

The actual old partial-success run displayed the exhausted retry button and the new-plan action. Clicking release changed only `updatedAt` and `newPlanRequestedAt`: the plan, every shot receipt, fees and draft remained unchanged, with four original runs and the saved shot still readable. A real draft-source removal retained its 1,618,218-byte historical source, invalidated rights, and persisted the draft removal; the exact pre-test draft was restored afterward. New cache versions and the atomic Store API were verified in the live page; there are no active runs. The completed 480p result remains previewable.

The separate automatic-reporting candidate `2d02cc391fc0f178c1045ed01600a49dfd8e210e` was also pushed, but was not deployed. Its related checks passed 506 Vitest cases (88 opt-in DB cases skipped) and 75 Node cases. An extra legacy analysis script retained four failures in unchanged code/fixtures; this is recorded, not treated as green acceptance of that candidate. AK/SK configuration and server/database acceptance remain separate prerequisites for enabling portrait reporting.
