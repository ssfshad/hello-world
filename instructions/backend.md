# [App name] — Backend Specification

Everything behind the UI: local storage, data model, commands, the usefulness
score, the insight engine, spaced review, AI integration, reports, files,
security and packaging. Companion to `frontend.md`.

---

## 1. Architecture overview

The app is a **local-first desktop app**. There is no server. "Backend" means the
Tauri Rust core running on the user's machine.

```
┌─────────────────────────── Tauri app ───────────────────────────┐
│                                                                 │
│  React UI (TypeScript)                                          │
│     │  typed invoke() calls                                     │
│     ▼                                                           │
│  Rust core                                                      │
│   ├── commands/      IPC entry points (validated input)         │
│   ├── services/      business logic                             │
│   │    ├── sessions, concepts, problems, diary, mood            │
│   │    ├── stats + usefulness score                             │
│   │    ├── insights (rule engine)                               │
│   │    ├── review (spaced repetition)                           │
│   │    ├── ai (provider adapters, prompt builder, validation)   │
│   │    ├── reports (data assembly for PDF/Markdown)              │
│   │    ├── library (file storage)                               │
│   │    └── roadmaps (CRUD + import)                             │
│   ├── db/            SQLite via rusqlite, migrations            │
│   └── secrets/       OS keychain (API keys)                     │
│                                                                 │
│  Local disk:  <data_dir>/app.db   <data_dir>/library/           │
│               <data_dir>/backups/  <data_dir>/logs/             │
└─────────────────────────────────────────────────────────────────┘
          │ only when the user configures it
          ▼
   AI provider (Ollama on localhost, or a cloud API)
```

### Why Rust owns the data

- API keys never enter the JavaScript context; AI HTTP calls are made from Rust.
- No CORS issues when calling AI providers.
- One place for migrations, backups and integrity checks.
- The UI can be rewritten without touching stored data.

### Crates

`tauri` 2, `rusqlite` (bundled SQLite, with `backup` feature), `rusqlite_migration`,
`serde` / `serde_json`, `chrono` + `chrono-tz`, `uuid` (v7, time-ordered),
`reqwest` (rustls), `keyring` (OS keychain), `thiserror`, `tracing` +
`tracing-appender`, `jsonschema` (validate AI output), `ts-rs` or `specta`
(generate TypeScript types from Rust structs so UI and core never drift).

Tauri plugins: `dialog` (file pickers), `fs` (scoped), `shell` (open folder / links),
`notification` (daily reminder), `updater`, `window-state`, `single-instance`.

---

## 2. Storage

### 2.1 Locations

| Item | Path (default) |
|---|---|
| Database | `<app_data_dir>/app.db` |
| Library files | `<app_data_dir>/library/<yyyy>/<mm>/<uuid>-<slug>.<ext>` |
| Backups | `<app_data_dir>/backups/app-<timestamp>.db` |
| Logs | `<app_data_dir>/logs/` (rotated daily, 7 kept) |

`<app_data_dir>` is Tauri's per-OS app data directory. The user can move the data
folder in Settings (the app copies, verifies, then switches).

### 2.2 SQLite settings

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

### 2.3 Time handling (important)

- All timestamps stored as **UTC ISO-8601 text** (`2026-09-24T14:30:00Z`).
- Every row created during a day also stores a **`day_key`** (`YYYY-MM-DD`) computed
  from local time **minus the day boundary** (default 04:00). A session at
  01:30 on the 25th belongs to day `2026-09-24`.
- `day_key` is computed once at write time with the timezone and boundary active
  then, so history never shifts if the user travels or changes settings.
- One Rust helper, `day_key(ts_utc, tz, boundary)`, is the only place this logic lives.

---

## 3. Data model

IDs are UUID v7 text. Soft delete via `deleted_at` on user content so undo and
backups are safe. All tables have `created_at` and `updated_at`.

