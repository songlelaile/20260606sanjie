# Cloud detail editor

`createCloudDetailService` reuses the packaged `DetailPageService`, image snapshot reader and raster inspector. It does not start the multimodal service or inject model execution, commands, CDP or native archive services.

The website bridge calls `handle(identity, body)` only after website authorization and server identity provisioning. `POST /api/sower/detail-pages` supports the existing `load`, `assets`, `save`, and `export` contracts. `revise` and `reconcile` return `DETAIL_CLOUD_ACTION_UNAVAILABLE`.

Upload pictures through the owned `/api/fs/upload` route, then call `{ action: 'import', conversationId, files: [{ path, sha256? }] }`. Each source needs an upload ownership receipt for this identity or must be in the current conversation's owned cloud project. URI, traversal, symbolic link and foreign account sources are rejected. Verified snapshots are copied into `detail-page-originals`, never overwriting the original upload. Imports allow at most 40 pictures, 20 MiB and 20 million pixels per picture, and 80 MiB total.

`save` uses the existing revision compare-and-set journal. `export` produces a proportional, gap-free whole PNG or a stored ZIP of numbered PNG sections and an export manifest. Download returned files through the existing authorized `/api/fs/stream` route. No paid provider calls, desktop state import or shared credits are involved in this editing operation.

Run the HTTP integration checks with Node 24: `SOWER_DETAIL_SOURCE=/absolute/path/to/packages/sower-control/src node --import tsx --test scripts/sower-work-web/cloud-detail/index.test.mjs`. The source path is a read-only dependency and must contain the portable detail-page services.
