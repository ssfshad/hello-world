-- Hello World schema v1 (backend.md §3)
-- IDs are UUID v7 text; timestamps are UTC ISO-8601 text; day_key is YYYY-MM-DD.

CREATE TABLE profile (
  id               TEXT PRIMARY KEY,
  display_name     TEXT NOT NULL,
  daily_goal_min   INTEGER NOT NULL DEFAULT 60,
  day_boundary     TEXT NOT NULL DEFAULT '04:00',
  timezone         TEXT NOT NULL,
  journey_start    TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE languages (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  language_id     TEXT REFERENCES languages(id),
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  paused_seconds  INTEGER NOT NULL DEFAULT 0,
  paused_at       TEXT,
  day_key         TEXT NOT NULL,
  note            TEXT,
  deleted_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_sessions_day ON sessions(day_key);

CREATE TABLE concept_categories (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE concepts (
  id                 TEXT PRIMARY KEY,
  language_id        TEXT NOT NULL REFERENCES languages(id),
  name               TEXT NOT NULL,
  category_id        TEXT REFERENCES concept_categories(id),
  note               TEXT,
  source_resource_id TEXT REFERENCES resources(id),
  learned_day_key    TEXT NOT NULL,
  deleted_at         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE(language_id, name COLLATE NOCASE)
);
CREATE INDEX idx_concepts_day ON concepts(learned_day_key);

CREATE TABLE problems (
  id               TEXT PRIMARY KEY,
  language_id      TEXT REFERENCES languages(id),
  title            TEXT NOT NULL,
  url              TEXT,
  origin           TEXT NOT NULL CHECK (origin IN ('manual','generated')),
  generated_set_id TEXT REFERENCES generated_sets(id),
  difficulty       INTEGER CHECK (difficulty BETWEEN 1 AND 5),
  status           TEXT NOT NULL CHECK (status IN
                     ('queued','in_progress','solved','solved_with_help',
                      'gave_up','revisit')),
  feeling_tag_id   TEXT REFERENCES feeling_tags(id),
  statement_json   TEXT,
  solution_text    TEXT,
  solution_path    TEXT,
  hint_revealed    INTEGER NOT NULL DEFAULT 0,
  answer_revealed  INTEGER NOT NULL DEFAULT 0,
  flagged_bad      INTEGER NOT NULL DEFAULT 0,
  day_key          TEXT,
  created_day_key  TEXT NOT NULL,
  deleted_at       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_problems_day ON problems(day_key);
CREATE INDEX idx_problems_status ON problems(status);
CREATE INDEX idx_problems_created_day ON problems(created_day_key);

CREATE TABLE problem_concepts (
  problem_id  TEXT NOT NULL REFERENCES problems(id),
  concept_id  TEXT NOT NULL REFERENCES concepts(id),
  PRIMARY KEY (problem_id, concept_id)
);
CREATE INDEX idx_problem_concepts_concept ON problem_concepts(concept_id);

CREATE TABLE problem_attempts (
  id              TEXT PRIMARY KEY,
  problem_id      TEXT NOT NULL REFERENCES problems(id),
  session_id      TEXT REFERENCES sessions(id),
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  paused_seconds  INTEGER NOT NULL DEFAULT 0,
  paused_at       TEXT,
  day_key         TEXT NOT NULL
);
CREATE INDEX idx_attempts_problem ON problem_attempts(problem_id);
CREATE INDEX idx_attempts_day ON problem_attempts(day_key);

CREATE TABLE feeling_tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  valence    INTEGER NOT NULL CHECK (valence IN (-1,0,1)),
  is_builtin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE mood_checkins (
  id          TEXT PRIMARY KEY,
  value       INTEGER NOT NULL CHECK (value BETWEEN 1 AND 5),
  kind        TEXT NOT NULL CHECK (kind IN ('session_start','session_end','adhoc')),
  session_id  TEXT REFERENCES sessions(id),
  at          TEXT NOT NULL,
  day_key     TEXT NOT NULL
);
CREATE INDEX idx_mood_day ON mood_checkins(day_key);

CREATE TABLE diary_entries (
  id          TEXT PRIMARY KEY,
  day_key     TEXT NOT NULL,
  body        TEXT NOT NULL,
  deleted_at  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_diary_day ON diary_entries(day_key);

CREATE TABLE diary_concepts (
  diary_id    TEXT NOT NULL REFERENCES diary_entries(id),
  concept_id  TEXT NOT NULL REFERENCES concepts(id),
  source      TEXT NOT NULL CHECK (source IN ('user_tag','keyword','ai')),
  PRIMARY KEY (diary_id, concept_id)
);

CREATE TABLE diary_feelings (
  diary_id        TEXT NOT NULL REFERENCES diary_entries(id),
  feeling_tag_id  TEXT NOT NULL REFERENCES feeling_tags(id),
  PRIMARY KEY (diary_id, feeling_tag_id)
);

CREATE TABLE day_summaries (
  day_key            TEXT PRIMARY KEY,
  focused_seconds    INTEGER NOT NULL,
  concepts_count     INTEGER NOT NULL,
  problems_solved    INTEGER NOT NULL,
  problems_attempted INTEGER NOT NULL,
  mood_avg           REAL,
  mood_before        REAL,
  mood_after         REAL,
  self_usefulness    INTEGER CHECK (self_usefulness BETWEEN 0 AND 100),
  calc_usefulness    INTEGER NOT NULL,
  score_version      INTEGER NOT NULL,
  closed_at          TEXT NOT NULL
);

CREATE TABLE review_items (
  concept_id     TEXT PRIMARY KEY REFERENCES concepts(id),
  stage          INTEGER NOT NULL DEFAULT 0,
  due_day_key    TEXT NOT NULL,
  last_result    TEXT CHECK (last_result IN ('easy','ok','hard','skipped')),
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_review_due ON review_items(due_day_key);

CREATE TABLE generated_sets (
  id             TEXT PRIMARY KEY,
  mode           TEXT NOT NULL CHECK (mode IN ('copy_prompt','api')),
  provider       TEXT,
  model          TEXT,
  language_id    TEXT REFERENCES languages(id),
  difficulty     INTEGER NOT NULL,
  style          TEXT NOT NULL,
  count          INTEGER NOT NULL,
  concept_ids    TEXT NOT NULL,
  prompt_text    TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  raw_response   TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE insights (
  id           TEXT PRIMARY KEY,
  rule_id      TEXT NOT NULL,
  dedupe_key   TEXT NOT NULL UNIQUE,
  priority     INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  seen_at      TEXT,
  dismissed_at TEXT
);

CREATE TABLE insight_rule_prefs (
  rule_id   TEXT PRIMARY KEY,
  enabled   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE letters (
  id          TEXT PRIMARY KEY,
  body        TEXT NOT NULL,
  written_at  TEXT NOT NULL,
  open_after  TEXT NOT NULL,
  opened_at   TEXT
);

CREATE TABLE resources (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('link','image','pdf','note','file')),
  title       TEXT NOT NULL,
  url         TEXT,
  file_path   TEXT,
  body        TEXT,
  sha256      TEXT,
  language_id TEXT REFERENCES languages(id),
  deleted_at  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_resources_sha ON resources(sha256);

CREATE TABLE resource_concepts (
  resource_id TEXT NOT NULL REFERENCES resources(id),
  concept_id  TEXT NOT NULL REFERENCES concepts(id),
  PRIMARY KEY (resource_id, concept_id)
);

CREATE TABLE roadmaps (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('custom','import')),
  source_ref  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE roadmap_nodes (
  id          TEXT PRIMARY KEY,
  roadmap_id  TEXT NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
  parent_id   TEXT REFERENCES roadmap_nodes(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  position    INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'not_started'
              CHECK (status IN ('not_started','learning','done')),
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_roadmap_nodes_roadmap ON roadmap_nodes(roadmap_id);

CREATE TABLE roadmap_node_concepts (
  node_id     TEXT NOT NULL REFERENCES roadmap_nodes(id) ON DELETE CASCADE,
  concept_id  TEXT NOT NULL REFERENCES concepts(id),
  PRIMARY KEY (node_id, concept_id)
);

CREATE TABLE ai_providers (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN
                ('ollama','openai_compatible','gemini','anthropic','openrouter')),
  label       TEXT NOT NULL,
  base_url    TEXT,
  model       TEXT NOT NULL,
  key_ref     TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE VIRTUAL TABLE search_index USING fts5(
  kind, ref_id UNINDEXED, day_key UNINDEXED, text,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Seeds
INSERT INTO feeling_tags (id, name, valence, is_builtin) VALUES
  ('ft-excited',    'Excited',            1, 1),
  ('ft-proud',      'Proud',              1, 1),
  ('ft-aha',        'Aha!',               1, 1),
  ('ft-confused',   'Confused',          -1, 1),
  ('ft-stuck',      'Stuck',             -1, 1),
  ('ft-frustrated', 'Frustrated',        -1, 1),
  ('ft-loser',      'Felt like a loser', -1, 1),
  ('ft-bored',      'Bored',              0, 1),
  ('ft-anxious',    'Anxious',           -1, 1);

INSERT INTO concept_categories (id, name) VALUES
  ('cc-basics',     'Basics'),
  ('cc-variables',  'Variables'),
  ('cc-conditions', 'Conditionals'),
  ('cc-loops',      'Loops'),
  ('cc-strings',    'Strings'),
  ('cc-lists',      'Lists'),
  ('cc-dicts',      'Dictionaries'),
  ('cc-functions',  'Functions'),
  ('cc-classes',    'Classes'),
  ('cc-recursion',  'Recursion'),
  ('cc-files',      'Files'),
  ('cc-errors',     'Errors'),
  ('cc-other',      'Other');

INSERT INTO settings (key, value) VALUES
  ('theme', '"system"'),
  ('allow_diary_to_ai', 'false'),
  ('open_on', '"today"'),
  ('font_size', '"m"'),
  ('reduced_motion', 'false'),
  ('reminder_time', 'null'),
  ('auto_update', 'true'),
  ('log_level', '"info"'),
  ('onboarding_done', 'false');