```sql
-- User profile (single row)
CREATE TABLE profile (
  id               TEXT PRIMARY KEY,
  display_name     TEXT NOT NULL,
  daily_goal_min   INTEGER NOT NULL DEFAULT 60,
  day_boundary     TEXT NOT NULL DEFAULT '04:00',
  timezone         TEXT NOT NULL,
  journey_start    TEXT NOT NULL,            -- day_key of first use
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
  ended_at        TEXT,                      -- NULL while running
  paused_seconds  INTEGER NOT NULL DEFAULT 0,
  paused_at       TEXT,                      -- non-NULL while paused
  day_key         TEXT NOT NULL,
  note            TEXT,
  deleted_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_sessions_day ON sessions(day_key);

CREATE TABLE concept_categories (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE COLLATE NOCASE   -- Loops, Strings, Lists, …
);

CREATE TABLE concepts (
  id             TEXT PRIMARY KEY,
  language_id    TEXT NOT NULL REFERENCES languages(id),
  name           TEXT NOT NULL,
  category_id    TEXT REFERENCES concept_categories(id),
  note           TEXT,                        -- "in my words"
  source_resource_id TEXT REFERENCES resources(id),
  learned_day_key TEXT NOT NULL,
  deleted_at     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE(language_id, name COLLATE NOCASE)
);
CREATE INDEX idx_concepts_day ON concepts(learned_day_key);

CREATE TABLE problems (
  id              TEXT PRIMARY KEY,
  language_id     TEXT REFERENCES languages(id),
  title           TEXT NOT NULL,
  url             TEXT,
  origin          TEXT NOT NULL CHECK (origin IN ('manual','generated')),
  generated_set_id TEXT REFERENCES generated_sets(id),
  difficulty      INTEGER CHECK (difficulty BETWEEN 1 AND 5),
  status          TEXT NOT NULL CHECK (status IN
                    ('queued','in_progress','solved','solved_with_help',
                     'gave_up','revisit')),
  feeling_tag_id  TEXT REFERENCES feeling_tags(id),
  statement_json  TEXT,                       -- full generated problem (see §8.4)
  solution_text   TEXT,                       -- user's pasted solution
  solution_path   TEXT,                       -- or path to their file
  hint_revealed   INTEGER NOT NULL DEFAULT 0,
  answer_revealed INTEGER NOT NULL DEFAULT 0,
  flagged_bad     INTEGER NOT NULL DEFAULT 0, -- "report bad problem"
  day_key         TEXT,                       -- day it was finished
  deleted_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_problems_day ON problems(day_key);
CREATE INDEX idx_problems_status ON problems(status);

CREATE TABLE problem_concepts (
  problem_id  TEXT NOT NULL REFERENCES problems(id),
  concept_id  TEXT NOT NULL REFERENCES concepts(id),
  PRIMARY KEY (problem_id, concept_id)
);

-- Per-problem time (one problem may be worked on across several sittings)
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

CREATE TABLE feeling_tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  valence    INTEGER NOT NULL CHECK (valence IN (-1,0,1)),  -- for insights
  is_builtin INTEGER NOT NULL DEFAULT 0
);
-- Seed: Excited(+1) Proud(+1) Aha!(+1) Confused(-1) Stuck(-1)
--       Frustrated(-1) Felt like a loser(-1) Bored(0) Anxious(-1)

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

-- One row per day, written on "Close the day" or at the day boundary
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
  score_version      INTEGER NOT NULL,     -- formula version (see §6)
  closed_at          TEXT NOT NULL
);

-- Spaced review queue (see §9)
CREATE TABLE review_items (
  concept_id     TEXT PRIMARY KEY REFERENCES concepts(id),
  stage          INTEGER NOT NULL DEFAULT 0,
  due_day_key    TEXT NOT NULL,
  last_result    TEXT CHECK (last_result IN ('easy','ok','hard','skipped')),
  updated_at     TEXT NOT NULL
);

CREATE TABLE generated_sets (
  id             TEXT PRIMARY KEY,
  mode           TEXT NOT NULL CHECK (mode IN ('copy_prompt','api')),
  provider       TEXT,                    -- ollama, openai, gemini, …
  model          TEXT,
  difficulty     INTEGER NOT NULL,
  style          TEXT NOT NULL,
  count          INTEGER NOT NULL,
  concept_ids    TEXT NOT NULL,           -- JSON array
  prompt_text    TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  raw_response   TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE insights (
  id           TEXT PRIMARY KEY,
  rule_id      TEXT NOT NULL,
  dedupe_key   TEXT NOT NULL UNIQUE,      -- stops the same insight repeating
  priority     INTEGER NOT NULL,
  payload_json TEXT NOT NULL,             -- values for the message template
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
  open_after  TEXT NOT NULL,             -- day_key
  opened_at   TEXT
);

CREATE TABLE resources (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('link','image','pdf','note','file')),
  title       TEXT NOT NULL,
  url         TEXT,
  file_path   TEXT,                      -- relative to library/
  body        TEXT,                      -- for notes
  sha256      TEXT,                      -- dedupe files
  deleted_at  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE resource_concepts (
  resource_id TEXT NOT NULL REFERENCES resources(id),
  concept_id  TEXT NOT NULL REFERENCES concepts(id),
  PRIMARY KEY (resource_id, concept_id)
);

CREATE TABLE roadmaps (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('custom','import')),
  source_ref  TEXT,                      -- attribution / origin
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE roadmap_nodes (
  id          TEXT PRIMARY KEY,
  roadmap_id  TEXT NOT NULL REFERENCES roadmaps(id),
  parent_id   TEXT REFERENCES roadmap_nodes(id),
  title       TEXT NOT NULL,
  position    INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'not_started'
              CHECK (status IN ('not_started','learning','done')),
  updated_at  TEXT NOT NULL
);

CREATE TABLE roadmap_node_concepts (
  node_id     TEXT NOT NULL REFERENCES roadmap_nodes(id),
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
  key_ref     TEXT,                      -- keychain entry name, never the key
  is_default  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL                   -- JSON
);
-- e.g. theme, allow_diary_to_ai (default false), reminder_time, open_on
```

