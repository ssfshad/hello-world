/**
 * IPC contract between the React UI and the Rust core.
 *
 * Conventions
 * - Every command listed in `Commands` is a Tauri command with the same name.
 * - Top-level argument keys and all JSON field names are snake_case.
 * - Timestamps: UTC ISO-8601 strings ("2026-09-24T14:30:00Z"). Days: "YYYY-MM-DD" day_keys.
 * - Errors reject with `AppErrorPayload` ({ code, message }).
 * - Durations are seconds unless the field name says otherwise.
 */

// ───────────────────────── Errors ─────────────────────────
export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'AI_PROVIDER'
  | 'INVALID_JSON'
  | 'IO'
  | 'DB'
  | 'CANCELLED'
  | 'INTERNAL';
export interface AppErrorPayload {
  code: ErrorCode;
  message: string;
}

// ───────────────────────── Common ─────────────────────────
export interface DayRange {
  /** inclusive day_key */
  from: string;
  /** inclusive day_key */
  to: string;
}

// ───────────────────────── Settings / profile ─────────────────────────
export type Theme = 'light' | 'dark' | 'system';
export type FontSize = 's' | 'm' | 'l';
export interface AppSettings {
  theme: Theme;
  allow_diary_to_ai: boolean;
  open_on: 'today' | 'dashboard';
  font_size: FontSize;
  reduced_motion: boolean;
  /** "HH:MM" local, or null for no reminder */
  reminder_time: string | null;
  auto_update: boolean;
  log_level: 'error' | 'warn' | 'info' | 'debug' | 'trace';
  onboarding_done: boolean;
}

export interface Profile {
  id: string;
  display_name: string;
  daily_goal_min: number;
  day_boundary: string; // "HH:MM"
  timezone: string; // IANA
  journey_start: string; // day_key
  created_at: string;
  updated_at: string;
}

