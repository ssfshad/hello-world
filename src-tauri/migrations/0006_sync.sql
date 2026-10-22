-- Sync (branch `sync`): bookkeeping only. Nothing here changes how the app
-- behaves until the user turns sync on; the triggers that fill `sync_meta` are
-- installed at that point (see services/sync.rs and docs/sync-design.md).

-- Per-device settings: device_id, enabled, applying, repo_url, last_sync.
CREATE TABLE sync_state (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- When each synced row (tbl + JSON array of its primary key) last changed, and
-- which device changed it. `deleted = 1` is a tombstone.
CREATE TABLE sync_meta (
  tbl         TEXT NOT NULL,
  pk          TEXT NOT NULL,
  changed_at  TEXT NOT NULL,
  device      TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tbl, pk)
);
CREATE INDEX idx_sync_meta_device ON sync_meta(device);

-- A remote row that was matched to an existing local row with the same natural
-- key (e.g. the language "Python" created on both PCs).
CREATE TABLE sync_alias (
  tbl        TEXT NOT NULL,
  remote_pk  TEXT NOT NULL,
  local_pk   TEXT NOT NULL,
  PRIMARY KEY (tbl, remote_pk)
);