### Full-text search

```sql
CREATE VIRTUAL TABLE search_index USING fts5(
  kind, ref_id UNINDEXED, day_key UNINDEXED, text,
  tokenize = 'unicode61 remove_diacritics 2'
);
```
Kept in sync by the service layer on every insert/update of diary entries,
concept notes, problem titles and resource titles.

### Migrations

- `rusqlite_migration` with numbered, forward-only SQL files in `src-tauri/migrations/`.
- Before running any migration, the app takes an automatic backup.
- `PRAGMA user_version` tracks the schema version.

---

## 4. Timer rules

- A session is running when `ended_at IS NULL`. **At most one** running session.
- At most one running `problem_attempt`. Starting a problem attempt starts a session
  if none is running.
- Elapsed = `(ended_at or now) − started_at − paused_seconds − (now − paused_at if paused)`.
  Nothing is counted tick by tick.
- **Crash / close recovery:** on startup, a running session older than 30 minutes
  since the app last heartbeated returns `needs_resolution`. The UI asks the user
  to keep it or end it at a chosen time. The app writes a heartbeat timestamp to
  `settings` every 60 s while a timer runs.
- Sessions over 8 hours are flagged for confirmation when ended.
- Ending a session ends any running problem attempt inside it.

---

## 5. Command API (IPC)

All commands take and return JSON; types are generated for TypeScript.
Errors return `{ code, message }` with codes like `VALIDATION`, `NOT_FOUND`,
`CONFLICT`, `AI_PROVIDER`, `IO`.