export interface Language {
  id: string;
  name: string;
  is_primary: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface OnboardingInput {
  display_name: string;
  /** language names; created if missing */
  languages: string[];
  primary_language: string;
  daily_goal_min: number;
  day_boundary: string;
  /** optional letter to future self, sealed for 30 days */
  letter: string | null;
}

export interface ProfileUpdate {
  display_name?: string;
  daily_goal_min?: number;
  day_boundary?: string;
  timezone?: string;
}

// ───────────────────────── Timers ─────────────────────────
export interface Session {
  id: string;
  language_id: string | null;
  started_at: string;
  ended_at: string | null;
  paused_seconds: number;
  paused_at: string | null;
  day_key: string;
  note: string | null;
  /** computed at read time: (ended_at|now) − started_at − paused */
  elapsed_seconds: number;
  is_running: boolean;
  is_paused: boolean;
}

export interface Attempt {
  id: string;
  problem_id: string;
  problem_title: string;
  session_id: string | null;
  started_at: string;
  ended_at: string | null;
  paused_seconds: number;
  paused_at: string | null;
  day_key: string;
  elapsed_seconds: number;
  is_running: boolean;
  is_paused: boolean;
}

export interface StaleSession {
  session: Session;
  /** last heartbeat written while the timer ran; null if never */
  last_heartbeat: string | null;
}

/** Returned by every timer command. The UI derives elapsed time from the
 *  timestamps + server_now offset; it never counts ticks. */
export interface ActiveState {
  session: Session | null;
  attempt: Attempt | null;
  /** non-null when a running session needs "keep or end at…" resolution */
  stale: StaleSession | null;
  server_now: string;
}

export interface SessionEndResult {
  /** true when the session is > 8 h and `confirm_long` was not set; nothing was ended */
  needs_confirmation: boolean;
  elapsed_seconds: number;
  state: ActiveState;
}

// ───────────────────────── Concepts ─────────────────────────
export interface ConceptCategory {
  id: string;
  name: string;
}

export interface Concept {
  id: string;
  language_id: string;
  name: string;
  category_id: string | null;
  category_name: string | null;
  note: string | null;
  /** worked example the learner wrote (indentation preserved) */
  example_code: string | null;
  /** output the learner pasted from their own compiler */
  example_output: string | null;
  source_resource_id: string | null;
  learned_day_key: string;
  review_stage: number | null;
  due_day_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConceptInput {
  language_id: string;
  name: string;
  category_id?: string | null;
  note?: string | null;
  example_code?: string | null;
  example_output?: string | null;
  source_resource_id?: string | null;
  /** defaults to today */
  day_key?: string | null;
}

export interface ConceptUpdate {
  id: string;
  name?: string;
  category_id?: string | null;
  note?: string | null;
  example_code?: string | null;
  example_output?: string | null;
  source_resource_id?: string | null;
}

// ───────────────────────── Problems ─────────────────────────
export type ProblemStatus =
  | 'queued'
  | 'in_progress'
  | 'solved'
  | 'solved_with_help'
  | 'gave_up'
  | 'revisit';

export interface Sample {
  input: string;
  output: string;
  explanation?: string | null;
}

/** Matches backend §8.4 JSON schema */
export interface GeneratedProblem {
  title: string;
  difficulty: number;
  concepts: string[];
  statement: string;
  input_format: string;
  output_format: string;
  constraints?: string | null;
  samples: Sample[];
  hint: string;
  reference_solution: string;
}

export interface Problem {
  id: string;
  language_id: string | null;
  title: string;
  url: string | null;
  origin: 'manual' | 'generated';
  generated_set_id: string | null;
  difficulty: number | null;
  status: ProblemStatus;
  feeling_tag_id: string | null;
  statement: GeneratedProblem | null;
  solution_text: string | null;
  solution_path: string | null;
  hint_revealed: boolean;
  answer_revealed: boolean;
  flagged_bad: boolean;
  /** day it was finished */
  day_key: string | null;
  created_day_key: string;
  concept_ids: string[];
  concept_names: string[];
  /** sum of all attempts */
  total_seconds: number;
  active_attempt_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProblemInput {
  language_id?: string | null;
  title: string;
  url?: string | null;
  difficulty?: number | null;
  status: ProblemStatus;
  feeling_tag_id?: string | null;
  concept_ids: string[];
  solution_text?: string | null;
  solution_path?: string | null;
}

export interface ProblemUpdate {
  id: string;
  title?: string;
  url?: string | null;
  difficulty?: number | null;
  feeling_tag_id?: string | null;
  concept_ids?: string[];
  solution_text?: string | null;
  solution_path?: string | null;
  language_id?: string | null;
}

export interface ProblemFilter {
  /** problems created, worked on, or finished on this day */
  day_key?: string | null;
  status?: ProblemStatus[] | null;
  origin?: 'manual' | 'generated' | null;
  generated_set_id?: string | null;
  language_id?: string | null;
  include_flagged?: boolean;
  limit?: number | null;
}

// ───────────────────────── Mood / diary / feelings ─────────────────────────
export type MoodKind = 'session_start' | 'session_end' | 'adhoc';
export interface MoodCheckin {
  id: string;
  value: number; // 1–5
  kind: MoodKind;
  session_id: string | null;
  at: string;
  day_key: string;
}
export interface MoodCheckinResult {
  checkin: MoodCheckin;
  /** insights triggered by MoodLogged (e.g. been_here_before) */
  insights: Insight[];
}

export interface FeelingTag {
  id: string;
  name: string;
  valence: -1 | 0 | 1;
  is_builtin: boolean;
}

export type LinkSource = 'user_tag' | 'keyword' | 'ai';
export interface DiaryConceptLink {
  concept_id: string;
  name: string;
  source: LinkSource;
}
export interface DiaryEntry {
  id: string;
  day_key: string;
  body: string;
  concept_links: DiaryConceptLink[];
  feeling_tag_ids: string[];
  created_at: string;
  updated_at: string;
}
export interface DiarySaveInput {
  day_key: string;
  body: string;
  /** user-tagged concepts; keyword links are added automatically */
  concept_ids: string[];
  feeling_tag_ids: string[];
}

// ───────────────────────── Day / usefulness ─────────────────────────
export interface UsefulnessBreakdown {
  score: number; // 0–100
  score_version: number;
  /** component values in 0..1 */
  time: number;
  learning: number;
  practice: number;
  reflect: number;
  focused_minutes: number;
  goal_minutes: number;
  concepts: number;
  /** solved count (solved_with_help ×0.7) */
  solved: number;
  attempted: number;
  reflected: boolean;
  shadowing_capped: boolean;
}

/** Copy lives in the frontend (backend §6.3); keys: usefulness.compare.{tone} */
export interface UsefulnessComparison {
  gap: number;
  tone: 'harder' | 'agree' | 'higher';
  /** e.g. "1h 20m, 2 concepts and 1 problem" */
  summary: string;
  /** 'time' | 'concepts' | 'problems' | 'reflection' */
  dominant_activity: string;
}

export interface DaySummary {
  day_key: string;
  focused_seconds: number;
  concepts_count: number;
  problems_solved: number;
  problems_attempted: number;
  mood_avg: number | null;
  mood_before: number | null;
  mood_after: number | null;
  self_usefulness: number | null;
  calc_usefulness: number;
  score_version: number;
  closed_at: string;
}

export interface DayView {
  day_key: string;
  is_today: boolean;
  sessions: Session[];
  focused_seconds: number;
  concepts: Concept[];
  problems: Problem[];
  moods: MoodCheckin[];
  diary: DiaryEntry | null;
  summary: DaySummary | null;
  calc: UsefulnessBreakdown;
  /** present when a self rating exists (summary.self_usefulness) */
  comparison: UsefulnessComparison | null;
}

export interface DayCloseResult {
  summary: DaySummary;
  comparison: UsefulnessComparison | null;
  insights: Insight[];
}

// ───────────────────────── Stats ─────────────────────────
export interface StatsOverview {
  total_seconds: number;
  week_seconds: number;
  prev_week_seconds: number;
  concepts_total: number;
  concepts_due: number;
  /** solved + solved_with_help */
  problems_solved: number;
  problems_solved_alone: number;
  problems_solved_with_help: number;
  avg_solve_seconds: number | null;
  current_streak: number;
  best_streak: number;
  journey_day: number;
  days_logged: number;
}

export type SeriesMetric =
  | 'focused_minutes'
  | 'usefulness'
  | 'mood_avg'
  | 'mood_before'
  | 'mood_after'
  | 'concepts'
  | 'problems_solved'
  | 'problems_attempted';

export interface SeriesPoint {
  day_key: string;
  value: number | null;
}

/** One row per day in range (days with no data included, zeros/nulls). */
export interface DailyPoint {
  day_key: string;
  minutes: number;
  usefulness: number | null;
  mood_avg: number | null;
  mood_before: number | null;
  mood_after: number | null;
  concepts: number;
  solved: number;
  attempted: number;
  /** a low-mood day later followed by a comeback */
  comeback: boolean;
  /** first 80 chars of the diary */
  diary_snippet: string | null;
}

export interface HeatCell {
  day_key: string;
  minutes: number;
  bucket: 0 | 1 | 2 | 3 | 4;
}

export interface InsightCharts {
  mood_before_after_weekly: { week_start: string; before: number | null; after: number | null }[];
  usefulness_by_hour: { hour: number; avg: number; sessions: number }[];
  usefulness_by_weekday: { weekday: number; avg: number; days: number }[]; // 0 = Monday
  speed_by_difficulty: { week_start: string; level: number; avg_minutes: number; count: number }[];
  feelings_per_concept: { concept_id: string; concept: string; counts: Record<string, number> }[];
  time_vs_attempts: { day_key: string; minutes: number; attempted: number }[];
}

// ───────────────────────── Insights ─────────────────────────
export type InsightRuleId =
  | 'comeback'
  | 'been_here_before'
  | 'shadowing_warning'
  | 'forgotten_concept'
  | 'best_time'
  | 'getting_faster'
  | 'mood_lift'
  | 'first_milestones';

export type InsightTrigger = 'day_closed' | 'mood_logged' | 'app_opened' | 'weekly';

/**
 * Payload keys by rule (message text lives in i18n under insights.{rule_id}):
 * - comeback / been_here_before: { day_number, day_key, mood, snippet, days_later, count, concept, concept_id }
 * - shadowing_warning: { minutes, day_key }
 * - forgotten_concept: { concept, concept_id, days }
 * - best_time: { hour_start, hour_end, avg, overall_avg }
 * - getting_faster: { level, percent }
 * - mood_lift: { delta }
 * - first_milestones: { kind: 'concepts' | 'problems' | 'problems_with_help' | 'hours', value }
 *   ('problems' counts problems solved on your own)
 */
export interface Insight {
  id: string;
  rule_id: InsightRuleId;
  priority: number;
  payload: Record<string, string | number | boolean | null>;
  created_at: string;
  seen_at: string | null;
  dismissed_at: string | null;
}

export interface InsightRulePref {
  rule_id: InsightRuleId;
  enabled: boolean;
}

// ───────────────────────── Review ─────────────────────────
export type ReviewResult = 'easy' | 'ok' | 'hard' | 'skipped';
export interface ReviewItem {
  concept_id: string;
  concept_name: string;
  language_id: string;
  stage: number;
  due_day_key: string;
  last_result: ReviewResult | null;
  learned_day_key: string;
  days_since_learned: number;
  negative_feelings: number;
}

// ───────────────────────── Practice / AI ─────────────────────────
export type ProblemStyle = 'beginner' | 'story' | 'cf';
export interface PracticeConfig {
  language_id: string;
  concept_ids: string[];
  difficulty: number; // 1–5
  count: number; // 1–10
  style: ProblemStyle;
  include_struggles: boolean;
  /** API mode only; null = default provider */
  provider_id?: string | null;
}

export interface BuiltPrompt {
  prompt: string;
  prompt_version: number;
  struggles: string[];
}

export interface ImportPreview {
  ok: boolean;
  /** 'INVALID_JSON' | 'SCHEMA' when !ok */
  error_code: string | null;
  problems: GeneratedProblem[];
  errors: string[];
  warnings: string[];
}

export interface GenerateResult {
  prompt: string;
  raw_text: string;
  preview: ImportPreview;
  provider: string;
  model: string;
}

export interface ImportInput {
  config: PracticeConfig;
  raw_text: string;
  mode: 'copy_prompt' | 'api';
  /** API mode: provider kind + model used */
  provider?: string | null;
  model?: string | null;
}

export interface ImportResult {
  set_id: string;
  problems: Problem[];
  warnings: string[];
}

export interface ProviderReliability {
  provider: string;
  model: string;
  total: number;
  flagged: number;
}

export type AiProviderKind = 'ollama' | 'openai_compatible' | 'gemini' | 'anthropic' | 'openrouter';
export interface AiProvider {
  id: string;
  kind: AiProviderKind;
  label: string;
  base_url: string | null;
  model: string;
  has_key: boolean;
  /** "••••1234" or null */
  key_hint: string | null;
  is_default: boolean;
}
export interface AiProviderInput {
  id?: string | null;
  kind: AiProviderKind;
  label: string;
  base_url?: string | null;
  model: string;
  is_default?: boolean;
}
export interface AiTestResult {
  ok: boolean;
  message: string;
  latency_ms: number;
}

// ───────────────────────── Reports ─────────────────────────
export interface ReportInput {
  range: DayRange;
  language_id?: string | null;
  include_diary: boolean;
}
export interface ReportConcept {
  name: string;
  language: string;
  category: string | null;
  note: string | null;
  learned_day_key: string;
  review_stage: number | null;
  practiced_count: number;
  last_practiced: string | null;
  felt_stuck: boolean;
}
export interface ReportProblem {
  title: string;
  difficulty: number | null;
  status: ProblemStatus;
  seconds: number;
  feeling: string | null;
  concepts: string[];
  day_key: string | null;
}
export interface ReportData {
  generated_at: string;
  range: DayRange;
  profile: Profile;
  language: string | null;
  journey_day: number;
  totals: {
    focused_seconds: number;
    days_active: number;
    concepts: number;
    problems_solved: number;
    problems_attempted: number;
    avg_mood: number | null;
    avg_usefulness: number | null;
    current_streak: number;
  };
  days: DailyPoint[];
  concepts: ReportConcept[];
  problems: ReportProblem[];
  insights: Insight[];
  diary: { day_key: string; body: string }[] | null;
}

// ───────────────────────── Library ─────────────────────────
export type ResourceKind = 'link' | 'image' | 'pdf' | 'note' | 'file';
export interface Resource {
  id: string;
  kind: ResourceKind;
  title: string;
  url: string | null;
  /** relative to library/ */
  file_path: string | null;
  /** absolute path, for convertFileSrc() previews */
  abs_path: string | null;
  body: string | null;
  sha256: string | null;
  language_id: string | null;
  concept_ids: string[];
  created_at: string;
  updated_at: string;
}
export interface ResourceFilter {
  kind?: ResourceKind | null;
  concept_id?: string | null;
  language_id?: string | null;
  query?: string | null;
}

// ───────────────────────── Roadmaps ─────────────────────────
export type NodeStatus = 'not_started' | 'learning' | 'done';
export interface Roadmap {
  id: string;
  title: string;
  source: 'custom' | 'import';
  source_ref: string | null;
  node_count: number;
  done_count: number;
  created_at: string;
  updated_at: string;
}
export interface RoadmapNode {
  id: string;
  roadmap_id: string;
  parent_id: string | null;
  title: string;
  position: number;
  status: NodeStatus;
  concept_ids: string[];
  updated_at: string;
}
export interface RoadmapDetail {
  roadmap: Roadmap;
  /** flat list; build the tree from parent_id + position */
  nodes: RoadmapNode[];
}
export interface RoadmapNodeInput {
  id?: string | null;
  roadmap_id: string;
  parent_id?: string | null;
  title: string;
  concept_ids?: string[];
}

// ───────────────────────── Letters ─────────────────────────
export interface Letter {
  id: string;
  written_at: string;
  open_after: string; // day_key
  opened_at: string | null;
  can_open: boolean;
  /** null while sealed / unopened */
  body: string | null;
}

// ───────────────────────── Search ─────────────────────────
export type SearchKind = 'diary' | 'concept' | 'problem' | 'resource';
export interface SearchFilters {
  kinds?: SearchKind[] | null;
  from?: string | null;
  to?: string | null;
  limit?: number | null;
}
export interface SearchHit {
  kind: SearchKind;
  ref_id: string;
  day_key: string | null;
  title: string;
  /** plain text with «» around matches */
  snippet: string;
}

// ───────────────────────── Data ─────────────────────────
export interface BackupInfo {
  id: string;
  kind: string;
  created_at: string;
  size_bytes: number;
}
export interface DataInfo {
  data_dir: string;
  db_path: string;
  library_dir: string;
  backups_dir: string;
  logs_dir: string;
  db_size_bytes: number;
  schema_version: number;
  app_version: string;
}

// ───────────────────────── App bootstrap ─────────────────────────
export interface AppState {
  onboarding_done: boolean;
  profile: Profile | null;
  languages: Language[];
  settings: AppSettings;
  today: string;
  journey_day: number;
  active: ActiveState;
  app_version: string;
  is_debug: boolean;
}

// ───────────────────────── Command map ─────────────────────────
/** name → [args, result]. `args` is the object passed to invoke(). */
export interface Commands {
  app_state: [Record<string, never>, AppState];
  settings_get: [Record<string, never>, AppSettings];
  settings_update: [{ patch: Partial<AppSettings> }, AppSettings];

