# Image model Key binding acceptance (2026-10-18)

Baseline: `a36fb47fa78979417aa254afe4f3266b0d8c940f` (live v3).

## Resulting behavior

- The password field accepts direct manual edits. Saving an empty field preserves an existing binding; only the explicit unlink control removes it. Failed saves retain the pending edit for retry.
- Each ordinary account has encrypted provider profiles in a stable private server directory, independent of release roots. Identity is derived from authenticated immutable user and tenant IDs. Files have no automatic expiry.
- An immutable owner fingerprint also rejects stale forms and cached credentials after a same-name account is recreated; existing account/history/storage keys remain unchanged. Server profile and selection revisions reject stale forms. Expected account ownership is checked before reads/imports/mutations and again before model dispatch. Unlink tombstones prevent an old browser from reviving a removed Key.
- Explicit personal model IDs, provider and credentials are kept exactly as selected. Unsupported models fail without another model, provider or platform-wallet retry. Platform model aliases are retained only for explicitly selected platform supply.
- Browsing provider presets is a preview; only an explicit save, bound-API selection or wallet action changes the saved route. A verified server commit remains successful if the browser cache fails, with an accurate recovery warning.
- Interrupted Linux lock owners are recovered only with proof of process death or PID reuse. Live, malformed or unverifiable locks stay blocked; no time-based takeover occurs. A crash before owner metadata exists still requires operator recovery.
- The loaded frozen runtime changes only its background leaf; its other leaves and loaded-only platform helper are preserved. Production video assets and protected historical runtime files are outside this change.

## Regression evidence and historical fixtures

Tests cover direct editing/trusted events, provider preview versus explicit selection, save retry, server-success/cache-failure receipts, empty save, explicit unlink, late replies, equal-revision account changes, same-name account recreation, encrypted persistence, lock recovery/CAS races, endpoint scope, legacy alias collisions, first-bootstrap races, exact wire models, raw/loaded parity and zero provider dispatch after stale state, including reference-detail and image-translation adapters. The account runtime integration runs the real web adapter through the real authenticated route into an isolated encrypted filesystem. Provider responses in these tests are synthetic; they do not demonstrate paid live generation.

The previously unexecuted native video-analysis harness had four failures on the unchanged baseline. Its repairs are fixture/expectation changes only: the authoritative quote mock, billing-mode storage fixture and existing wrapped account-change error assertions. Production video files are unchanged. The native image error suite now expects strict model failure (a real behavior change) and also repairs stale quote/request/copy fixtures. Neither suite loses test cases or assertions on tenant/failure safety.

The exact deployed 755-file baseline manifest is retained as `live-v3-source-sha256.json` (SHA-256 `cb8bb7c8675c7cd1d795c09b2319fe76b7e8807299c0190dbab724cdfa560dfe`). It is evidence copied into this commit; its listed original files are verified against the baseline Git blobs rather than claiming this proof file existed in that baseline.

## Release acceptance boundary

The coordinator records the final source SHA, fresh Linux Node 22 no-cache regression report, type/lint/build exits, original 135+3 mapping audit, v2/v3 passing-case continuity, source/runtime preservation guards and traffic-switch receipt outside the application runtime. Local macOS checks are preliminary and do not substitute for Linux/live acceptance. A separate Claude desktop session completed the independent read-only review. Its executable post-fix tests, Linux validation and live acceptance must be recorded in final release artifacts before claiming release acceptance.

No migrations, seeds, tenant resets, existing record deletion, dependency installation, real Key changes or additional paid image calls are included. Reuse the three already generated synthetic account-A images for free switch/download/history checks. An independent ordinary account B is not available, so full live A-to-B-to-A acceptance remains unproven; isolated route/store/runtime account isolation is tested.

## Independent review disposition

The Claude desktop read-only review identified missing direct-path guards, misleading cache-failure receipts, collapsed safe error codes, crash lock recovery, provider-preview writes, alias-import ambiguity, immutable-owner hardening and first-bootstrap conflicts. These are addressed with executable regression coverage. Exact personal model strings are intentional. Existing browser Key caches remain for older image/video compatibility; server encryption, ownership validation and tombstones are authoritative for current dispatch. This is not a claim that browser localStorage is encrypted or that remote cache bytes are erased immediately.

Two full local macOS Node 24 attempts encountered worker shutdown timeouts with incomplete cases (4 and 14 pending beyond the original 277 skipped). They are retained as failed attempts; zero assertion failures and a JSON success flag do not qualify them as passed. Final Linux acceptance must include every original passing identity and unchanged skip identities, exact process exit checks and no worker/teardown warnings.