| Domain | Commands |
|---|---|
| Profile | `profile_get`, `profile_update`, `onboarding_complete` |
| Languages | `language_list`, `language_add`, `language_update`, `language_set_primary` |
| Sessions | `session_start`, `session_pause`, `session_resume`, `session_end`, `session_active`, `session_resolve_stale`, `session_list(day_key)`, `session_update`, `session_delete` |
| Concepts | `concept_add`, `concept_update`, `concept_delete`, `concept_search(prefix, language_id)`, `concept_list(range, language_id)` |
| Problems | `problem_add`, `problem_update`, `problem_set_status`, `problem_reveal(hint\|answer)`, `problem_flag_bad`, `problem_list(filter)` |
| Attempts | `attempt_start(problem_id)`, `attempt_pause`, `attempt_resume`, `attempt_end` |
| Mood | `mood_checkin(value, kind, session_id?)`, `mood_history(range)` |
| Diary | `diary_save(day_key, body, concept_ids, feeling_tag_ids)`, `diary_get(day_key)`, `feeling_tag_list`, `feeling_tag_add` |
| Day | `day_get(day_key)` (everything for one day), `day_close(day_key, self_usefulness)`, `day_calc_usefulness(day_key)` |
| Stats | `stats_overview(language_id?)`, `stats_series(metric, range, language_id?)`, `stats_heatmap(range)` |
| Insights | `insights_evaluate(trigger)`, `insights_list`, `insight_dismiss`, `insight_rule_toggle` |
| Review | `review_due(limit)`, `review_record(concept_id, result)` |
| Practice | `practice_build_prompt(config)`, `practice_generate(config)` (API mode), `practice_import_response(set_id, raw_text)`, `practice_fixup_prompt(raw_text)` |
| AI | `ai_provider_list`, `ai_provider_save`, `ai_provider_set_key`, `ai_provider_test` |
| Reports | `report_data(range, language_id?)`, `report_save_pdf(bytes, suggested_name)`, `report_markdown(range)` |
| Library | `resource_add_link`, `resource_add_file(path)`, `resource_add_note`, `resource_update`, `resource_delete`, `resource_list(filter)`, `library_open_folder` |
| Roadmaps | `roadmap_create`, `roadmap_list`, `roadmap_get`, `roadmap_node_upsert`, `roadmap_node_move`, `roadmap_node_set_status`, `roadmap_import_json(path)` |
| Letters | `letter_write(body, open_after)`, `letter_list`, `letter_open(id)` |
| Search | `search(query, filters)` |
| Data | `backup_now`, `backup_list`, `backup_restore(id)`, `export_all_json(path)`, `delete_all_data(confirm_phrase)`, `data_dir_move(path)` |

---

## 6. Usefulness score

### 6.1 Formula (score_version = 1)

Inputs for one day:

- `T` = focused minutes (sessions minus pauses)
- `G` = daily goal minutes
- `C` = concepts logged
- `S` = problems solved (including solved-with-help ×0.7)
- `A` = problems attempted but not solved (gave up / revisit / in progress with ≥5 min)
- `R` = 1 if a diary entry or both mood check-ins exist, else 0

```
time      = min(T / G, 1)                       weight 35
learning  = min(C / 2, 1)                       weight 20
practice  = min((S + 0.5·A) / 3, 1)             weight 35
reflect   = R                                   weight 10

score = round(35·time + 20·learning + 35·practice + 10·reflect)
```

**Shadowing adjustment:** if `T ≥ 90` and `S + A = 0`, cap `score` at 60 and emit
the `shadowing_warning` insight. Time alone should never produce a perfect day.

The formula is versioned. Old `day_summaries` keep their `score_version`; the UI
shows history with the formula active at the time. Settings exposes the weights
as an advanced option later.

### 6.2 Where it's used

Dashboard line chart, Notebook day pages, streak logic (a day with score > 0 counts),
and reports.

### 6.3 Self vs calculated comparison copy

