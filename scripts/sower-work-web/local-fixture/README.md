# Isolated actual-component UI fixture

This launcher uses Node 24, the real macOS AionCore bundle, an independent control/engine runtime, the prior verified renderer/vendor snapshot, and a development copy of current cloud runtime scripts. It creates no final release. Studio, Wallet, frame status, CSS and required contracts are exact byte copies recorded in `copied-components-manifest.json`.

The outer server binds to `127.0.0.1` and is opened at its single `http://localhost:PORT` origin. Only this Host/Origin and the local fixture cookie are accepted. Once validated, cloud requests are rewritten to the existing canonical inner bridge; production origin policy is never changed. The fixed fixture administrator and credits are synthetic and visibly marked. Provider configuration writes and model/message/task execution writes are blocked. Only model-less conversation creation, uploads, the detail editor and cloud workbench writes are allowed.

Start with new session paths; the process stays in the background:

```sh
node scripts/sower-work-web/local-fixture/index.mjs start --session /absolute/new/fixture-session --port 33080 --bridge-port 32170
```

The result prints the UI URL and state path. `/_fixture/health` reports server readiness and local execution-block counters. Use the printed URL in a browser. This is a development UI fixture, not production acceptance or real wallet/provider verification.

For a sealed runtime, add `--base-release /absolute/sealed-release --runtime-source release`. This copies both vendor and runtime bytes from that release, while the outer Next components remain exact copies of the current website sources. The fixture itself remains a local test environment and creates no new final release.

Server-only verification (no browser automation):

```sh
node scripts/sower-work-web/local-fixture/verify.mjs --session /absolute/fixture-session --evidence /absolute/server-probe.json
```

The probe checks live engine health, fixture wallet/ledger markers, empty provider configuration, Host/Origin/cookie boundaries, execution-write rejection, real model-less conversation creation and component copy hashes. Run it only against disposable fixture sessions; its model-less conversation is removed with the runtime at shutdown.
Add `--read-only yes` when checking a retained final fixture: it uses GET requests only and omits execution-write probes and conversation creation.

Stop and verify cleanup:

```sh
node scripts/sower-work-web/local-fixture/index.mjs stop --session /absolute/fixture-session
```

Stopping closes proxy/auth/Next/runtime child groups and removes the disposable runtime and Next cache. Component copies, manifests and logs remain for review. Copy wanted generated images/exports into your evidence directory before stopping. Restart verification uses a fresh session path and copies the latest source again.