  profile_get: [Record<string, never>, Profile | null];
  profile_update: [{ input: ProfileUpdate }, Profile];
  onboarding_complete: [{ input: OnboardingInput }, AppState];

  language_list: [Record<string, never>, Language[]];
  language_add: [{ name: string }, Language];
  language_update: [{ id: string; name?: string | null; is_active?: boolean | null }, Language];
  language_set_primary: [{ id: string }, Language[]];

  session_start: [{ language_id?: string | null }, ActiveState];
  session_pause: [Record<string, never>, ActiveState];
  session_resume: [Record<string, never>, ActiveState];
  session_end: [{ ended_at?: string | null; confirm_long?: boolean }, SessionEndResult];
  session_active: [Record<string, never>, ActiveState];
  session_resolve_stale: [{ action: 'keep' | 'end'; ended_at?: string | null }, ActiveState];
  session_list: [{ day_key: string }, Session[]];
  session_update: [
    { id: string; started_at?: string | null; ended_at?: string | null; language_id?: string | null; note?: string | null },
    Session,
  ];
  session_delete: [{ id: string }, null];

  concept_category_list: [Record<string, never>, ConceptCategory[]];
  concept_category_add: [{ name: string }, ConceptCategory];
  concept_add: [{ input: ConceptInput }, Concept];
  concept_update: [{ input: ConceptUpdate }, Concept];
  concept_delete: [{ id: string }, null];
  concept_search: [{ prefix: string; language_id?: string | null }, Concept[]];
  concept_list: [{ range?: DayRange | null; language_id?: string | null }, Concept[]];

