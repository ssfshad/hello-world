-- Lessons (2026-10-17): the Notebook's own pages. Each lesson has a written
-- page (rich text, stored as the editor's JSON document) and a free-form board
-- (a canvas scene as JSON). `page_text` is the page as plain text, kept for
-- search and previews.
CREATE TABLE lessons (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  course      TEXT,
  icon        TEXT,
  color       TEXT,
  language_id TEXT REFERENCES languages(id),
  day_key     TEXT NOT NULL,
  page        TEXT,
  page_text   TEXT,
  board       TEXT,
  deleted_at  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_lessons_day ON lessons(day_key);

-- "What I learned" concepts that belong to a lesson.
CREATE TABLE lesson_concepts (
  lesson_id  TEXT NOT NULL REFERENCES lessons(id),
  concept_id TEXT NOT NULL REFERENCES concepts(id),
  PRIMARY KEY (lesson_id, concept_id)
);

-- Images placed on a lesson's page or board (photos of paper notes, tablet
-- drawings, screenshots). The file is copied into library/lessons/.
CREATE TABLE lesson_assets (
  id         TEXT PRIMARY KEY,
  lesson_id  TEXT NOT NULL REFERENCES lessons(id),
  file_path  TEXT NOT NULL,
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_lesson_assets_lesson ON lesson_assets(lesson_id);
