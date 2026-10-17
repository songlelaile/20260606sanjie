-- The server-only asset service checkpoints operations independently while an
-- outer PostgreSQL advisory transaction holds the physical provider account lock.
CREATE TABLE IF NOT EXISTS video_asset_binding_state (
  binding_key TEXT PRIMARY KEY,
  state JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