| Gap (self − calc) | Message |
|---|---|
| ≤ −20 | "You're being harder on yourself than your log. {summary} is a solid day." |
| −19 … +19 | "Your rating and your log agree." |
| ≥ +20 | "Felt good! Your log shows mostly {dominant activity}; a practice problem tomorrow will lock it in." |

---

## 7. Insight engine

### 7.1 Design

- Each rule is a Rust struct implementing:

```rust
trait InsightRule {
    fn id(&self) -> &'static str;
    fn triggers(&self) -> &[Trigger];      // DayClosed, MoodLogged(value), AppOpened, Weekly
    fn evaluate(&self, ctx: &InsightCtx) -> Vec<InsightCandidate>;
}

struct InsightCandidate {
    rule_id: &'static str,
    dedupe_key: String,       // e.g. "comeback:<diary_id>"
    priority: i32,            // higher shows first
    payload: serde_json::Value,
}
```

- `insights_evaluate(trigger)` runs matching rules, inserts new candidates
  (skipping existing `dedupe_key`s), and returns the top unseen ones.
- Message text lives in the frontend i18n files keyed by `rule_id`; the backend
  only supplies payload values. This keeps copy editable and translatable.
- Rules must be pure queries: no AI, fast (< 50 ms each on a year of data).

### 7.2 Rules for v0.4

| rule_id | Trigger | Condition | Payload |
|---|---|---|---|
| `comeback` | DayClosed | A diary entry with mood ≤ 2 linked to concept X, followed within 14 days by ≥ 2 solved problems on X | day number, mood, diary snippet, days later, count, concept |
| `been_here_before` | MoodLogged(≤2) | Any past `comeback` for this user | same as above, most recent first |
| `shadowing_warning` | DayClosed | ≥ 90 min, 0 problems attempted | minutes |
| `forgotten_concept` | AppOpened | Concept learned ≥ 7 days ago, 0 problems since | concept, days |
| `best_time` | Weekly | ≥ 14 days of data; hour bucket with highest avg usefulness beats the overall avg by ≥ 15 | hour range, avg |
| `getting_faster` | Weekly | Avg solve time at a level dropped ≥ 25 % vs 4 weeks earlier (≥ 5 problems each) | level, percent |
| `mood_lift` | Weekly | Avg (mood_after − mood_before) ≥ +0.5 over 2 weeks | delta |
| `first_milestones` | DayClosed | 10/25/50/100 concepts, problems, hours | milestone |

### 7.3 Diary → concept linking

In order of preference:

1. **User tag** (chips on the diary card) → `source = 'user_tag'`.
2. **Keyword match**: on save, tokenize the diary body (lowercase, strip punctuation)
   and match against the user's concept names and simple variants (plural,
   hyphen/space, `()` stripped). Store with `source = 'keyword'`.
3. **AI** (optional, v0.5+, only when `allow_diary_to_ai = true`): send the body
   plus the concept list, request a JSON array of concept ids. `source = 'ai'`.

Insights treat all three sources equally but the UI shows keyword/AI links as
dismissible suggestions.

---

## 8. AI integration

### 8.1 Modes

- **Copy prompt** (default, free): the app builds the prompt; the user pastes it
  into free ChatGPT / Gemini and pastes the answer back.
- **API / local model**: the app calls a configured provider from Rust.

### 8.2 Provider adapter

```rust
#[async_trait]
trait AiProvider {
    async fn complete(&self, req: CompletionRequest) -> Result<String, AiError>;
    async fn test(&self) -> Result<(), AiError>;
}
```

Implementations:

| Kind | Endpoint | Notes |
|---|---|---|
| `ollama` | `http://localhost:11434/api/chat` | Fully local. Recommended default for privacy. |
| `openai_compatible` | `{base_url}/v1/chat/completions` | Covers OpenAI, LM Studio, Groq, Together, etc. |
| `gemini` | Google Generative Language API | |
| `anthropic` | Messages API | |
| `openrouter` | OpenAI-compatible | One key, many models. |