  problem_add: [{ input: ProblemInput }, Problem];
  problem_update: [{ input: ProblemUpdate }, Problem];
  problem_get: [{ id: string }, Problem];
  problem_delete: [{ id: string }, null];
  problem_set_status: [{ id: string; status: ProblemStatus }, Problem];
  problem_reveal: [{ id: string; what: 'hint' | 'answer' }, Problem];
  problem_flag_bad: [{ id: string; flagged: boolean }, Problem];
  problem_list: [{ filter: ProblemFilter }, Problem[]];

  attempt_start: [{ problem_id: string }, ActiveState];
  attempt_pause: [Record<string, never>, ActiveState];
  attempt_resume: [Record<string, never>, ActiveState];
  attempt_end: [Record<string, never>, ActiveState];

  mood_checkin: [{ value: number; kind: MoodKind; session_id?: string | null }, MoodCheckinResult];
  mood_history: [{ range: DayRange }, MoodCheckin[]];

  diary_save: [{ input: DiarySaveInput }, DiaryEntry];
  diary_get: [{ day_key: string }, DiaryEntry | null];
  diary_dismiss_link: [{ diary_id: string; concept_id: string }, DiaryEntry];
  /** v1.0 optional AI linking; rejects with VALIDATION unless settings.allow_diary_to_ai */
  diary_ai_suggest_links: [{ day_key: string }, DiaryEntry];
  feeling_tag_list: [Record<string, never>, FeelingTag[]];
  feeling_tag_add: [{ name: string; valence: -1 | 0 | 1 }, FeelingTag];

