# Sync design (branch `sync`)

Goal: the same journal on two (or more) PCs, through a **private GitHub repo**
the user owns. No server of ours. Local-first stays true: the app works offline
and the repo is just a mailbox.

## Model

Every synced row is identified by `(table, pk)`. Every device keeps a
`sync_meta` table: for each row, **when** it last changed and **which device**
changed it. SQLite triggers fill it, so no service code has to change.

- INSERT/UPDATE → `deleted = 0`, `changed_at = now`, `device = this device`
- DELETE        → `deleted = 1` (a tombstone), same stamps
- While sync itself is applying remote rows, triggers are muted
  (`sync_state.applying = 1`) so remote data is not echoed back.

Conflict rule: **last writer wins per row**, compared by
`(changed_at, device_id)`. Edits to *different* rows never conflict.

## Repo layout (conflict-free by construction)

```
devices/<device_id>.json     only that device writes this file
```

A device file holds the latest version of every row **that device itself**
changed (`sync_meta.device = me`): `{table, pk, changed_at, deleted, data}`.
Because each file has one writer, `git pull --rebase` never conflicts.

## Sync round

1. `git pull` (clone on first run) into `<data dir>/sync-repo/`
2. Read every other device's file; for each entry newer than the local
   `sync_meta` stamp, apply it (upsert / delete) inside one transaction,
   FK-ordered, and update `sync_meta`.
3. Rewrite `devices/<me>.json` from `sync_meta`, commit, push.
4. Rebuild the search index for touched rows.
5. A database backup is taken before step 2 (`backups/…-pre-sync.db`).

## Not synced

`ai_providers` and `settings` (per-device: API keys, theme), `insights`,
`insight_rule_prefs`, `generated_sets` (derived/local), `search_index`
(rebuilt). Library **files** (`resources`, `lesson_assets`) are a later phase:
rows sync first, files go to `files/<sha256>` in the repo.

## Merging two existing journals (first sync)

Rows with a natural unique key (languages by name, concepts by language+name,
feeling tags, categories) can exist on both PCs under different ids. On apply,
a remote row that collides on a UNIQUE key is **remapped** onto the local row
with the same key and foreign keys in incoming rows are rewritten to match.
`profile` is a singleton: the oldest profile id wins on all devices.

## Credentials

The GitHub token lives in the OS keychain (`secrets.rs`), never in the
database or repo. The repo URL is stored in `sync_state`.

## Transport

`git` CLI (token passed via `http.extraheader`, never written to the remote
URL). Needs git installed; the settings screen reports it clearly if missing.