Request settings: temperature 0.7 for generation, 0.2 for fix-up; timeout 120 s;
one automatic retry on network error; user-visible cancel. Model names are free
text (providers change their lineups often).

### 8.3 Difficulty definitions (sent inside every prompt)

| Level | Name | Definition |
|---|---|---|
| 1 | Warm-up | Uses exactly one concept directly. 3–10 lines of code. |
| 2 | Easy | One or two concepts, straightforward input, no edge-case traps. |
| 3 | Combine | Two or three concepts together; one small edge case. |
| 4 | Tricky | Needs a small insight or careful edge-case handling; still only known concepts. |
| 5 | CF-style | Codeforces Div. 3 A/B flavor: short story, precise I/O format, multiple test cases, constraints. |

### 8.4 Problem JSON schema

Every generated problem must match this (validated with `jsonschema`):

```json
{
  "type": "object",
  "required": ["problems"],
  "properties": {
    "problems": {
      "type": "array",
      "minItems": 1,
      "maxItems": 10,
      "items": {
        "type": "object",
        "required": ["title", "difficulty", "concepts", "statement",
                     "input_format", "output_format", "samples",
                     "hint", "reference_solution"],
        "properties": {
          "title":              { "type": "string", "maxLength": 120 },
          "difficulty":         { "type": "integer", "minimum": 1, "maximum": 5 },
          "concepts":           { "type": "array", "items": { "type": "string" } },
          "statement":          { "type": "string" },
          "input_format":       { "type": "string" },
          "output_format":      { "type": "string" },
          "constraints":        { "type": "string" },
          "samples": {
            "type": "array", "minItems": 2,
            "items": {
              "type": "object",
              "required": ["input", "output"],
              "properties": {
                "input":       { "type": "string" },
                "output":      { "type": "string" },
                "explanation": { "type": "string" }
              }
            }
          },
          "hint":               { "type": "string" },
          "reference_solution": { "type": "string" }
        }
      }
    }
  }
}
```

### 8.5 Import and validation pipeline

1. Strip markdown fences and any text before the first `{` / after the last `}`.
2. Parse JSON; on failure return `INVALID_JSON` and offer the fix-up prompt.
3. Validate against the schema; collect all errors, not just the first.
4. Semantic checks:
   - every `concepts[]` entry fuzzy-matches a selected concept (warn if not)
   - `difficulty` equals the requested level (warn if not)
   - samples are non-empty; titles unique within the set
5. Save valid problems as `origin = 'generated'`, `status = 'queued'`.
6. Keep `raw_response` on the `generated_sets` row for debugging.

Since the app has no compiler, correctness of samples cannot be auto-verified.
Mitigations: the prompt requires the model to self-check samples against its
reference solution; users can flag bad problems; flagged problems are excluded
from stats and counted per provider/model so users see which models are reliable.

### 8.6 Prompt templates

Stored as versioned text files in `src-tauri/prompts/` (`prompt_version` saved
with each set). Variables in `{{double_braces}}`.

**`generate_problems.v1.txt`**

```
You are a patient programming coach for a beginner learning {{language}}.
They are on day {{journey_day}} of learning.

CONCEPTS THEY KNOW (use only these, plus basic syntax such as variables,
print, input, if/else, arithmetic):
{{concept_list_with_notes}}

DO NOT require any concept, library or technique not listed above.

TASK
Create {{count}} practice problems at difficulty {{difficulty}}/5.
Difficulty {{difficulty}} means: {{difficulty_definition}}
Style: {{style_definition}}
{{#if struggles}}
Recent struggles (include at least one gentle problem on these ideas):
{{struggles}}
{{/if}}

RULES
- Each problem practices at least one listed concept.
- Write clear, unambiguous statements. Define exact input and output formats.
- Give at least 2 samples. Before answering, mentally run your reference
  solution on every sample and make sure the outputs match exactly.
- The hint nudges without giving the answer away.
- reference_solution is complete, runnable {{language}} code using only the
  listed concepts.

OUTPUT
Return ONLY valid JSON matching this shape, with no markdown and no extra text:
{{json_shape_example}}
```