  day_get: [{ day_key: string }, DayView];
  day_close: [{ day_key: string; self_usefulness?: number | null }, DayCloseResult];
  day_calc_usefulness: [{ day_key: string }, UsefulnessBreakdown];
  day_set_self_usefulness: [{ day_key: string; value: number }, DayView];

  stats_overview: [{ language_id?: string | null }, StatsOverview];
  stats_series: [{ metric: SeriesMetric; range: DayRange; language_id?: string | null }, SeriesPoint[]];
  stats_daily: [{ range: DayRange; language_id?: string | null }, DailyPoint[]];
  stats_heatmap: [{ range: DayRange }, HeatCell[]];
  stats_charts: [{ range: DayRange; language_id?: string | null }, InsightCharts];

  insights_evaluate: [{ trigger: InsightTrigger }, Insight[]];
  insights_list: [{ include_dismissed?: boolean }, Insight[]];
  insight_dismiss: [{ id: string; disable_rule?: boolean }, null];
  insight_mark_seen: [{ ids: string[] }, null];
  insight_rule_toggle: [{ rule_id: InsightRuleId; enabled: boolean }, InsightRulePref[]];
  insight_rule_prefs: [Record<string, never>, InsightRulePref[]];

  review_due: [{ limit: number }, ReviewItem[]];
  review_record: [{ concept_id: string; result: ReviewResult }, ReviewItem];

