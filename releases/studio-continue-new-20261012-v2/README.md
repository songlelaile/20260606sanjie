# Studio continue generation V2

This directory contains the image studio component snapshots and their offline regression tests. It is not the complete website source or a standalone website. The repository's older default branch does not contain all of the production site.

The update gives an explicitly requested new image generation its own task identity while preserving the original pending request. It retains edited plans and late results, rejects replacement of an unresolved plan under the same task identity, and protects stored drafts from stale browser tabs. Completed current plans do not offer a new-generation action merely because an older request remains pending.

## Contents

- `assets/public/creative/labs/image-prompt-lab/`: release component snapshots.
- `tests/`: receipt UI, deep UI, plan-copy, concurrent-receipt, late-receipt, storage-lifecycle, inherited draft-recovery, and recovery-row CAS tests, with a shared browser fixture.
- `manifest.json`: SHA-256 hashes and production-freeze status. `image-upload.js` is an existing helper needed by the test fixture, not a changed production file in this release.

All five production component snapshots are frozen and recorded in the manifest, with before/after hashes against `studio-draft-recovery-20261012-v3`. The new baseline’s mixed-draft migration, explanatory banner, and read-only original-task view are retained. Online deployment is pending; the snapshots and test results do not establish a live release.

## Run the offline tests

Use Node.js and the repository's installed Vitest dependency:

```sh
node releases/studio-continue-new-20261012-v2/run-tests.mjs
```

An existing dependency installation can also be supplied explicitly:

```sh
node releases/studio-continue-new-20261012-v2/run-tests.mjs --node-modules /path/to/node_modules
```

The runner always loads the included assets, requires native receipt recovery, and ignores external contract overrides. Storage-lifecycle tests read the frozen views bundle; other suites use the included component sources. Tests use in-memory storage, synthetic account identifiers, synthetic API keys, and fixture image URLs; they make no model, billing, or production API calls. No real accounts, images, receipts, or credentials are included.

Offline validation on the included frozen snapshots: **8 files, 119 tests passed** with Vitest 4.1.8.

The 24 inherited recovery cases retain their full assertions; checkpoint comparisons explicitly validate the new storage revision before comparing the complete retained payload. Two additional cases protect recovered rows from stale tabs and keep main/detail storage revisions independent.

The tests cover repeated clicks, edited pending plans, late replies, refreshed tasks, mixed batches, saved image-type plans, account/storage errors, concurrent browser tabs, and project/workspace changes. Passing them verifies local behavior only; it does not prove paid generation or a live deployment. Nothing in this directory automatically publishes the website.
