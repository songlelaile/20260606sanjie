# Online image studio UAT — 2026-10-18

The user configured the test BYOK profile in the browser. Credentials were not
read or recorded. Exactly three generation requests were submitted: one main
image, one detail screen, and one advertisement image. There were no retries,
AI analysis requests, credit changes, tenant creation, migrations, seeds or resets.
All input material was a synthetic, unbranded orange travel mug.

## Observed delivery before this correction

| Surface | Count | Decoded PNG size | Bytes | SHA-256 |
| --- | --- | --- | --- | --- |
| Main | 1 | 1254 × 1254 | 1302248 | `2087a8a5a1e1af03f31030b33c4785a9274d7f45ae8b4f0bad79203e7d7d9dc1` |
| Detail | 1 | 1086 × 1448 | 1528207 | `8188e20531f520b1e53a6c9cba06decbe12ad5a2e40481a66481f8cb8a561399` |
| Advertisement | 1 | 1254 × 1254 | 1594061 | `4b16419eda67f6e37b3df8546ba55c33384565d9d1c2d028c09ea86a9678d2db` |

Each completed result was archived in the current browser's account-scoped
history. Full refresh restored each workspace, input, plan and completed image.
History downloads of all three files matched the first downloads byte for byte.
Switching surfaces during generation retained the original request and result.

The embedded browser did not capture downloads initiated inside the iframe.
Opening the same workspace URL as a top-level page restored the same result;
its normal download button delivered the files listed above. No regeneration
was used for this workaround. The embedded iframe download remains a distinct
browser acceptance limitation, not a proved missing-original defect.

## Corrections

1. The main receipt journal used a string prefix that also matched the nested
   advertisement workspace. Reads now verify the complete stored job key.
   Existing keys are unchanged. Recovery removes only a current controller's
   orphan mirror with a complete, same-account durable identity proving another
   workspace; it never deletes that workspace's original journal or resubmits.
   Unknown or malformed receipts remain preserved and fail closed.
2. Advertisement archives lost their subtype because both use the main storage
   surface. New archives derive `creativeRoute=ad` from the original structured
   studio plan. History gains the advertisement label and filter, and checks the
   actual ready workspace type before enabling or opening guided regeneration.
   Database version, account checks, Blob bytes, storage surface and archive IDs
   are unchanged.

Both raw modules and the actual loaded frozen leaves were updated and checked.
The runtime, views and promptlab cache revisions were advanced together.

Existing archives without structured subtype evidence are not guessed or
rewritten. In particular, the advertisement generated before this correction
retains its original main classification. Legacy uncertain receipts without
workspace proof also remain preserved rather than silently declared complete.

## Validation of this correction

- Full local suite: **3844 passed, 0 failed, 277 skipped**; 4121 total.
- Typecheck: passed. Standard lint: 0 errors, 52 existing warnings.
- Standard complete Next.js build: passed.
- Dedicated scope, receipt recovery, archive, history, startup, bridge and actual
  loaded-runtime checks passed, including main/ad prefix collision cases and
  fail-closed malformed, unknown, foreign-account and stale-workspace cases.
- Local tests used private copied dependencies, no environment files, and a
  transport guard that blocks live services and external providers.

Linux candidate validation, exact continuity of the previous 3797 passing
tests, the original 135-failure/3-load-failure audit, release and postrelease
browser checks are separate gates. Their successful completion is not implied
by this local report.

## Account-isolation evidence and remaining gate

A fresh administrator session showed zero local image history and none of A's
test records. Opening history from the old A page after the account change was
rejected with an account-change message. Returning to A restored all three
records and the original draft. No administrator draft or image was written.

This is A → administrator → A evidence only. The administrator's role cannot
establish two ordinary tenants' access boundaries. An independent ordinary
tenant B, with a tenant ID different from A, is still required for B draft,
history, private API binding and A → B → A acceptance. Do not mark that gate
passed using the same tenant under another login, or the administrator role.

Screenshots, native reports and original downloads are retained locally under
`/tmp/sanjie-online-uat-20261018/`; no customer content or credentials are included
in this repository report. The existing finance pause, provider backend, UAT,
protected packages and live database are outside these source corrections.

## Concurrent production video repair preserved

The first candidate preparation stopped before creating its directory because
four live video assets had changed in a separately authorized video repair.
The immutable v2 release receipt and original 748-file manifest were retained.
The video commit `399342af0a09d981ed96b1c60d13928625384d1e` was merged
without overlapping the image changes. Its exact four-file overlay is recorded
in `live-video-overlay-provenance.json`; the R1, R2 and R3 server receipts
were read back and matched the committed raw SHA-256 values.

The independently pinned baseline commit
`565dd3535829ccb46d00a507197f9596a503e106` contains the original source plus
only those four deployed assets. Its 748-file manifest is
`live-v2-source-sha256.json`, SHA-256
`9fe3173f6a164244bd125ccf01e189df252750ecc5b8730a01c1a49574f232f1`.
This overlay is a separate inherited change, not a rewrite of the old release
evidence or permission to accept other production drift.

Fresh merged-source local full regression: **3886 passed, 0 failed,
277 skipped**, 4163 total. The separate Node video-provider suite also passed
all **4** tests. These are fresh runs after the complete video merge; they do
not establish paid video generation or trusted-portrait provider acceptance.

The user later identified `tenant@demo.local` as the intended B login. It is
the same account and tenant ID as A, so the independent ordinary-tenant gate
remains pending. No replacement tenant was created.

After the type-only fixes in the two new video test fixtures, the full suite
was rerun: **3886 passed, 0 failed, 277 skipped**, plus the explicit TAP
Node command **4 passed, 0 failed**. Fresh typecheck, standard lint (0 errors,
52 existing warnings) and the complete standard Next.js build all exited 0.
No production code or test assertions changed in those lint corrections.
Native local output digests are recorded in `merged-local-validation.json`;
the Linux and release gates remain separate.