  practice_build_prompt: [{ config: PracticeConfig }, BuiltPrompt];
  practice_generate: [{ config: PracticeConfig }, GenerateResult];
  practice_cancel: [Record<string, never>, null];
  practice_validate_response: [{ raw_text: string; config: PracticeConfig }, ImportPreview];
  practice_import_response: [{ input: ImportInput }, ImportResult];
  practice_fixup_prompt: [{ raw_text: string }, string];
  practice_reliability: [Record<string, never>, ProviderReliability[]];

  ai_provider_list: [Record<string, never>, AiProvider[]];
  ai_provider_save: [{ input: AiProviderInput }, AiProvider];
  ai_provider_delete: [{ id: string }, null];
  ai_provider_set_key: [{ id: string; key: string }, AiProvider];
  ai_provider_test: [{ id: string }, AiTestResult];

  report_data: [{ input: ReportInput }, ReportData];
  /** opens a save dialog; returns the saved path or null if cancelled */
  report_save_pdf: [{ bytes: number[]; suggested_name: string }, string | null];
  report_markdown: [{ input: ReportInput }, string];
  /** builds the markdown and opens a save dialog */
  report_save_markdown: [{ input: ReportInput; suggested_name: string }, string | null];

  resource_add_link: [{ url: string; title?: string | null; concept_ids?: string[]; language_id?: string | null }, Resource];
  resource_add_file: [{ path: string; title?: string | null; concept_ids?: string[]; language_id?: string | null }, Resource];
  resource_add_note: [{ title: string; body: string; concept_ids?: string[]; language_id?: string | null }, Resource];
  resource_update: [
    { id: string; title?: string | null; url?: string | null; body?: string | null; concept_ids?: string[] | null; language_id?: string | null },
    Resource,
  ];
  resource_delete: [{ id: string }, null];
  resource_list: [{ filter: ResourceFilter }, Resource[]];
  resource_open: [{ id: string }, null];
  resource_fetch_title: [{ url: string }, string | null];
  library_open_folder: [Record<string, never>, null];