**`fixup_json.v1.txt`**

```
The text below was supposed to be JSON matching this schema but is invalid.
Return ONLY the corrected JSON. Do not change the content of the problems.
Errors: {{validation_errors}}
Schema: {{schema}}
Text:
{{raw_text}}
```

**`llm_report_preamble.v1.txt`** (top of the LLM-ready Markdown report, so a
free chatbot understands its role without any setup)

```
# Context for the AI reading this report

You are acting as a coding coach for a beginner. This report was exported from
a learning journal app. It lists what they learned, what they practiced, how
long it took, and how they felt.

How to help:
1. Generate practice problems ONLY from the concepts listed under
   "Concepts learned". Do not introduce new concepts.
2. Match the requested difficulty using the scale at the end of this report.
3. Prefer concepts marked "felt stuck" or "not practiced since".
4. Be encouraging. Beginners often feel like they are failing; point to
   evidence of progress in this report.
5. When asked for problems, answer in the JSON format described at the end
   so the user can paste it back into the app.
```

### 8.7 Privacy rules for AI

- Default payload includes: language, journey day, concept names and notes,
  difficulty, style, struggle concepts (names only).
- **Diary text is never sent** unless `allow_diary_to_ai = true`.
- The exact prompt is always shown to the user before sending in API mode
  (collapsible, but present).
- No telemetry is sent anywhere by the app.

---

## 9. Spaced review

Simple fixed-interval schedule; good enough for v0.3, replaceable later.

| Stage | Next review after |
|---|---|
| 0 | 1 day |
| 1 | 3 days |
| 2 | 7 days |
| 3 | 14 days |
| 4 | 30 days |
| 5 | 60 days (then stays) |

- A `review_items` row is created when a concept is first logged (stage 0).
- Solving a problem linked to the concept counts as a review: `solved` → stage +1,
  `solved_with_help` → same stage, `gave_up` / `revisit` → stage −1 (min 0).
- `review_due(limit)` returns items with `due_day_key <= today`, oldest first,
  preferring concepts with negative feeling tags.

---

## 10. Roadmaps import

- **Own format** (`roadmap.v1.json`): `{ title, source_ref, nodes: [{ title, children: [...] }] }`.
  Used for export/import and sharing between users by file.
- **roadmap.sh**: their content is published in the `developer-roadmap` GitHub
  repository. Before bundling or auto-importing any of it, review that
  repository's license and terms. The safe default is a user-initiated import
  of a roadmap file the user downloads themselves, stored with `source_ref`
  attribution and a link back, rather than shipping their content inside the app.
- Importer maps topic headings to nodes and keeps hierarchy; unknown fields are ignored.

---

## 11. Reports

- `report_data(range, language_id?)` returns one structured object: profile,
  totals, per-day summaries, concepts with notes and review stage, problems
  with times and feelings, mood series, top insights, and (only if the user
  ticks "include diary") diary text.
- **PDF** is rendered in the frontend with @react-pdf/renderer from this object;
  bytes are passed to `report_save_pdf`, which opens a save dialog.
- **LLM-ready Markdown** is built in Rust: preamble (§8.6) + report body +
  difficulty scale + JSON format, capped at ~12k characters with older days
  summarized, so it fits free chatbot input limits.

---

## 12. Library files