  roadmap_create: [{ title: string }, Roadmap];
  roadmap_list: [Record<string, never>, Roadmap[]];
  roadmap_get: [{ id: string }, RoadmapDetail];
  roadmap_update: [{ id: string; title: string }, Roadmap];
  roadmap_delete: [{ id: string }, null];
  roadmap_node_upsert: [{ input: RoadmapNodeInput }, RoadmapNode];
  roadmap_node_delete: [{ id: string }, null];
  roadmap_node_move: [{ id: string; parent_id: string | null; position: number }, RoadmapDetail];
  roadmap_node_set_status: [{ id: string; status: NodeStatus }, RoadmapNode];
  /** path chosen by the user via the dialog plugin */
  roadmap_import_json: [{ path: string }, Roadmap];
  roadmap_export_json: [{ id: string; path: string }, null];

  letter_write: [{ body: string; open_after: string }, Letter];
  letter_list: [Record<string, never>, Letter[]];
  letter_open: [{ id: string }, Letter];

  search: [{ query: string; filters: SearchFilters }, SearchHit[]];

  backup_now: [Record<string, never>, BackupInfo];
  backup_list: [Record<string, never>, BackupInfo[]];
  backup_restore: [{ id: string }, null];
  export_all_json: [{ path: string; include_library: boolean }, string];
  delete_all_data: [{ confirm_phrase: string }, null];
  data_dir_move: [{ path: string }, DataInfo];
  data_info: [Record<string, never>, DataInfo];
  diagnostics_export: [{ path: string }, string];
}

export type CommandName = keyof Commands;
export type CommandArgs<K extends CommandName> = Commands[K][0];
export type CommandResult<K extends CommandName> = Commands[K][1];