- Adding a file copies it into `library/` (never moves the user's original).
- SHA-256 dedupe: adding the same file twice links to the existing record.
- Max single file 200 MB (configurable). Allowed types: images, PDF, text,
  markdown, code files, zip. Executables are rejected.
- Filenames are sanitized; paths stored relative to `library/` so the data
  folder can move.
- Tauri `fs` scope is limited to the data directory and paths chosen by the
  user through dialogs.

---

## 13. Backup, restore, export

- Automatic backup on app start once per day and before every migration,
  using SQLite's online backup API. Keep last 14 daily + 4 weekly.
- `backup_restore` validates the file (`PRAGMA integrity_check`, schema version
  ≤ current), backs up the current DB, then swaps.
- `export_all_json` writes a human-readable JSON of all tables (plus library
  folder copy if chosen): the user's data is always portable.
- `delete_all_data` requires typing `DELETE` and removes DB, library, backups.

---

## 14. Security

- API keys stored only in the OS keychain (`keyring` crate: Windows Credential
  Manager, macOS Keychain, Linux Secret Service). The DB stores a reference name.
- Keys are read in Rust at request time and never returned to the UI.
- Tauri capabilities: only the commands and plugins listed here are allowed;
  CSP blocks remote scripts; no remote content loaded into the webview.
- All command inputs validated (serde + explicit checks) before touching the DB.
- Parameterized SQL only.
- AI responses are treated as untrusted text: rendered as plain text/markdown
  with HTML disabled, never executed.
- Logs never contain diary text, API keys or prompt bodies (only ids, timings, error codes).

---

## 15. Observability

- `tracing` to rotating local log files; level configurable in Settings (hidden
  "Debug" section).
- "Export diagnostics" bundles logs + app/DB version (no user content) for bug reports.
- No remote telemetry. If ever added, it must be opt-in and documented.

---

## 16. Testing

- **Unit (Rust):** `day_key` edge cases (midnight, day boundary, DST changes),
  timer math with pauses, usefulness formula, review scheduling, each insight
  rule against fixture data, JSON extraction and schema validation.
- **Integration:** in-memory SQLite with migrations applied; command-level tests
  for every domain.
- **Fixtures:** a seeded "30-day learner" dataset used by tests and by a
  developer "load demo data" command (excluded from release builds).
- **AI:** provider adapters tested against recorded responses; no live calls in CI.
- **Migrations:** test upgrading a DB from every previous schema version.

---

## 17. Build, packaging, updates

- CI (GitHub Actions): lint (clippy, eslint), tests, then `tauri build` for
  Windows (MSI/NSIS), macOS (DMG, universal), Linux (AppImage, deb).
- Code signing: Windows certificate and Apple Developer ID + notarization before
  public release (unsigned builds trigger OS warnings that scare beginners).
- Auto-update via Tauri updater with signed update manifests; user can disable.
- Versioning: SemVer; DB schema version independent of app version.

---

## 18. Backend scope by version

| Version | Backend scope |
|---|---|
| **v0.1** | Schema v1 (profile, languages, sessions, concepts, mood, diary, day_summaries, settings), timers with recovery, usefulness score v1, backups |
| **v0.2** | Problems, attempts, feeling tags, streaks, search index |
| **v0.3** | Prompt builder, JSON import + validation, generated sets, spaced review |
| **v0.4** | Stats series and heatmap, insight engine with rules in §7.2, report data + PDF save |
| **v0.5** | Library storage, roadmaps + import, AI providers (Ollama, OpenAI-compatible, Gemini, Anthropic, OpenRouter), keychain |
| **v1.0** | Letters, LLM-ready Markdown report, optional AI diary linking, diagnostics export, signed builds, auto-update |
| **v2.0** | Opt-in community sync of aggregate stats only (separate spec; requires a server, accounts, moderation and anti-cheat) |

---

## 19. Open decisions

- App name and codename.
- Whether v0.1 ships Windows-only first (fastest path for the initial audience) or all three platforms.
- Default AI mode on first run: copy-prompt only, or detect a running Ollama and offer it.
- Whether "solved with help" should count toward streak milestones.
