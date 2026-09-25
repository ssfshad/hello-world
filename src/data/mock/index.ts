/**
 * In-memory mock backend for running the UI in a plain browser (npm run dev)
 * and for component tests. Implements every command in the IPC contract with
 * plausible behaviour; it is never loaded inside the Tauri shell.
 *
 * It always starts empty (at onboarding), exactly like the real app. The seeded
 * dataset below is a test fixture, used only via `resetMock({ seeded: true })`.
 */
import type * as A from '@/core/types/api';
import { addDays, dayKeyFor, dayRange, daysBetween, weekStart, weekdayIndex } from '@/lib/day';
import { elapsedSeconds } from '@/lib/timer';
import { formatDuration, truncate } from '@/lib/format';
import { usefulness, compare, SCORE_VERSION } from './score';
import { computeStreaks } from '@/lib/streak';
import learningToolsSql from '../../../src-tauri/migrations/0004_learning_tools.sql?raw';
import {
  buildFixupPrompt,
  buildGeneratePrompt,
  buildHintPrompt,
  LLM_PREAMBLE,
  PROMPT_VERSION,
  validateResponse,
  DIFFICULTY_DEFS,
  JSON_SHAPE_EXAMPLE,
} from './prompts';

// ───────────────────────── storage types ─────────────────────────
interface SessionRow {
  id: string;
  language_id: string | null;
  started_at: string;
  ended_at: string | null;
  paused_seconds: number;
  paused_at: string | null;
  day_key: string;
  note: string | null;
  deleted: boolean;
}
interface AttemptRow {
  id: string;
  problem_id: string;
  session_id: string | null;
  started_at: string;
  ended_at: string | null;
  paused_seconds: number;
  paused_at: string | null;
  day_key: string;
}
interface ConceptRow {
  id: string;
  language_id: string;
  name: string;
  category_id: string | null;
  note: string | null;
  example_code: string | null;
  example_output: string | null;
  source_resource_id: string | null;
  learned_day_key: string;
  deleted: boolean;
  created_at: string;
  updated_at: string;
}
interface ProblemRow extends Omit<A.Problem, 'concept_names' | 'total_seconds' | 'active_attempt_id'> {
  deleted: boolean;
}
interface DiaryRow {
  id: string;
  day_key: string;
  body: string;
  links: { concept_id: string; source: A.LinkSource }[];
  feeling_tag_ids: string[];
  created_at: string;
  updated_at: string;
}
interface ReviewRow {
  concept_id: string;
  stage: number;
  due_day_key: string;
  last_result: A.ReviewResult | null;
}
interface ResourceRow extends A.Resource {
  deleted: boolean;
}
interface SetRow {
  id: string;
  mode: 'copy_prompt' | 'api';
  provider: string | null;
  model: string | null;
}
interface ProviderRow {
  id: string;
  kind: A.AiProviderKind;
  label: string;
  base_url: string | null;
  model: string;
  key: string | null;
  is_default: boolean;
}

interface ErrorRow extends Omit<A.ErrorNote, 'concept_name' | 'problem_title'> {
  deleted: boolean;
}
interface GlossaryRow extends A.GlossaryTerm {
  deleted: boolean;
}
interface WeeklyRow {
  clicked: string | null;
  fuzzy: string | null;
  focus: string | null;
  updated_at: string;
}

interface Db {
  errorNotes: ErrorRow[];
  glossary: GlossaryRow[];
  weekly: Record<string, WeeklyRow>;
  settings: A.AppSettings;
  profile: A.Profile | null;
  languages: A.Language[];
  sessions: SessionRow[];
  attempts: AttemptRow[];
  categories: A.ConceptCategory[];
  concepts: ConceptRow[];
  problems: ProblemRow[];
  feelings: A.FeelingTag[];
  moods: A.MoodCheckin[];
  diaries: DiaryRow[];
  summaries: Record<string, A.DaySummary>;
  review: ReviewRow[];
  sets: SetRow[];
  insights: A.Insight[];
  rulePrefs: Record<string, boolean>;
  letters: { id: string; body: string; written_at: string; open_after: string; opened_at: string | null }[];
  resources: ResourceRow[];
  roadmaps: Omit<A.Roadmap, 'node_count' | 'done_count'>[];
  nodes: A.RoadmapNode[];
  providers: ProviderRow[];
  backups: A.BackupInfo[];
  heartbeat: string | null;
}

// ───────────────────────── helpers ─────────────────────────
let idSeq = 0;
const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${(++idSeq).toString(36)}`;
const iso = (d: Date | number) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
const nowIso = () => iso(Date.now());
const err = (code: A.ErrorCode, message: string): A.AppErrorPayload => ({ code, message });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const RULE_IDS: A.InsightRuleId[] = [
  'comeback',
  'been_here_before',
  'shadowing_warning',
  'forgotten_concept',
  'best_time',
  'getting_faster',
  'mood_lift',
  'first_milestones',
];

const BUILTIN_FEELINGS: [string, string, -1 | 0 | 1][] = [
  ['ft-excited', 'Excited', 1],
  ['ft-proud', 'Proud', 1],
  ['ft-aha', 'Aha!', 1],
  ['ft-confused', 'Confused', -1],
  ['ft-stuck', 'Stuck', -1],
  ['ft-frustrated', 'Frustrated', -1],
  ['ft-loser', 'Felt like a loser', -1],
  ['ft-bored', 'Bored', 0],
  ['ft-anxious', 'Anxious', -1],
];

const CATEGORIES = [
  'Basics',
  'Variables',
  'Conditionals',
  'Loops',
  'Strings',
  'Lists',
  'Dictionaries',
  'Functions',
  'Classes',
  'Recursion',
  'Files',
  'Errors',
  'Other',
];

const REVIEW_INTERVALS = [1, 3, 7, 14, 30, 60];

/** Built-in glossary terms, read from the same migration the Rust core runs. */
const BUILTIN_GLOSSARY: [string, string, string][] = [
  ...learningToolsSql.matchAll(/\('(gt-[a-z-]+)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'/g),
].map((m) => [m[1], m[2].replace(/''/g, "'"), m[3].replace(/''/g, "'")]);

function emptyDb(): Db {
  return {
    errorNotes: [],
    glossary: BUILTIN_GLOSSARY.map(([id, term, definition]) => ({
      id,
      term,
      definition,
      language_id: null,
      is_builtin: true,
      updated_at: '2026-09-26T00:00:00Z',
      deleted: false,
    })),
    weekly: {},
    settings: {
      theme: 'system',
      allow_diary_to_ai: false,
      open_on: 'dashboard',
      font_size: 'm',
      reduced_motion: false,
      reminder_time: null,
      auto_update: true,
      log_level: 'info',
      onboarding_done: false,
    },
    profile: null,
    languages: [],
    sessions: [],
    attempts: [],
    categories: CATEGORIES.map((name) => ({ id: `cc-${name.toLowerCase()}`, name })),
    concepts: [],
    problems: [],
    feelings: BUILTIN_FEELINGS.map(([id, name, valence]) => ({ id, name, valence, is_builtin: true })),
    moods: [],
    diaries: [],
    summaries: {},
    review: [],
    sets: [],
    insights: [],
    rulePrefs: {},
    letters: [],
    resources: [],
    roadmaps: [],
    nodes: [],
    providers: [],
    backups: [],
    heartbeat: null,
  };
}

let db: Db = emptyDb();

function boundary() {
  return db.profile?.day_boundary ?? '04:00';
}
function dk(d: Date | number | string = Date.now()) {
  return dayKeyFor(new Date(d), boundary());
}
function today() {
  return dk();
}
function journeyDay(day = today()) {
  return db.profile ? daysBetween(db.profile.journey_start, day) + 1 : 1;
}
function primaryLanguage() {
  return db.languages.find((l) => l.is_primary) ?? db.languages[0] ?? null;
}

// ───────────────────────── DTO builders ─────────────────────────
function sessionDto(s: SessionRow): A.Session {
  const now = Date.now();
  return {
    id: s.id,
    language_id: s.language_id,
    started_at: s.started_at,
    ended_at: s.ended_at,
    paused_seconds: s.paused_seconds,
    paused_at: s.paused_at,
    day_key: s.day_key,
    note: s.note,
    elapsed_seconds: elapsedSeconds(s, now),
    is_running: !s.ended_at,
    is_paused: !s.ended_at && !!s.paused_at,
  };
}

function attemptDto(a: AttemptRow): A.Attempt {
  const p = db.problems.find((x) => x.id === a.problem_id);
  return {
    ...a,
    problem_title: p?.title ?? '',
    elapsed_seconds: elapsedSeconds(a, Date.now()),
    is_running: !a.ended_at,
    is_paused: !a.ended_at && !!a.paused_at,
  };
}

/** Mirrors the core: all-blank → null; otherwise keep indentation, trim trailing space. */
function blank(v: string | null | undefined): string | null {
  if (!v || !v.trim()) return null;
  return v.replace(/\s+$/, '').replace(/^[\r\n]+/, '');
}

function conceptDto(c: ConceptRow): A.Concept {
  const r = db.review.find((x) => x.concept_id === c.id);
  return {
    id: c.id,
    language_id: c.language_id,
    name: c.name,
    category_id: c.category_id,
    category_name: db.categories.find((x) => x.id === c.category_id)?.name ?? null,
    note: c.note,
    example_code: c.example_code,
    example_output: c.example_output,
    source_resource_id: c.source_resource_id,
    learned_day_key: c.learned_day_key,
    review_stage: r?.stage ?? null,
    due_day_key: r?.due_day_key ?? null,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

function problemSeconds(id: string) {
  const now = Date.now();
  return db.attempts.filter((a) => a.problem_id === id).reduce((acc, a) => acc + elapsedSeconds(a, now), 0);
}

function problemDto(p: ProblemRow): A.Problem {
  const { deleted: _d, ...rest } = p;
  void _d;
  const active = db.attempts.find((a) => a.problem_id === p.id && !a.ended_at);
  return {
    ...clone(rest),
    concept_names: p.concept_ids
      .map((id) => db.concepts.find((c) => c.id === id)?.name)
      .filter((n): n is string => !!n),
    total_seconds: problemSeconds(p.id),
    active_attempt_id: active?.id ?? null,
  };
}

function diaryDto(d: DiaryRow): A.DiaryEntry {
  return {
    id: d.id,
    day_key: d.day_key,
    body: d.body,
    concept_links: d.links
      .map((l) => ({ ...l, name: db.concepts.find((c) => c.id === l.concept_id)?.name ?? '' }))
      .filter((l) => l.name),
    feeling_tag_ids: [...d.feeling_tag_ids],
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

function activeState(): A.ActiveState {
  const s = db.sessions.find((x) => !x.ended_at && !x.deleted);
  const a = db.attempts.find((x) => !x.ended_at);
  let stale: A.StaleSession | null = null;
  if (s) {
    const hb = db.heartbeat ? Date.parse(db.heartbeat) : Date.parse(s.started_at);
    if (Date.now() - hb > 30 * 60_000) stale = { session: sessionDto(s), last_heartbeat: db.heartbeat };
  }
  return {
    session: s ? sessionDto(s) : null,
    attempt: a ? attemptDto(a) : null,
    stale,
    server_now: nowIso(),
  };
}

// ───────────────────────── day computations ─────────────────────────
function liveSessions(day?: string, lang?: string | null) {
  return db.sessions.filter(
    (s) => !s.deleted && (!day || s.day_key === day) && (!lang || s.language_id === lang),
  );
}
function liveConcepts(lang?: string | null) {
  return db.concepts.filter((c) => !c.deleted && (!lang || c.language_id === lang));
}
function liveProblems(lang?: string | null) {
  return db.problems.filter((p) => !p.deleted && (!lang || p.language_id === lang));
}

function dayMoods(day: string) {
  return db.moods.filter((m) => m.day_key === day);
}

function calcFor(day: string, lang?: string | null): A.UsefulnessBreakdown {
  const now = Date.now();
  const secs = liveSessions(day, lang).reduce((a, s) => a + elapsedSeconds(s, now), 0);
  const concepts = liveConcepts(lang).filter((c) => c.learned_day_key === day).length;
  const done = liveProblems(lang).filter((p) => p.day_key === day && !p.flagged_bad);
  const solved = done.reduce(
    (acc, p) => acc + (p.status === 'solved' ? 1 : p.status === 'solved_with_help' ? 0.7 : 0),
    0,
  );
  let attempted = done.filter((p) => p.status === 'gave_up' || p.status === 'revisit').length;
  attempted += liveProblems(lang).filter((p) => {
    if (p.status !== 'in_progress' || p.flagged_bad) return false;
    const s = db.attempts
      .filter((a) => a.problem_id === p.id && a.day_key === day)
      .reduce((acc, a) => acc + elapsedSeconds(a, now), 0);
    return s >= 300;
  }).length;
  const moods = dayMoods(day);
  const reflected =
    db.diaries.some((d) => d.day_key === day && d.body.trim().length > 0) ||
    (moods.some((m) => m.kind === 'session_start') && moods.some((m) => m.kind === 'session_end'));
  return usefulness({
    focusedMinutes: secs / 60,
    goalMinutes: db.profile?.daily_goal_min ?? 60,
    concepts,
    solved: Math.round(solved * 10) / 10,
    attempted,
    reflected,
  });
}

function summaryText(c: A.UsefulnessBreakdown) {
  const probs = Math.ceil(c.solved) + c.attempted;
  return `${formatDuration(c.focused_minutes * 60)}, ${c.concepts} concept${c.concepts === 1 ? '' : 's'} and ${probs} problem${probs === 1 ? '' : 's'}`;
}

function avg(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function round1(x: number | null) {
  return x == null ? null : Math.round(x * 10) / 10;
}

function daySummary(day: string, selfU: number | null): A.DaySummary {
  const c = calcFor(day);
  const moods = dayMoods(day);
  return {
    day_key: day,
    focused_seconds: Math.round(c.focused_minutes * 60),
    concepts_count: c.concepts,
    problems_solved: Math.ceil(c.solved),
    problems_attempted: c.attempted,
    mood_avg: round1(avg(moods.map((m) => m.value))),
    mood_before: round1(avg(moods.filter((m) => m.kind === 'session_start').map((m) => m.value))),
    mood_after: round1(avg(moods.filter((m) => m.kind === 'session_end').map((m) => m.value))),
    self_usefulness: selfU,
    calc_usefulness: c.score,
    score_version: SCORE_VERSION,
    closed_at: nowIso(),
  };
}

function dayProblems(day: string) {
  return liveProblems().filter(
    (p) =>
      p.created_day_key === day ||
      p.day_key === day ||
      db.attempts.some((a) => a.problem_id === p.id && a.day_key === day),
  );
}

function dayView(day: string): A.DayView {
  const calc = calcFor(day);
  const summary = db.summaries[day] ?? null;
  const diary = db.diaries.find((d) => d.day_key === day);
  return {
    day_key: day,
    is_today: day === today(),
    sessions: liveSessions(day)
      .map(sessionDto)
      .sort((a, b) => a.started_at.localeCompare(b.started_at)),
    focused_seconds: Math.round(calc.focused_minutes * 60),
    concepts: liveConcepts()
      .filter((c) => c.learned_day_key === day)
      .map(conceptDto),
    problems: dayProblems(day).map(problemDto),
    moods: dayMoods(day).sort((a, b) => a.at.localeCompare(b.at)),
    diary: diary ? diaryDto(diary) : null,
    summary,
    calc,
    comparison:
      summary?.self_usefulness != null ? compare(summary.self_usefulness, calc, summaryText(calc)) : null,
  };
}

function hasActivity(day: string) {
  return (
    liveSessions(day).length > 0 ||
    liveConcepts().some((c) => c.learned_day_key === day) ||
    liveProblems().some((p) => p.day_key === day || p.created_day_key === day) ||
    db.diaries.some((d) => d.day_key === day) ||
    dayMoods(day).length > 0
  );
}

function streaks() {
  const t = today();
  const start = db.profile?.journey_start ?? t;
  return computeStreaks(dayRange(start, t).filter(hasActivity), t);
}

function dailyPoints(range: A.DayRange, lang?: string | null): A.DailyPoint[] {
  const comebacks = new Set(
    db.insights.filter((i) => i.rule_id === 'comeback').map((i) => String(i.payload.day_key)),
  );
  return dayRange(range.from, range.to).map((day) => {
    const c = calcFor(day, lang);
    const moods = dayMoods(day);
    const active = hasActivity(day);
    const diary = db.diaries.find((d) => d.day_key === day);
    return {
      day_key: day,
      minutes: Math.round(c.focused_minutes),
      usefulness: active ? (db.summaries[day]?.calc_usefulness ?? c.score) : null,
      mood_avg: round1(avg(moods.map((m) => m.value))),
      mood_before: round1(avg(moods.filter((m) => m.kind === 'session_start').map((m) => m.value))),
      mood_after: round1(avg(moods.filter((m) => m.kind === 'session_end').map((m) => m.value))),
      concepts: c.concepts,
      solved: Math.ceil(c.solved),
      attempted: c.attempted,
      comeback: comebacks.has(day),
      diary_snippet: diary ? truncate(diary.body, 80) : null,
    };
  });
}

function heatBucket(minutes: number): 0 | 1 | 2 | 3 | 4 {
  const goal = db.profile?.daily_goal_min ?? 60;
  if (minutes <= 0) return 0;
  if (minutes < goal * 0.25) return 1;
  if (minutes < goal * 0.5) return 2;
  if (minutes < goal) return 3;
  return 4;
}

// ───────────────────────── review ─────────────────────────
function scheduleReview(conceptId: string, stage: number, result: A.ReviewResult | null) {
  const s = Math.max(0, Math.min(5, stage));
  const row = db.review.find((r) => r.concept_id === conceptId);
  const due = addDays(today(), REVIEW_INTERVALS[s]);
  if (row) {
    row.stage = s;
    row.due_day_key = due;
    row.last_result = result;
  } else db.review.push({ concept_id: conceptId, stage: s, due_day_key: due, last_result: result });
}

function applyProblemToReview(p: ProblemRow) {
  for (const cid of p.concept_ids) {
    const r = db.review.find((x) => x.concept_id === cid);
    const stage = r?.stage ?? 0;
    if (p.status === 'solved') scheduleReview(cid, stage + 1, 'ok');
    else if (p.status === 'solved_with_help') scheduleReview(cid, stage, 'hard');
    else if (p.status === 'gave_up' || p.status === 'revisit') scheduleReview(cid, stage - 1, 'hard');
  }
}

function negativeFeelings(conceptId: string) {
  const neg = new Set(db.feelings.filter((f) => f.valence < 0).map((f) => f.id));
  let n = 0;
  for (const p of liveProblems()) if (p.concept_ids.includes(conceptId) && p.feeling_tag_id && neg.has(p.feeling_tag_id)) n++;
  for (const d of db.diaries)
    if (d.links.some((l) => l.concept_id === conceptId)) n += d.feeling_tag_ids.filter((f) => neg.has(f)).length;
  return n;
}

function reviewDto(r: ReviewRow): A.ReviewItem | null {
  const c = db.concepts.find((x) => x.id === r.concept_id && !x.deleted);
  if (!c) return null;
  return {
    concept_id: c.id,
    concept_name: c.name,
    language_id: c.language_id,
    stage: r.stage,
    due_day_key: r.due_day_key,
    last_result: r.last_result,
    learned_day_key: c.learned_day_key,
    days_since_learned: daysBetween(c.learned_day_key, today()),
    negative_feelings: negativeFeelings(c.id),
  };
}

// ───────────────────────── insights ─────────────────────────
function addInsight(rule_id: A.InsightRuleId, dedupe: string, priority: number, payload: A.Insight['payload']) {
  if (db.rulePrefs[rule_id] === false) return null;
  if ((db as Db & { _dedupe?: Set<string> })._dedupe?.has(dedupe)) return null;
  const store = ((db as Db & { _dedupe?: Set<string> })._dedupe ??= new Set());
  store.add(dedupe);
  const ins: A.Insight = { id: uid(), rule_id, priority, payload, created_at: nowIso(), seen_at: null, dismissed_at: null };
  db.insights.push(ins);
  return ins;
}

function findComebacks() {
  const out: { diary: DiaryRow; concept: ConceptRow; mood: number; daysLater: number; count: number }[] = [];
  for (const d of db.diaries) {
    const moods = dayMoods(d.day_key).map((m) => m.value);
    if (!moods.length) continue;
    const mood = Math.min(...moods);
    if (mood > 2) continue;
    for (const l of d.links) {
      const concept = db.concepts.find((c) => c.id === l.concept_id && !c.deleted);
      if (!concept) continue;
      const solvedAfter = liveProblems()
        .filter(
          (p) =>
            p.concept_ids.includes(concept.id) &&
            (p.status === 'solved' || p.status === 'solved_with_help') &&
            p.day_key &&
            daysBetween(d.day_key, p.day_key) > 0 &&
            daysBetween(d.day_key, p.day_key) <= 14,
        )
        .sort((a, b) => a.day_key!.localeCompare(b.day_key!));
      if (solvedAfter.length >= 2) {
        out.push({
          diary: d,
          concept,
          mood,
          daysLater: daysBetween(d.day_key, solvedAfter[1].day_key!),
          count: solvedAfter.length,
        });
      }
    }
  }
  return out;
}

function comebackPayload(c: ReturnType<typeof findComebacks>[number]) {
  return {
    day_number: journeyDay(c.diary.day_key),
    day_key: c.diary.day_key,
    mood: c.mood,
    snippet: truncate(c.diary.body, 90),
    days_later: c.daysLater,
    count: c.count,
    concept: c.concept.name,
    concept_id: c.concept.id,
  };
}

function evaluate(trigger: A.InsightTrigger, moodValue?: number): A.Insight[] {
  const created: A.Insight[] = [];
  const push = (i: A.Insight | null) => i && created.push(i);
  const t = today();
  if (trigger === 'day_closed') {
    for (const c of findComebacks()) push(addInsight('comeback', `comeback:${c.diary.id}:${c.concept.id}`, 90, comebackPayload(c)));
    const calc = calcFor(t);
    if (calc.focused_minutes >= 90 && calc.solved + calc.attempted === 0)
      push(addInsight('shadowing_warning', `shadowing:${t}`, 70, { minutes: calc.focused_minutes, day_key: t }));
    const concepts = liveConcepts().length;
    const live = liveProblems().filter((p) => !p.flagged_bad);
    const alone = live.filter((p) => p.status === 'solved').length;
    const withHelp = live.filter((p) => p.status === 'solved_with_help').length;
    const hours = Math.floor(liveSessions().reduce((a, s) => a + elapsedSeconds(s, Date.now()), 0) / 3600);
    for (const m of [10, 25, 50, 100]) {
      if (concepts >= m) push(addInsight('first_milestones', `milestone:concepts:${m}`, 50, { kind: 'concepts', value: m }));
      if (alone >= m) push(addInsight('first_milestones', `milestone:problems:${m}`, 50, { kind: 'problems', value: m }));
      if (withHelp >= m)
        push(addInsight('first_milestones', `milestone:problems_with_help:${m}`, 50, { kind: 'problems_with_help', value: m }));
      if (hours >= m) push(addInsight('first_milestones', `milestone:hours:${m}`, 50, { kind: 'hours', value: m }));
    }
  }
  if (trigger === 'mood_logged' && (moodValue ?? 5) <= 2) {
    const past = findComebacks().sort((a, b) => b.diary.day_key.localeCompare(a.diary.day_key))[0];
    if (past) push(addInsight('been_here_before', `bhb:${t}:${past.diary.id}`, 100, comebackPayload(past)));
  }
  if (trigger === 'app_opened') {
    for (const c of liveConcepts()) {
      const days = daysBetween(c.learned_day_key, t);
      if (days >= 7 && !liveProblems().some((p) => p.concept_ids.includes(c.id))) {
        push(addInsight('forgotten_concept', `forgotten:${c.id}`, 60, { concept: c.name, concept_id: c.id, days }));
        break;
      }
    }
  }
  if (trigger === 'weekly' || trigger === 'app_opened') {
    const ws = weekStart(t);
    const pts = dailyPoints({ from: addDays(t, -13), to: t });
    const pairs = pts.filter((p) => p.mood_before != null && p.mood_after != null);
    if (pairs.length >= 4) {
      const delta = avg(pairs.map((p) => p.mood_after! - p.mood_before!))!;
      if (delta >= 0.5) push(addInsight('mood_lift', `mood_lift:${ws}`, 40, { delta: Math.round(delta * 10) / 10 }));
    }
    const byHour = hourBuckets(addDays(t, -60), t);
    const all = avg(byHour.flatMap((b) => Array(b.sessions).fill(b.avg) as number[]));
    const top = [...byHour].sort((a, b) => b.avg - a.avg)[0];
    if (top && all != null && top.sessions >= 3 && top.avg - all >= 15)
      push(
        addInsight('best_time', `best_time:${ws}`, 45, {
          hour_start: top.hour,
          hour_end: (top.hour + 2) % 24,
          avg: Math.round(top.avg),
          overall_avg: Math.round(all),
        }),
      );
  }
  return created.sort((a, b) => b.priority - a.priority);
}

function hourBuckets(from: string, to: string) {
  const map = new Map<number, number[]>();
  for (const s of liveSessions()) {
    if (s.day_key < from || s.day_key > to) continue;
    const h = new Date(s.started_at).getHours();
    const bucket = h - (h % 2);
    const u = db.summaries[s.day_key]?.calc_usefulness ?? calcFor(s.day_key).score;
    map.set(bucket, [...(map.get(bucket) ?? []), u]);
  }
  return [...map.entries()]
    .map(([hour, xs]) => ({ hour, avg: avg(xs)!, sessions: xs.length }))
    .sort((a, b) => a.hour - b.hour);
}

// ───────────────────────── diary keyword linking ─────────────────────────
function variants(name: string): string[] {
  const base = name.toLowerCase().replace(/\(\)/g, '').trim();
  const v = new Set([base, base.replace(/-/g, ' '), base.replace(/\s+/g, '-')]);
  for (const x of [...v]) {
    v.add(x.endsWith('s') ? x.slice(0, -1) : `${x}s`);
  }
  return [...v].filter(Boolean);
}

function keywordLinks(body: string): string[] {
  const text = ` ${body.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ')} `;
  return liveConcepts()
    .filter((c) => variants(c.name).some((v) => text.includes(` ${v} `)))
    .map((c) => c.id);
}

// ───────────────────────── search ─────────────────────────
function snippet(text: string, q: string) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return truncate(text, 120);
  const start = Math.max(0, i - 40);
  return (
    (start > 0 ? '…' : '') +
    text.slice(start, i) +
    '«' +
    text.slice(i, i + q.length) +
    '»' +
    truncate(text.slice(i + q.length), 80)
  );
}

// ───────────────────────── prompt helpers ─────────────────────────
function struggleNames(lang: string) {
  const stuck = new Set(['ft-stuck', 'ft-confused', 'ft-frustrated']);
  const names = new Set<string>();
  for (const p of liveProblems(lang))
    if (p.status === 'revisit' || p.status === 'gave_up' || (p.feeling_tag_id && stuck.has(p.feeling_tag_id)))
      for (const id of p.concept_ids) {
        const c = db.concepts.find((x) => x.id === id);
        if (c) names.add(c.name);
      }
  return [...names].slice(0, 6);
}

function buildPrompt(cfg: A.PracticeConfig): A.BuiltPrompt {
  const lang = db.languages.find((l) => l.id === cfg.language_id);
  if (!lang) throw err('VALIDATION', 'Pick a language first.');
  const concepts = cfg.concept_ids
    .map((id) => db.concepts.find((c) => c.id === id))
    .filter((c): c is ConceptRow => !!c);
  if (!concepts.length) throw err('VALIDATION', 'Pick at least one concept.');
  const struggles = cfg.include_struggles ? struggleNames(lang.id) : [];
  return {
    prompt: buildGeneratePrompt({
      language: lang.name,
      journey_day: journeyDay(),
      concepts: concepts.map((c) => ({ name: c.name, note: c.note })),
      count: cfg.count,
      difficulty: cfg.difficulty,
      style: cfg.style,
      struggles,
    }),
    prompt_version: PROMPT_VERSION,
    struggles,
  };
}

function conceptNames(ids: string[]) {
  return ids.map((id) => db.concepts.find((c) => c.id === id)?.name).filter((n): n is string => !!n);
}

function fakeAiResponse(cfg: A.PracticeConfig): string {
  const names = conceptNames(cfg.concept_ids);
  const problems = Array.from({ length: cfg.count }, (_, i) => {
    const c = names[i % names.length] ?? 'loops';
    return {
      title: `${['Counting', 'Echo', 'Tally', 'Mirror', 'Sum up', 'Pairs', 'Steps', 'Stars', 'Bins', 'Relay'][i % 10]} with ${c}`,
      difficulty: cfg.difficulty,
      concepts: [c],
      statement: `Read a number n, then use ${c} to print the numbers from 1 to n, each on its own line.`,
      input_format: 'A single integer n (1 ≤ n ≤ 100).',
      output_format: 'n lines, the i-th line contains i.',
      constraints: '1 ≤ n ≤ 100',
      samples: [
        { input: '3', output: '1\n2\n3' },
        { input: '1', output: '1', explanation: 'Only one number to print.' },
      ],
      hint: `Think about how ${c} lets you repeat an action n times.`,
      reference_solution: 'n = int(input())\nfor i in range(1, n + 1):\n    print(i)',
    };
  });
  return '```json\n' + JSON.stringify({ problems }, null, 2) + '\n```';
}

// ───────────────────────── reports ─────────────────────────
function reportData(input: A.ReportInput): A.ReportData {
  if (!db.profile) throw err('NOT_FOUND', 'profile not found');
  const lang = input.language_id ?? null;
  const days = dailyPoints(input.range, lang);
  const inRange = (d: string | null) => !!d && d >= input.range.from && d <= input.range.to;
  const concepts = liveConcepts(lang).filter((c) => inRange(c.learned_day_key));
  const problems = liveProblems(lang).filter((p) => inRange(p.day_key) || inRange(p.created_day_key));
  const moods = days.map((d) => d.mood_avg).filter((m): m is number => m != null);
  const uses = days.map((d) => d.usefulness).filter((u): u is number => u != null);
  return {
    generated_at: nowIso(),
    range: input.range,
    profile: clone(db.profile),
    language: lang ? (db.languages.find((l) => l.id === lang)?.name ?? null) : null,
    journey_day: journeyDay(),
    totals: {
      focused_seconds: days.reduce((a, d) => a + d.minutes * 60, 0),
      days_active: days.filter((d) => d.minutes > 0 || d.concepts > 0 || d.solved > 0).length,
      concepts: concepts.length,
      problems_solved: days.reduce((a, d) => a + d.solved, 0),
      problems_attempted: days.reduce((a, d) => a + d.attempted, 0),
      avg_mood: round1(avg(moods)),
      avg_usefulness: uses.length ? Math.round(avg(uses)!) : null,
      current_streak: streaks().current,
    },
    days,
    concepts: concepts.map((c) => {
      const practiced = liveProblems().filter((p) => p.concept_ids.includes(c.id) && p.day_key);
      return {
        name: c.name,
        language: db.languages.find((l) => l.id === c.language_id)?.name ?? '',
        category: db.categories.find((x) => x.id === c.category_id)?.name ?? null,
        note: c.note,
        learned_day_key: c.learned_day_key,
        review_stage: db.review.find((r) => r.concept_id === c.id)?.stage ?? null,
        practiced_count: practiced.length,
        last_practiced: practiced.map((p) => p.day_key!).sort().pop() ?? null,
        felt_stuck: negativeFeelings(c.id) > 0,
      };
    }),
    problems: problems.map((p) => ({
      title: p.title,
      difficulty: p.difficulty,
      status: p.status,
      seconds: problemSeconds(p.id),
      feeling: db.feelings.find((f) => f.id === p.feeling_tag_id)?.name ?? null,
      concepts: conceptNames(p.concept_ids),
      day_key: p.day_key,
    })),
    insights: db.insights.filter((i) => !i.dismissed_at).slice(0, 5),
    diary: input.include_diary
      ? db.diaries.filter((d) => inRange(d.day_key)).map((d) => ({ day_key: d.day_key, body: d.body }))
      : null,
  };
}

function reportMarkdown(input: A.ReportInput): string {
  const r = reportData(input);
  const lines: string[] = [LLM_PREAMBLE, `# Learning report — ${r.profile.display_name}`, ''];
  lines.push(`Range: ${r.range.from} to ${r.range.to} · Day ${r.journey_day} of the journey`);
  lines.push(
    `Focused time: ${formatDuration(r.totals.focused_seconds)} · Concepts: ${r.totals.concepts} · Solved: ${r.totals.problems_solved} · Attempted: ${r.totals.problems_attempted}`,
    '',
    '## Concepts learned',
  );
  for (const c of r.concepts) {
    const flags = [c.felt_stuck ? 'felt stuck' : null, c.practiced_count === 0 ? 'not practiced since' : null]
      .filter(Boolean)
      .join(', ');
    lines.push(`- **${c.name}** (${c.language}, learned ${c.learned_day_key})${flags ? ` — ${flags}` : ''}${c.note ? `: ${c.note}` : ''}`);
  }
  lines.push('', '## Problems practiced');
  for (const p of r.problems)
    lines.push(`- ${p.title} — level ${p.difficulty ?? '?'}, ${p.status}, ${formatDuration(p.seconds)}${p.feeling ? `, felt ${p.feeling}` : ''}`);
  lines.push('', '## Day by day');
  for (const d of r.days.filter((d) => d.minutes > 0))
    lines.push(`- ${d.day_key}: ${d.minutes} min, mood ${d.mood_avg ?? '–'}, usefulness ${d.usefulness ?? '–'}`);
  if (r.diary?.length) {
    lines.push('', '## Diary');
    for (const d of r.diary) lines.push(`- ${d.day_key}: ${d.body}`);
  }
  lines.push('', '## Difficulty scale');
  for (let i = 1; i <= 5; i++) lines.push(`${i}. ${DIFFICULTY_DEFS[i]}`);
  lines.push('', '## JSON format for problems', '```json', JSON_SHAPE_EXAMPLE, '```');
  let md = lines.join('\n');
  if (md.length > 12_000) md = md.slice(0, 11_900) + '\n\n(older days summarized)';
  return md;
}

function browserDownload(name: string, data: BlobPart, type: string) {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ───────────────────────── commands ─────────────────────────
type Handler = (args: Record<string, unknown>) => unknown;
/* eslint-disable @typescript-eslint/no-explicit-any */
const arg = <T>(a: Record<string, unknown>, k: string) => a[k] as T;

function appState(): A.AppState {
  return {
    onboarding_done: db.settings.onboarding_done,
    profile: db.profile ? clone(db.profile) : null,
    languages: clone(db.languages),
    settings: clone(db.settings),
    today: today(),
    journey_day: journeyDay(),
    active: activeState(),
    app_version: '1.0.0-mock',
    is_debug: true,
  };
}

function requireSession() {
  const s = db.sessions.find((x) => !x.ended_at && !x.deleted);
  if (!s) throw err('CONFLICT', 'No session is running.');
  return s;
}

function endAttempt(a: AttemptRow, at: string) {
  if (a.paused_at) {
    a.paused_seconds += Math.max(0, (Date.parse(at) - Date.parse(a.paused_at)) / 1000);
    a.paused_at = null;
  }
  a.ended_at = at;
}

function endSession(s: SessionRow, at: string) {
  const a = db.attempts.find((x) => !x.ended_at && x.session_id === s.id);
  if (a) endAttempt(a, at);
  if (s.paused_at) {
    s.paused_seconds += Math.max(0, Math.round((Date.parse(at) - Date.parse(s.paused_at)) / 1000));
    s.paused_at = null;
  }
  s.ended_at = at;
}

function startSession(language_id: string | null) {
  const running = db.sessions.find((x) => !x.ended_at && !x.deleted);
  if (running) return running;
  const s: SessionRow = {
    id: uid(),
    language_id: language_id ?? primaryLanguage()?.id ?? null,
    started_at: nowIso(),
    ended_at: null,
    paused_seconds: 0,
    paused_at: null,
    day_key: today(),
    note: null,
    deleted: false,
  };
  db.sessions.push(s);
  db.heartbeat = nowIso();
  return s;
}

function getProblem(id: string) {
  const p = db.problems.find((x) => x.id === id && !x.deleted);
  if (!p) throw err('NOT_FOUND', 'problem not found');
  return p;
}

function setProblemStatus(p: ProblemRow, status: A.ProblemStatus) {
  p.status = status;
  p.updated_at = nowIso();
  const finished = ['solved', 'solved_with_help', 'gave_up', 'revisit'].includes(status);
  p.day_key = finished ? today() : null;
  if (finished) {
    const a = db.attempts.find((x) => x.problem_id === p.id && !x.ended_at);
    if (a) endAttempt(a, nowIso());
    applyProblemToReview(p);
  }
}

function autoRoadmap(conceptId: string) {
  for (const n of db.nodes)
    if (n.concept_ids.includes(conceptId) && n.status === 'not_started') {
      n.status = 'learning';
      n.updated_at = nowIso();
    }
}

function roadmapDto(r: Db['roadmaps'][number]): A.Roadmap {
  const nodes = db.nodes.filter((n) => n.roadmap_id === r.id);
  return { ...r, node_count: nodes.length, done_count: nodes.filter((n) => n.status === 'done').length };
}

function roadmapDetail(id: string): A.RoadmapDetail {
  const r = db.roadmaps.find((x) => x.id === id);
  if (!r) throw err('NOT_FOUND', 'roadmap not found');
  return {
    roadmap: roadmapDto(r),
    nodes: clone(db.nodes.filter((n) => n.roadmap_id === id).sort((a, b) => a.position - b.position)),
  };
}

function renumber(roadmapId: string, parentId: string | null) {
  db.nodes
    .filter((n) => n.roadmap_id === roadmapId && n.parent_id === parentId)
    .sort((a, b) => a.position - b.position)
    .forEach((n, i) => (n.position = i));
}

function letterDto(l: Db['letters'][number]): A.Letter {
  const can = today() >= l.open_after;
  return {
    id: l.id,
    written_at: l.written_at,
    open_after: l.open_after,
    opened_at: l.opened_at,
    can_open: can,
    body: l.opened_at ? l.body : null,
  };
}

function providerDto(p: ProviderRow): A.AiProvider {
  return {
    id: p.id,
    kind: p.kind,
    label: p.label,
    base_url: p.base_url,
    model: p.model,
    has_key: !!p.key,
    key_hint: p.key ? `••••${p.key.slice(-4)}` : null,
    is_default: p.is_default,
  };
}

function kindForPath(path: string): A.ResourceKind {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  return 'file';
}

function errorDto(e: ErrorRow): A.ErrorNote {
  const { deleted: _d, ...rest } = e;
  void _d;
  const concept = e.concept_id ? liveConcepts().find((c) => c.id === e.concept_id) : undefined;
  const problem = e.problem_id ? liveProblems().find((p) => p.id === e.problem_id) : undefined;
  return { ...rest, concept_name: concept?.name ?? null, problem_title: problem?.title ?? null };
}

function glossaryDto(g: GlossaryRow): A.GlossaryTerm {
  const { deleted: _d, ...rest } = g;
  void _d;
  return rest;
}

function cleanOpt(v: string | null | undefined, what: string, max: number): string | null {
  const s = v?.trim();
  if (!s) return null;
  if (s.length > max) throw err('VALIDATION', `${what} must be at most ${max} characters`);
  return s;
}

function dueWeek(day: string) {
  const start = weekStart(day);
  return weekdayIndex(day) >= 4 ? start : addDays(start, -7);
}

function weekDay(day: string): A.WeekDay {
  const mood = avg(dayMoods(day).map((m) => m.value));
  return {
    day_key: day,
    mood: mood == null ? null : Math.round(mood * 10) / 10,
    concepts: liveConcepts().filter((c) => c.learned_day_key === day).length,
    solved: liveProblems().filter((p) => p.day_key === day && (p.status === 'solved' || p.status === 'solved_with_help')).length,
  };
}

function weekReview(start: string): A.WeekReview {
  const end = addDays(start, 6);
  const t = today();
  const days = dayRange(start, end);
  const inWeek = (d: string | null) => !!d && d >= start && d <= end;
  const probs = liveProblems().filter((p) => !p.flagged_bad && inWeek(p.day_key));
  let hardest: A.WeekDay | null = null;
  for (const d of days) {
    const w = weekDay(d);
    if (w.mood != null && w.mood <= 3 && (!hardest || w.mood < (hardest.mood ?? 99))) hardest = w;
  }
  let after: A.WeekDay | null = null;
  if (hardest) {
    const from = addDays(hardest.day_key, 1);
    const to = [addDays(hardest.day_key, 14), t].sort()[0];
    const next = from <= to ? dayRange(from, to).find(hasActivity) : undefined;
    after = next ? weekDay(next) : null;
  }
  const saved = db.weekly[start];
  const now = Date.now();
  return {
    week_start: start,
    week_end: end,
    is_past: end < t,
    focused_seconds: liveSessions()
      .filter((s) => inWeek(s.day_key))
      .reduce((acc, s) => acc + elapsedSeconds(s, now), 0),
    days_logged: days.filter(hasActivity).length,
    concepts: liveConcepts()
      .filter((c) => inWeek(c.learned_day_key))
      .sort((x, y) => x.learned_day_key.localeCompare(y.learned_day_key) || x.created_at.localeCompare(y.created_at))
      .map((c) => ({ id: c.id, name: c.name })),
    solved_alone: probs.filter((p) => p.status === 'solved').length,
    solved_with_help: probs.filter((p) => p.status === 'solved_with_help').length,
    attempted: probs.filter((p) => p.status === 'gave_up' || p.status === 'revisit' || p.status === 'in_progress').length,
    errors_logged: db.errorNotes.filter((e) => !e.deleted && inWeek(e.day_key)).length,
    hardest_day: hardest,
    after_hardest: after,
    clicked: saved?.clicked ?? null,
    fuzzy: saved?.fuzzy ?? null,
    focus: saved?.focus ?? null,
    saved_at: saved?.updated_at ?? null,
  };
}

function hintPrompt(id: string): string {
  const p = getProblem(id);
  const lang = db.languages.find((l) => l.id === p.language_id) ?? primaryLanguage();
  if (!lang) throw err('VALIDATION', 'Add a language first');
  const st = p.statement;
  const parts: string[] = [];
  if (st) {
    if (st.statement) parts.push(st.statement);
    if (st.input_format) parts.push(`Input: ${st.input_format}`);
    if (st.output_format) parts.push(`Output: ${st.output_format}`);
    if (st.constraints) parts.push(`Constraints: ${st.constraints}`);
    st.samples.forEach((s, i) =>
      parts.push(`Sample ${i + 1} input:\n${s.input.trimEnd()}\nSample ${i + 1} output:\n${s.output.trimEnd()}`),
    );
  }
  return buildHintPrompt({
    language: lang.name,
    journey_day: journeyDay(),
    title: p.title,
    link: p.url,
    statement: parts.join('\n'),
    attempt: p.solution_text,
    concepts: liveConcepts(lang.id)
      .sort((x, y) => y.learned_day_key.localeCompare(x.learned_day_key))
      .slice(0, 40)
      .map((c) => c.name),
  });
}

let generateAbort: (() => void) | null = null;

const handlers: Record<A.CommandName, Handler> = {
  app_state: () => appState(),
  settings_get: () => clone(db.settings),
  settings_update: (a) => {
    db.settings = { ...db.settings, ...arg<Partial<A.AppSettings>>(a, 'patch') };
    return clone(db.settings);
  },
  profile_get: () => (db.profile ? clone(db.profile) : null),
  profile_update: (a) => {
    if (!db.profile) throw err('NOT_FOUND', 'profile not found');
    db.profile = { ...db.profile, ...arg<A.ProfileUpdate>(a, 'input'), updated_at: nowIso() };
    return clone(db.profile);
  },
  onboarding_complete: (a) => {
    const input = arg<A.OnboardingInput>(a, 'input');
    if (!input.display_name.trim()) throw err('VALIDATION', 'Name is required.');
    const t = nowIso();
    db.profile = {
      id: uid(),
      display_name: input.display_name.trim(),
      daily_goal_min: input.daily_goal_min,
      day_boundary: input.day_boundary,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      journey_start: dayKeyFor(new Date(), input.day_boundary),
      created_at: t,
      updated_at: t,
    };
    for (const name of input.languages) {
      if (!db.languages.some((l) => l.name.toLowerCase() === name.toLowerCase()))
        db.languages.push({
          id: uid(),
          name,
          is_primary: name === input.primary_language,
          is_active: true,
          created_at: t,
          updated_at: t,
        });
    }
    if (!db.languages.some((l) => l.is_primary) && db.languages[0]) db.languages[0].is_primary = true;
    if (input.letter?.trim())
      db.letters.push({ id: uid(), body: input.letter, written_at: t, open_after: addDays(today(), 30), opened_at: null });
    db.settings.onboarding_done = true;
    return appState();
  },

  language_list: () => clone(db.languages),
  language_add: (a) => {
    const name = arg<string>(a, 'name').trim();
    if (!name) throw err('VALIDATION', 'Name is required.');
    if (db.languages.some((l) => l.name.toLowerCase() === name.toLowerCase()))
      throw err('CONFLICT', `${name} is already in your list.`);
    const l: A.Language = {
      id: uid(),
      name,
      is_primary: db.languages.length === 0,
      is_active: true,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    db.languages.push(l);
    return clone(l);
  },
  language_update: (a) => {
    const l = db.languages.find((x) => x.id === a.id);
    if (!l) throw err('NOT_FOUND', 'language not found');
    if (a.name != null) l.name = String(a.name);
    if (a.is_active != null) l.is_active = Boolean(a.is_active);
    l.updated_at = nowIso();
    return clone(l);
  },
  language_set_primary: (a) => {
    for (const l of db.languages) l.is_primary = l.id === a.id;
    return clone(db.languages);
  },

  session_start: (a) => {
    startSession((a.language_id as string | null) ?? null);
    return activeState();
  },
  session_pause: () => {
    const s = requireSession();
    if (!s.paused_at) s.paused_at = nowIso();
    const at = db.attempts.find((x) => !x.ended_at);
    if (at && !at.paused_at) at.paused_at = nowIso();
    return activeState();
  },
  session_resume: () => {
    const s = requireSession();
    if (s.paused_at) {
      s.paused_seconds += Math.round((Date.now() - Date.parse(s.paused_at)) / 1000);
      s.paused_at = null;
    }
    db.heartbeat = nowIso();
    return activeState();
  },
  session_end: (a) => {
    const s = requireSession();
    const endAt = (a.ended_at as string | null) ?? nowIso();
    const el = elapsedSeconds({ ...s, ended_at: endAt }, Date.parse(endAt));
    if (el > 8 * 3600 && !a.confirm_long) return { needs_confirmation: true, elapsed_seconds: el, state: activeState() };
    endSession(s, endAt);
    return { needs_confirmation: false, elapsed_seconds: el, state: activeState() };
  },
  session_active: () => activeState(),
  session_resolve_stale: (a) => {
    const s = requireSession();
    if (a.action === 'end') endSession(s, (a.ended_at as string | null) ?? db.heartbeat ?? nowIso());
    db.heartbeat = nowIso();
    return activeState();
  },
  session_list: (a) => liveSessions(String(a.day_key)).map(sessionDto),
  session_update: (a) => {
    const s = db.sessions.find((x) => x.id === a.id && !x.deleted);
    if (!s) throw err('NOT_FOUND', 'session not found');
    if (a.started_at) s.started_at = String(a.started_at);
    if (a.ended_at) s.ended_at = String(a.ended_at);
    if (a.language_id !== undefined) s.language_id = (a.language_id as string | null) ?? null;
    if (a.note !== undefined) s.note = (a.note as string | null) ?? null;
    if (Date.parse(s.ended_at ?? nowIso()) < Date.parse(s.started_at))
      throw err('VALIDATION', 'A session must end after it starts.');
    return sessionDto(s);
  },
  session_delete: (a) => {
    const s = db.sessions.find((x) => x.id === a.id);
    if (s) s.deleted = true;
    return null;
  },

  concept_category_list: () => clone(db.categories),
  concept_category_add: (a) => {
    const name = String(a.name).trim();
    const existing = db.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (existing) return clone(existing);
    const c = { id: uid(), name };
    db.categories.push(c);
    return c;
  },
  concept_add: (a) => {
    const input = arg<A.ConceptInput>(a, 'input');
    const name = input.name.trim();
    if (!name || name.length > 60) throw err('VALIDATION', 'Concept name must be 1–60 characters.');
    const dup = db.concepts.find(
      (c) => !c.deleted && c.language_id === input.language_id && c.name.toLowerCase() === name.toLowerCase(),
    );
    if (dup) throw err('CONFLICT', `You already have “${dup.name}”.`);
    const t = nowIso();
    const c: ConceptRow = {
      id: uid(),
      language_id: input.language_id,
      name,
      category_id: input.category_id ?? null,
      note: input.note ?? null,
      example_code: blank(input.example_code),
      example_output: blank(input.example_output),
      source_resource_id: input.source_resource_id ?? null,
      learned_day_key: input.day_key ?? today(),
      deleted: false,
      created_at: t,
      updated_at: t,
    };
    db.concepts.push(c);
    db.review.push({ concept_id: c.id, stage: 0, due_day_key: addDays(c.learned_day_key, 1), last_result: null });
    autoRoadmap(c.id);
    return conceptDto(c);
  },
  concept_update: (a) => {
    const input = arg<A.ConceptUpdate>(a, 'input');
    const c = db.concepts.find((x) => x.id === input.id && !x.deleted);
    if (!c) throw err('NOT_FOUND', 'concept not found');
    if (input.name !== undefined) c.name = input.name.trim();
    if (input.category_id !== undefined) c.category_id = input.category_id;
    if (input.note !== undefined) c.note = input.note;
    if (input.source_resource_id !== undefined) c.source_resource_id = input.source_resource_id;
    if (input.example_code !== undefined) c.example_code = blank(input.example_code);
    if (input.example_output !== undefined) c.example_output = blank(input.example_output);
    c.updated_at = nowIso();
    return conceptDto(c);
  },
  concept_delete: (a) => {
    const c = db.concepts.find((x) => x.id === a.id);
    if (c) c.deleted = true;
    return null;
  },
  concept_search: (a) => {
    const prefix = String(a.prefix ?? '').toLowerCase().trim();
    const lang = a.language_id as string | null;
    return liveConcepts(lang)
      .filter((c) => c.name.toLowerCase().includes(prefix))
      .sort((x, y) => Number(!x.name.toLowerCase().startsWith(prefix)) - Number(!y.name.toLowerCase().startsWith(prefix)))
      .slice(0, 8)
      .map(conceptDto);
  },
  concept_list: (a) => {
    const range = a.range as A.DayRange | null;
    return liveConcepts(a.language_id as string | null)
      .filter((c) => !range || (c.learned_day_key >= range.from && c.learned_day_key <= range.to))
      .sort((x, y) => y.learned_day_key.localeCompare(x.learned_day_key) || x.name.localeCompare(y.name))
      .map(conceptDto);
  },

  problem_add: (a) => {
    const input = arg<A.ProblemInput>(a, 'input');
    if (!input.title.trim()) throw err('VALIDATION', 'Title is required.');
    const t = nowIso();
    const p: ProblemRow = {
      id: uid(),
      language_id: input.language_id ?? primaryLanguage()?.id ?? null,
      title: input.title.trim(),
      url: input.url || null,
      origin: 'manual',
      generated_set_id: null,
      difficulty: input.difficulty ?? null,
      status: 'queued',
      feeling_tag_id: input.feeling_tag_id ?? null,
      statement: null,
      solution_text: input.solution_text || null,
      solution_path: input.solution_path || null,
      hint_revealed: false,
      answer_revealed: false,
      flagged_bad: false,
      day_key: null,
      created_day_key: today(),
      concept_ids: [...input.concept_ids],
      created_at: t,
      updated_at: t,
      deleted: false,
    };
    db.problems.push(p);
    setProblemStatus(p, input.status);
    return problemDto(p);
  },
  problem_update: (a) => {
    const input = arg<A.ProblemUpdate>(a, 'input');
    const p = getProblem(input.id);
    const { id: _id, ...patch } = input;
    void _id;
    Object.assign(p, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    p.updated_at = nowIso();
    return problemDto(p);
  },
  problem_get: (a) => problemDto(getProblem(String(a.id))),
  problem_delete: (a) => {
    getProblem(String(a.id)).deleted = true;
    return null;
  },
  problem_set_status: (a) => {
    const p = getProblem(String(a.id));
    setProblemStatus(p, a.status as A.ProblemStatus);
    return problemDto(p);
  },
  problem_reveal: (a) => {
    const p = getProblem(String(a.id));
    if (a.what === 'hint') p.hint_revealed = true;
    else {
      p.answer_revealed = true;
      if (!['solved', 'solved_with_help', 'gave_up'].includes(p.status)) setProblemStatus(p, 'solved_with_help');
    }
    return problemDto(p);
  },
  problem_flag_bad: (a) => {
    const p = getProblem(String(a.id));
    p.flagged_bad = Boolean(a.flagged);
    return problemDto(p);
  },
  problem_list: (a) => {
    const f = arg<A.ProblemFilter>(a, 'filter') ?? {};
    let list = f.day_key ? dayProblems(f.day_key) : liveProblems(f.language_id);
    if (f.status?.length) list = list.filter((p) => f.status!.includes(p.status));
    if (f.origin) list = list.filter((p) => p.origin === f.origin);
    if (f.generated_set_id) list = list.filter((p) => p.generated_set_id === f.generated_set_id);
    if (!f.include_flagged) list = list.filter((p) => !p.flagged_bad);
    list = [...list].sort((x, y) => y.created_at.localeCompare(x.created_at));
    return list.slice(0, f.limit ?? 500).map(problemDto);
  },

  attempt_start: (a) => {
    const p = getProblem(String(a.problem_id));
    const s = startSession(p.language_id);
    const running = db.attempts.find((x) => !x.ended_at);
    if (running) {
      if (running.problem_id === p.id) return activeState();
      endAttempt(running, nowIso());
    }
    if (s.paused_at) {
      s.paused_seconds += Math.round((Date.now() - Date.parse(s.paused_at)) / 1000);
      s.paused_at = null;
    }
    db.attempts.push({
      id: uid(),
      problem_id: p.id,
      session_id: s.id,
      started_at: nowIso(),
      ended_at: null,
      paused_seconds: 0,
      paused_at: null,
      day_key: today(),
    });
    if (p.status === 'queued' || p.status === 'revisit') {
      p.status = 'in_progress';
      p.day_key = null;
    }
    return activeState();
  },
  attempt_pause: () => {
    const at = db.attempts.find((x) => !x.ended_at);
    if (at && !at.paused_at) at.paused_at = nowIso();
    return activeState();
  },
  attempt_resume: () => {
    const at = db.attempts.find((x) => !x.ended_at);
    if (at?.paused_at) {
      at.paused_seconds += Math.round((Date.now() - Date.parse(at.paused_at)) / 1000);
      at.paused_at = null;
    }
    const s = db.sessions.find((x) => !x.ended_at && !x.deleted);
    if (s?.paused_at) {
      s.paused_seconds += Math.round((Date.now() - Date.parse(s.paused_at)) / 1000);
      s.paused_at = null;
    }
    return activeState();
  },
  attempt_end: () => {
    const at = db.attempts.find((x) => !x.ended_at);
    if (at) endAttempt(at, nowIso());
    return activeState();
  },

  mood_checkin: (a) => {
    const value = Number(a.value);
    if (!(value >= 1 && value <= 5)) throw err('VALIDATION', 'Mood must be 1–5.');
    const m: A.MoodCheckin = {
      id: uid(),
      value,
      kind: a.kind as A.MoodKind,
      session_id: (a.session_id as string | null) ?? null,
      at: nowIso(),
      day_key: today(),
    };
    db.moods.push(m);
    return { checkin: m, insights: evaluate('mood_logged', value) };
  },
  mood_history: (a) => {
    const r = arg<A.DayRange>(a, 'range');
    return db.moods.filter((m) => m.day_key >= r.from && m.day_key <= r.to);
  },

  diary_save: (a) => {
    const input = arg<A.DiarySaveInput>(a, 'input');
    if (input.body.length > 10_000) throw err('VALIDATION', 'Diary entries can be up to 10,000 characters.');
    let d = db.diaries.find((x) => x.day_key === input.day_key);
    const t = nowIso();
    if (!d) {
      d = { id: uid(), day_key: input.day_key, body: '', links: [], feeling_tag_ids: [], created_at: t, updated_at: t };
      db.diaries.push(d);
    }
    const dismissed = (d as DiaryRow & { dismissed?: string[] }).dismissed ?? [];
    d.body = input.body;
    d.feeling_tag_ids = [...input.feeling_tag_ids];
    const links: DiaryRow['links'] = input.concept_ids.map((concept_id) => ({ concept_id, source: 'user_tag' }));
    for (const id of keywordLinks(input.body))
      if (!links.some((l) => l.concept_id === id) && !dismissed.includes(id)) links.push({ concept_id: id, source: 'keyword' });
    d.links = links;
    d.updated_at = t;
    return diaryDto(d);
  },
  diary_get: (a) => {
    const d = db.diaries.find((x) => x.day_key === a.day_key);
    return d ? diaryDto(d) : null;
  },
  diary_dismiss_link: (a) => {
    const d = db.diaries.find((x) => x.id === a.diary_id);
    if (!d) throw err('NOT_FOUND', 'diary not found');
    d.links = d.links.filter((l) => l.concept_id !== a.concept_id);
    const ext = d as DiaryRow & { dismissed?: string[] };
    ext.dismissed = [...(ext.dismissed ?? []), String(a.concept_id)];
    return diaryDto(d);
  },
  diary_ai_suggest_links: async (a) => {
    if (!db.settings.allow_diary_to_ai)
      throw err('VALIDATION', 'Sending diary text to AI is turned off in Settings → AI models.');
    const d = db.diaries.find((x) => x.day_key === a.day_key);
    if (!d) throw err('NOT_FOUND', 'diary not found');
    await new Promise((r) => setTimeout(r, 600));
    // Pretend-model: link concepts whose first word appears anywhere in the text.
    const text = d.body.toLowerCase();
    const dismissed = (d as DiaryRow & { dismissed?: string[] }).dismissed ?? [];
    for (const c of liveConcepts()) {
      const word = c.name.toLowerCase().split(/[\s(/-]/)[0];
      if (word.length >= 3 && text.includes(word) && !d.links.some((l) => l.concept_id === c.id) && !dismissed.includes(c.id))
        d.links.push({ concept_id: c.id, source: 'ai' });
    }
    d.updated_at = nowIso();
    return diaryDto(d);
  },
  feeling_tag_list: () => clone(db.feelings),
  feeling_tag_add: (a) => {
    const name = String(a.name).trim();
    if (!name) throw err('VALIDATION', 'Name is required.');
    const existing = db.feelings.find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (existing) return clone(existing);
    const f: A.FeelingTag = { id: uid(), name, valence: a.valence as -1 | 0 | 1, is_builtin: false };
    db.feelings.push(f);
    return f;
  },

  day_get: (a) => dayView(String(a.day_key)),
  day_close: (a) => {
    const day = String(a.day_key);
    const selfU = (a.self_usefulness as number | null | undefined) ?? db.summaries[day]?.self_usefulness ?? null;
    const summary = daySummary(day, selfU);
    db.summaries[day] = summary;
    const calc = calcFor(day);
    return {
      summary,
      comparison: selfU != null ? compare(selfU, calc, summaryText(calc)) : null,
      insights: evaluate('day_closed'),
    };
  },
  day_calc_usefulness: (a) => calcFor(String(a.day_key)),
  day_set_self_usefulness: (a) => {
    const day = String(a.day_key);
    const value = Math.max(0, Math.min(100, Math.round(Number(a.value))));
    db.summaries[day] = { ...(db.summaries[day] ?? daySummary(day, null)), self_usefulness: value };
    return dayView(day);
  },

  stats_overview: (a) => {
    const lang = a.language_id as string | null;
    const t = today();
    const now = Date.now();
    const secsIn = (from: string, to: string) =>
      liveSessions(undefined, lang)
        .filter((s) => s.day_key >= from && s.day_key <= to)
        .reduce((acc, s) => acc + elapsedSeconds(s, now), 0);
    const solved = liveProblems(lang).filter((p) => !p.flagged_bad && (p.status === 'solved' || p.status === 'solved_with_help'));
    const times = solved.map((p) => problemSeconds(p.id)).filter((x) => x > 0);
    const st = streaks();
    return {
      total_seconds: liveSessions(undefined, lang).reduce((acc, s) => acc + elapsedSeconds(s, now), 0),
      week_seconds: secsIn(addDays(t, -6), t),
      prev_week_seconds: secsIn(addDays(t, -13), addDays(t, -7)),
      concepts_total: liveConcepts(lang).length,
      concepts_due: db.review.filter((r) => r.due_day_key <= t && liveConcepts(lang).some((c) => c.id === r.concept_id)).length,
      problems_solved: solved.length,
      problems_solved_alone: solved.filter((p) => p.status === 'solved').length,
      problems_solved_with_help: solved.filter((p) => p.status === 'solved_with_help').length,
      avg_solve_seconds: times.length ? Math.round(avg(times)!) : null,
      current_streak: st.current,
      best_streak: st.best,
      streak_rest_days: st.rest_days,
      journey_day: journeyDay(),
      days_logged: dayRange(db.profile?.journey_start ?? t, t).filter(hasActivity).length,
      last_active_day:
        dayRange(db.profile?.journey_start ?? t, addDays(t, -1))
          .filter(hasActivity)
          .pop() ?? null,
    } satisfies A.StatsOverview;
  },
  stats_series: (a) => {
    const metric = a.metric as A.SeriesMetric;
    const pts = dailyPoints(arg<A.DayRange>(a, 'range'), a.language_id as string | null);
    const pick: Record<A.SeriesMetric, (p: A.DailyPoint) => number | null> = {
      focused_minutes: (p) => p.minutes,
      usefulness: (p) => p.usefulness,
      mood_avg: (p) => p.mood_avg,
      mood_before: (p) => p.mood_before,
      mood_after: (p) => p.mood_after,
      concepts: (p) => p.concepts,
      problems_solved: (p) => p.solved,
      problems_attempted: (p) => p.attempted,
    };
    return pts.map((p) => ({ day_key: p.day_key, value: pick[metric](p) }));
  },
  stats_daily: (a) => dailyPoints(arg<A.DayRange>(a, 'range'), a.language_id as string | null),
  stats_heatmap: (a) =>
    dailyPoints(arg<A.DayRange>(a, 'range')).map((p) => ({ day_key: p.day_key, minutes: p.minutes, bucket: heatBucket(p.minutes) })),
  stats_charts: (a) => {
    const range = arg<A.DayRange>(a, 'range');
    const pts = dailyPoints(range, a.language_id as string | null);
    const weeks = new Map<string, { b: number[]; a: number[] }>();
    for (const p of pts) {
      const w = weekStart(p.day_key);
      const e = weeks.get(w) ?? { b: [], a: [] };
      if (p.mood_before != null) e.b.push(p.mood_before);
      if (p.mood_after != null) e.a.push(p.mood_after);
      weeks.set(w, e);
    }
    const byWeekday = Array.from({ length: 7 }, () => [] as number[]);
    for (const p of pts) if (p.usefulness != null) byWeekday[weekdayIndex(p.day_key)].push(p.usefulness);
    const speed = new Map<string, number[]>();
    for (const p of liveProblems()) {
      if (!p.day_key || p.day_key < range.from || p.day_key > range.to || !p.difficulty) continue;
      if (p.status !== 'solved' && p.status !== 'solved_with_help') continue;
      const secs = problemSeconds(p.id);
      if (!secs) continue;
      const k = `${weekStart(p.day_key)}|${p.difficulty}`;
      speed.set(k, [...(speed.get(k) ?? []), secs / 60]);
    }
    const feelMap = new Map<string, Record<string, number>>();
    const bump = (cid: string, fid: string | null) => {
      const f = db.feelings.find((x) => x.id === fid);
      if (!f) return;
      const rec = feelMap.get(cid) ?? {};
      rec[f.name] = (rec[f.name] ?? 0) + 1;
      feelMap.set(cid, rec);
    };
    for (const p of liveProblems()) for (const cid of p.concept_ids) bump(cid, p.feeling_tag_id);
    for (const d of db.diaries) for (const l of d.links) for (const fid of d.feeling_tag_ids) bump(l.concept_id, fid);
    return {
      mood_before_after_weekly: [...weeks.entries()]
        .map(([week_start, e]) => ({ week_start, before: round1(avg(e.b)), after: round1(avg(e.a)) }))
        .filter((w) => w.before != null || w.after != null),
      usefulness_by_hour: hourBuckets(range.from, range.to).map((h) => ({ ...h, avg: Math.round(h.avg) })),
      usefulness_by_weekday: byWeekday
        .map((xs, weekday) => ({ weekday, avg: Math.round(avg(xs) ?? 0), days: xs.length }))
        .filter((w) => w.days > 0),
      speed_by_difficulty: [...speed.entries()]
        .map(([k, xs]) => {
          const [week_start, level] = k.split('|');
          return { week_start, level: Number(level), avg_minutes: Math.round(avg(xs)!), count: xs.length };
        })
        .sort((x, y) => x.week_start.localeCompare(y.week_start)),
      feelings_per_concept: [...feelMap.entries()]
        .map(([concept_id, counts]) => ({
          concept_id,
          concept: db.concepts.find((c) => c.id === concept_id)?.name ?? '?',
          counts,
        }))
        .sort((x, y) => sumVals(y.counts) - sumVals(x.counts))
        .slice(0, 10),
      time_vs_attempts: pts
        .filter((p) => p.minutes > 0)
        .map((p) => ({ day_key: p.day_key, minutes: p.minutes, attempted: p.attempted + p.solved })),
    } satisfies A.InsightCharts;
  },

  insights_evaluate: (a) => evaluate(a.trigger as A.InsightTrigger),
  insights_list: (a) =>
    db.insights
      .filter((i) => (a.include_dismissed ? true : !i.dismissed_at) && db.rulePrefs[i.rule_id] !== false)
      .sort((x, y) => y.created_at.localeCompare(x.created_at) || y.priority - x.priority)
      .map((i) => clone(i)),
  insight_dismiss: (a) => {
    const i = db.insights.find((x) => x.id === a.id);
    if (i) {
      i.dismissed_at = nowIso();
      if (a.disable_rule) db.rulePrefs[i.rule_id] = false;
    }
    return null;
  },
  insight_mark_seen: (a) => {
    for (const id of arg<string[]>(a, 'ids')) {
      const i = db.insights.find((x) => x.id === id);
      if (i && !i.seen_at) i.seen_at = nowIso();
    }
    return null;
  },
  insight_rule_toggle: (a) => {
    db.rulePrefs[String(a.rule_id)] = Boolean(a.enabled);
    return RULE_IDS.map((rule_id) => ({ rule_id, enabled: db.rulePrefs[rule_id] !== false }));
  },
  insight_rule_prefs: () => RULE_IDS.map((rule_id) => ({ rule_id, enabled: db.rulePrefs[rule_id] !== false })),

  review_due: (a) => {
    const t = today();
    return db.review
      .filter((r) => r.due_day_key <= t)
      .map(reviewDto)
      .filter((r): r is A.ReviewItem => !!r)
      .sort((x, y) => y.negative_feelings - x.negative_feelings || x.due_day_key.localeCompare(y.due_day_key))
      .slice(0, Number(a.limit ?? 5));
  },
  review_record: (a) => {
    const id = String(a.concept_id);
    const r = db.review.find((x) => x.concept_id === id);
    const stage = r?.stage ?? 0;
    const result = a.result as A.ReviewResult;
    const next = result === 'easy' ? stage + 2 : result === 'ok' ? stage + 1 : result === 'hard' ? stage - 1 : stage;
    if (result === 'skipped') {
      const row = r ?? { concept_id: id, stage: 0, due_day_key: today(), last_result: null };
      row.due_day_key = addDays(today(), 1);
      row.last_result = 'skipped';
      if (!r) db.review.push(row);
    } else scheduleReview(id, next, result);
    return reviewDto(db.review.find((x) => x.concept_id === id)!)!;
  },

  practice_build_prompt: (a) => buildPrompt(arg<A.PracticeConfig>(a, 'config')),
  practice_generate: async (a) => {
    const cfg = arg<A.PracticeConfig>(a, 'config');
    const provider = db.providers.find((p) => p.id === cfg.provider_id) ?? db.providers.find((p) => p.is_default);
    if (!provider) throw err('AI_PROVIDER', 'No AI model is configured. Add one in Settings → AI models.');
    const { prompt } = buildPrompt(cfg);
    await new Promise<void>((resolve, reject) => {
      const id = setTimeout(resolve, 1800);
      generateAbort = () => {
        clearTimeout(id);
        reject(err('CANCELLED', 'Generation cancelled.'));
      };
    });
    generateAbort = null;
    const raw = fakeAiResponse(cfg);
    return {
      prompt,
      raw_text: raw,
      preview: validateResponse(raw, conceptNames(cfg.concept_ids), cfg.difficulty),
      provider: provider.kind,
      model: provider.model,
    } satisfies A.GenerateResult;
  },
  practice_cancel: () => {
    generateAbort?.();
    return null;
  },
  practice_validate_response: (a) => {
    const cfg = arg<A.PracticeConfig>(a, 'config');
    return validateResponse(String(a.raw_text), conceptNames(cfg.concept_ids), cfg.difficulty);
  },
  practice_import_response: (a) => {
    const input = arg<A.ImportInput>(a, 'input');
    const preview = validateResponse(input.raw_text, conceptNames(input.config.concept_ids), input.config.difficulty);
    if (!preview.ok) throw err(preview.error_code === 'INVALID_JSON' ? 'INVALID_JSON' : 'VALIDATION', preview.errors.join('; '));
    const set: SetRow = { id: uid(), mode: input.mode, provider: input.provider ?? null, model: input.model ?? null };
    db.sets.push(set);
    const t = nowIso();
    const created = preview.problems.map((g) => {
      const ids = liveConcepts(input.config.language_id)
        .filter((c) => g.concepts.some((n) => n.toLowerCase().includes(c.name.toLowerCase()) || c.name.toLowerCase().includes(n.toLowerCase())))
        .map((c) => c.id);
      const p: ProblemRow = {
        id: uid(),
        language_id: input.config.language_id,
        title: g.title,
        url: null,
        origin: 'generated',
        generated_set_id: set.id,
        difficulty: g.difficulty,
        status: 'queued',
        feeling_tag_id: null,
        statement: g,
        solution_text: null,
        solution_path: null,
        hint_revealed: false,
        answer_revealed: false,
        flagged_bad: false,
        day_key: null,
        created_day_key: today(),
        concept_ids: ids.length ? ids : [...input.config.concept_ids].slice(0, 1),
        created_at: t,
        updated_at: t,
        deleted: false,
      };
      db.problems.push(p);
      return problemDto(p);
    });
    return { set_id: set.id, problems: created, warnings: preview.warnings };
  },
  practice_fixup_prompt: (a) => {
    const raw = String(a.raw_text);
    const v = validateResponse(raw, [], 1);
    return buildFixupPrompt(raw, v.errors);
  },
  problem_hint_prompt: (a) => hintPrompt(String(a.id)),
  practice_reliability: () => {
    const rows = new Map<string, A.ProviderReliability>();
    for (const p of liveProblems()) {
      const set = db.sets.find((s) => s.id === p.generated_set_id);
      if (!set) continue;
      const provider = set.mode === 'copy_prompt' ? 'copy-prompt' : (set.provider ?? '?');
      const model = set.model ?? 'chatbot';
      const key = `${provider}|${model}`;
      const r = rows.get(key) ?? { provider, model, total: 0, flagged: 0 };
      r.total++;
      if (p.flagged_bad) r.flagged++;
      rows.set(key, r);
    }
    return [...rows.values()];
  },

  ai_provider_list: () => db.providers.map(providerDto),
  ai_provider_save: (a) => {
    const input = arg<A.AiProviderInput>(a, 'input');
    let p = db.providers.find((x) => x.id === input.id);
    if (!p) {
      p = { id: uid(), kind: input.kind, label: input.label, base_url: null, model: input.model, key: null, is_default: false };
      db.providers.push(p);
    }
    Object.assign(p, { kind: input.kind, label: input.label, base_url: input.base_url ?? null, model: input.model });
    if (input.is_default || db.providers.length === 1) for (const x of db.providers) x.is_default = x.id === p.id;
    return providerDto(p);
  },
  ai_provider_delete: (a) => {
    db.providers = db.providers.filter((p) => p.id !== a.id);
    return null;
  },
  ai_provider_set_key: (a) => {
    const p = db.providers.find((x) => x.id === a.id);
    if (!p) throw err('NOT_FOUND', 'provider not found');
    p.key = String(a.key);
    return providerDto(p);
  },
  ai_provider_test: async (a) => {
    const p = db.providers.find((x) => x.id === a.id);
    if (!p) throw err('NOT_FOUND', 'provider not found');
    await new Promise((r) => setTimeout(r, 400));
    if (p.kind !== 'ollama' && !p.key) return { ok: false, message: 'No API key set.', latency_ms: 0 };
    return { ok: true, message: `Mock: ${p.model} answered.`, latency_ms: 412 };
  },

  report_data: (a) => reportData(arg<A.ReportInput>(a, 'input')),
  report_save_pdf: (a) => {
    const name = String(a.suggested_name);
    browserDownload(name, new Uint8Array(arg<number[]>(a, 'bytes')), 'application/pdf');
    return `Downloads/${name}`;
  },
  report_markdown: (a) => reportMarkdown(arg<A.ReportInput>(a, 'input')),
  report_save_markdown: (a) => {
    const name = String(a.suggested_name);
    browserDownload(name, reportMarkdown(arg<A.ReportInput>(a, 'input')), 'text/markdown');
    return `Downloads/${name}`;
  },

  resource_add_link: (a) => {
    const url = String(a.url).trim();
    if (!/^https?:\/\//.test(url)) throw err('VALIDATION', 'Links must start with http:// or https://');
    const r: ResourceRow = {
      id: uid(),
      kind: 'link',
      title: (a.title as string | null)?.trim() || url.replace(/^https?:\/\//, '').split('/')[0],
      url,
      file_path: null,
      abs_path: null,
      body: null,
      sha256: null,
      language_id: (a.language_id as string | null) ?? null,
      concept_ids: (a.concept_ids as string[] | undefined) ?? [],
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted: false,
    };
    db.resources.push(r);
    return clone(r);
  },
  resource_add_file: (a) => {
    const path = String(a.path);
    const name = path.split(/[\\/]/).pop() ?? path;
    if (/\.(exe|msi|bat|cmd|sh|app|dmg)$/i.test(name)) throw err('VALIDATION', 'Executable files cannot be added.');
    const r: ResourceRow = {
      id: uid(),
      kind: kindForPath(name),
      title: (a.title as string | null)?.trim() || name,
      url: null,
      file_path: `2026/09/${name}`,
      abs_path: path,
      body: null,
      sha256: null,
      language_id: (a.language_id as string | null) ?? null,
      concept_ids: (a.concept_ids as string[] | undefined) ?? [],
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted: false,
    };
    db.resources.push(r);
    return clone(r);
  },
  resource_add_note: (a) => {
    const r: ResourceRow = {
      id: uid(),
      kind: 'note',
      title: String(a.title).trim() || 'Untitled note',
      url: null,
      file_path: null,
      abs_path: null,
      body: String(a.body),
      sha256: null,
      language_id: (a.language_id as string | null) ?? null,
      concept_ids: (a.concept_ids as string[] | undefined) ?? [],
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted: false,
    };
    db.resources.push(r);
    return clone(r);
  },
  resource_update: (a) => {
    const r = db.resources.find((x) => x.id === a.id && !x.deleted);
    if (!r) throw err('NOT_FOUND', 'resource not found');
    for (const k of ['title', 'url', 'body', 'language_id'] as const) if (a[k] != null) (r as any)[k] = a[k];
    if (a.concept_ids) r.concept_ids = a.concept_ids as string[];
    r.updated_at = nowIso();
    return clone(r);
  },
  resource_delete: (a) => {
    const r = db.resources.find((x) => x.id === a.id);
    if (r) r.deleted = true;
    return null;
  },
  resource_list: (a) => {
    const f = arg<A.ResourceFilter>(a, 'filter') ?? {};
    const q = f.query?.toLowerCase().trim();
    return db.resources
      .filter(
        (r) =>
          !r.deleted &&
          (!f.kind || r.kind === f.kind) &&
          (!f.concept_id || r.concept_ids.includes(f.concept_id)) &&
          (!f.language_id || r.language_id === f.language_id) &&
          (!q || r.title.toLowerCase().includes(q) || (r.body ?? '').toLowerCase().includes(q)),
      )
      .sort((x, y) => y.created_at.localeCompare(x.created_at))
      .map(({ deleted: _d, ...r }) => {
        void _d;
        return clone(r);
      });
  },
  resource_open: (a) => {
    const r = db.resources.find((x) => x.id === a.id);
    if (r?.url && typeof window !== 'undefined') window.open(r.url, '_blank', 'noopener');
    return null;
  },
  resource_fetch_title: (a) => {
    const url = String(a.url);
    return url.replace(/^https?:\/\/(www\.)?/, '').split(/[/?#]/)[0].replace(/\.\w+$/, '').replace(/^\w/, (c) => c.toUpperCase());
  },
  library_open_folder: () => null,

  roadmap_create: (a) => {
    const r = { id: uid(), title: String(a.title).trim() || 'Untitled roadmap', source: 'custom' as const, source_ref: null, created_at: nowIso(), updated_at: nowIso() };
    db.roadmaps.push(r);
    return roadmapDto(r);
  },
  roadmap_list: () => db.roadmaps.map(roadmapDto),
  roadmap_get: (a) => roadmapDetail(String(a.id)),
  roadmap_update: (a) => {
    const r = db.roadmaps.find((x) => x.id === a.id);
    if (!r) throw err('NOT_FOUND', 'roadmap not found');
    r.title = String(a.title);
    r.updated_at = nowIso();
    return roadmapDto(r);
  },
  roadmap_delete: (a) => {
    db.roadmaps = db.roadmaps.filter((r) => r.id !== a.id);
    db.nodes = db.nodes.filter((n) => n.roadmap_id !== a.id);
    return null;
  },
  roadmap_node_upsert: (a) => {
    const input = arg<A.RoadmapNodeInput>(a, 'input');
    let n = input.id ? db.nodes.find((x) => x.id === input.id) : undefined;
    if (!n) {
      const siblings = db.nodes.filter((x) => x.roadmap_id === input.roadmap_id && x.parent_id === (input.parent_id ?? null));
      n = {
        id: uid(),
        roadmap_id: input.roadmap_id,
        parent_id: input.parent_id ?? null,
        title: input.title,
        position: siblings.length,
        status: 'not_started',
        concept_ids: [],
        updated_at: nowIso(),
      };
      db.nodes.push(n);
    }
    n.title = input.title;
    if (input.concept_ids) {
      n.concept_ids = input.concept_ids;
      if (n.status === 'not_started' && n.concept_ids.some((id) => liveConcepts().some((c) => c.id === id)))
        n.status = 'learning';
    }
    n.updated_at = nowIso();
    return clone(n);
  },
  roadmap_node_delete: (a) => {
    const n = db.nodes.find((x) => x.id === a.id);
    if (!n) return null;
    const kill = new Set([n.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of db.nodes)
        if (x.parent_id && kill.has(x.parent_id) && !kill.has(x.id)) {
          kill.add(x.id);
          grew = true;
        }
    }
    db.nodes = db.nodes.filter((x) => !kill.has(x.id));
    renumber(n.roadmap_id, n.parent_id);
    return null;
  },
  roadmap_node_move: (a) => {
    const n = db.nodes.find((x) => x.id === a.id);
    if (!n) throw err('NOT_FOUND', 'node not found');
    const parent = (a.parent_id as string | null) ?? null;
    let p = parent;
    while (p) {
      if (p === n.id) throw err('VALIDATION', 'A node cannot be moved inside itself.');
      p = db.nodes.find((x) => x.id === p)?.parent_id ?? null;
    }
    const oldParent = n.parent_id;
    n.parent_id = parent;
    const siblings = db.nodes
      .filter((x) => x.roadmap_id === n.roadmap_id && x.parent_id === parent && x.id !== n.id)
      .sort((x, y) => x.position - y.position);
    siblings.splice(Math.max(0, Math.min(Number(a.position), siblings.length)), 0, n);
    siblings.forEach((x, i) => (x.position = i));
    if (oldParent !== parent) renumber(n.roadmap_id, oldParent);
    return roadmapDetail(n.roadmap_id);
  },
  roadmap_node_set_status: (a) => {
    const n = db.nodes.find((x) => x.id === a.id);
    if (!n) throw err('NOT_FOUND', 'node not found');
    n.status = a.status as A.NodeStatus;
    n.updated_at = nowIso();
    return clone(n);
  },
  roadmap_import_json: (a) => {
    const r = {
      id: uid(),
      title: `Imported: ${String(a.path).split(/[\\/]/).pop()}`,
      source: 'import' as const,
      source_ref: String(a.path),
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    db.roadmaps.push(r);
    ['Basics', 'Control flow', 'Data structures'].forEach((title, i) =>
      db.nodes.push({ id: uid(), roadmap_id: r.id, parent_id: null, title, position: i, status: 'not_started', concept_ids: [], updated_at: nowIso() }),
    );
    return roadmapDto(r);
  },
  roadmap_export_json: () => null,

  letter_write: (a) => {
    const body = String(a.body).trim();
    if (!body) throw err('VALIDATION', 'A letter needs some words.');
    const l = { id: uid(), body, written_at: nowIso(), open_after: String(a.open_after), opened_at: null };
    db.letters.push(l);
    return letterDto(l);
  },
  letter_list: () => [...db.letters].sort((x, y) => y.written_at.localeCompare(x.written_at)).map(letterDto),
  letter_open: (a) => {
    const l = db.letters.find((x) => x.id === a.id);
    if (!l) throw err('NOT_FOUND', 'letter not found');
    if (today() < l.open_after) throw err('CONFLICT', `This letter stays sealed until ${l.open_after}.`);
    l.opened_at ??= nowIso();
    return letterDto(l);
  },

  search: (a) => {
    const q = String(a.query).trim();
    const f = arg<A.SearchFilters>(a, 'filters') ?? {};
    const kinds = new Set(f.kinds?.length ? f.kinds : ['diary', 'concept', 'problem', 'resource', 'error']);
    const inRange = (d: string | null) => (!f.from || (d ?? '') >= f.from) && (!f.to || (d ?? '') <= f.to);
    const ql = q.toLowerCase();
    const hits: A.SearchHit[] = [];
    if (kinds.has('diary'))
      for (const d of db.diaries)
        if (d.body.toLowerCase().includes(ql) && inRange(d.day_key))
          hits.push({ kind: 'diary', ref_id: d.id, day_key: d.day_key, title: `Diary`, snippet: snippet(d.body, q) });
    if (kinds.has('concept'))
      for (const c of liveConcepts()) {
        const text = `${c.name} ${c.note ?? ''}`;
        if (text.toLowerCase().includes(ql) && inRange(c.learned_day_key))
          hits.push({ kind: 'concept', ref_id: c.id, day_key: c.learned_day_key, title: c.name, snippet: snippet(text, q) });
      }
    if (kinds.has('problem'))
      for (const p of liveProblems())
        if (p.title.toLowerCase().includes(ql) && inRange(p.day_key ?? p.created_day_key))
          hits.push({ kind: 'problem', ref_id: p.id, day_key: p.day_key ?? p.created_day_key, title: p.title, snippet: snippet(p.title, q) });
    if (kinds.has('resource'))
      for (const r of db.resources)
        if (!r.deleted && r.title.toLowerCase().includes(ql))
          hits.push({ kind: 'resource', ref_id: r.id, day_key: null, title: r.title, snippet: snippet(r.title, q) });
    if (kinds.has('error'))
      for (const e of db.errorNotes) {
        const text = [e.message, e.cause, e.fix].filter(Boolean).join('\n');
        if (!e.deleted && text.toLowerCase().includes(ql) && inRange(e.day_key))
          hits.push({ kind: 'error', ref_id: e.id, day_key: e.day_key, title: e.message.split('\n')[0], snippet: snippet(text, q) });
      }
    return hits.sort((x, y) => (y.day_key ?? '').localeCompare(x.day_key ?? '')).slice(0, f.limit ?? 50);
  },

  error_note_list: (a) => {
    const lang = a.language_id as string | null | undefined;
    return db.errorNotes
      .filter((e) => !e.deleted && (!lang || !e.language_id || e.language_id === lang))
      .sort((x, y) => y.last_hit_at.localeCompare(x.last_hit_at))
      .map(errorDto);
  },
  error_note_save: (a) => {
    const input = arg<A.ErrorNoteInput>(a, 'input');
    const message = input.message.trim();
    if (!message) throw err('VALIDATION', "Error message can't be empty");
    if (message.length > 4000) throw err('VALIDATION', 'Error message must be at most 4000 characters');
    const fields = {
      language_id: input.language_id ?? null,
      message,
      cause: cleanOpt(input.cause, 'Cause', 2000),
      fix: cleanOpt(input.fix, 'Fix', 4000),
      concept_id: input.concept_id ?? null,
      problem_id: input.problem_id ?? null,
    };
    const t = nowIso();
    if (input.id) {
      const e = db.errorNotes.find((x) => x.id === input.id && !x.deleted);
      if (!e) throw err('NOT_FOUND', 'error note not found');
      Object.assign(e, fields, { updated_at: t });
      return errorDto(e);
    }
    const e: ErrorRow = { id: uid(), ...fields, hits: 1, last_hit_at: t, day_key: today(), created_at: t, updated_at: t, deleted: false };
    db.errorNotes.push(e);
    return errorDto(e);
  },
  error_note_hit: (a) => {
    const e = db.errorNotes.find((x) => x.id === a.id && !x.deleted);
    if (!e) throw err('NOT_FOUND', 'error note not found');
    e.hits++;
    e.last_hit_at = e.updated_at = nowIso();
    return errorDto(e);
  },
  error_note_delete: (a) => {
    const e = db.errorNotes.find((x) => x.id === a.id && !x.deleted);
    if (!e) throw err('NOT_FOUND', 'error note not found');
    e.deleted = true;
    return null;
  },
  glossary_list: () =>
    db.glossary
      .filter((g) => !g.deleted)
      .sort((x, y) => x.term.toLowerCase().localeCompare(y.term.toLowerCase()))
      .map(glossaryDto),
  glossary_save: (a) => {
    const input = arg<A.GlossaryInput>(a, 'input');
    const term = input.term.trim();
    const definition = input.definition.trim();
    if (!term) throw err('VALIDATION', "Term can't be empty");
    if (!definition) throw err('VALIDATION', "Definition can't be empty");
    const lang = input.language_id ?? null;
    const clash = db.glossary.find(
      (g) => !g.deleted && g.id !== input.id && g.term.toLowerCase() === term.toLowerCase() && g.language_id === lang,
    );
    if (clash) throw err('CONFLICT', `"${term}" is already in your glossary`);
    const t = nowIso();
    if (input.id) {
      const g = db.glossary.find((x) => x.id === input.id && !x.deleted);
      if (!g) throw err('NOT_FOUND', 'glossary term not found');
      Object.assign(g, { term, definition, language_id: lang, is_builtin: false, updated_at: t });
      return glossaryDto(g);
    }
    const g: GlossaryRow = { id: uid(), term, definition, language_id: lang, is_builtin: false, updated_at: t, deleted: false };
    db.glossary.push(g);
    return glossaryDto(g);
  },
  glossary_delete: (a) => {
    const g = db.glossary.find((x) => x.id === a.id && !x.deleted);
    if (!g) throw err('NOT_FOUND', 'glossary term not found');
    g.deleted = true;
    return null;
  },
  week_review_get: (a) => weekReview(a.week_start ? weekStart(String(a.week_start)) : dueWeek(today())),
  week_review_save: (a) => {
    const input = arg<A.WeekReviewInput>(a, 'input');
    if (weekStart(input.week_start) !== input.week_start) throw err('VALIDATION', 'week_start must be a Monday');
    db.weekly[input.week_start] = {
      clicked: cleanOpt(input.clicked, 'What clicked', 2000),
      fuzzy: cleanOpt(input.fuzzy, "What's still fuzzy", 2000),
      focus: cleanOpt(input.focus, 'Focus', 200),
      updated_at: nowIso(),
    };
    return weekReview(input.week_start);
  },
  week_focus: () => {
    const from = addDays(weekStart(today()), -7);
    const hit = Object.entries(db.weekly)
      .filter(([w, r]) => w >= from && r.focus)
      .sort(([x], [y]) => y.localeCompare(x))[0];
    return hit ? { week_start: hit[0], focus: hit[1].focus! } : null;
  },
  getting_started: () =>
    ({
      has_session: liveSessions().length > 0,
      has_concept: liveConcepts().length > 0,
      has_example: liveConcepts().some((c) => !!c.example_code),
      has_problem: liveProblems().some((p) => p.origin === 'manual') || db.attempts.length > 0,
      has_diary: db.diaries.some((d) => d.body.trim() !== ''),
      has_practice: db.sets.length > 0,
    }) satisfies A.GettingStarted,

  backup_now: () => {
    const b: A.BackupInfo = { id: `app-${Date.now()}-manual.db`, kind: 'manual', created_at: nowIso(), size_bytes: 412_000 };
    db.backups.unshift(b);
    return b;
  },
  backup_list: () => clone(db.backups),
  backup_restore: () => null,
  export_all_json: (a) => {
    browserDownload('hello-world-export.json', JSON.stringify(db, null, 2), 'application/json');
    return String(a.path);
  },
  delete_all_data: (a) => {
    if (a.confirm_phrase !== 'DELETE') throw err('VALIDATION', 'Type DELETE to confirm.');
    db = emptyDb();
    return null;
  },
  data_dir_move: (a) => ({ ...dataInfo(), data_dir: String(a.path) }),
  data_info: () => dataInfo(),
  diagnostics_export: (a) => String(a.path),
};

function sumVals(r: Record<string, number>) {
  return Object.values(r).reduce((a, b) => a + b, 0);
}

function dataInfo(): A.DataInfo {
  return {
    data_dir: '~/.local/share/app.helloworld.journal',
    db_path: '~/.local/share/app.helloworld.journal/app.db',
    library_dir: '~/.local/share/app.helloworld.journal/library',
    backups_dir: '~/.local/share/app.helloworld.journal/backups',
    logs_dir: '~/.local/share/app.helloworld.journal/logs',
    db_size_bytes: 412_000,
    schema_version: 1,
    app_version: '1.0.0-mock',
  };
}

// ───────────────────────── test fixture ─────────────────────────
function seed() {
  let r = 42;
  const rnd = () => ((r = (r * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const nowMs = Date.now();
  const t0 = today();
  const start = addDays(t0, -29);
  const at = (day: string, hh: number, mm = 0) => {
    const [y, m, d] = day.split('-').map(Number);
    return iso(new Date(y, m - 1, d, hh, mm));
  };
  db.profile = {
    id: uid(),
    display_name: 'Sam',
    daily_goal_min: 60,
    day_boundary: '04:00',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    journey_start: start,
    created_at: at(start, 9),
    updated_at: at(start, 9),
  };
  const py: A.Language = { id: uid(), name: 'Python', is_primary: true, is_active: true, created_at: at(start, 9), updated_at: at(start, 9) };
  const js: A.Language = { id: uid(), name: 'JavaScript', is_primary: false, is_active: true, created_at: at(start, 9), updated_at: at(start, 9) };
  db.languages = [py, js];
  db.settings.onboarding_done = true;

  const conceptPlan: [string, string, string][] = [
    ['print()', 'Basics', 'Shows stuff on the screen.'],
    ['variables', 'Variables', 'A name that points at a value.'],
    ['input()', 'Basics', 'Reads text the user types. Always a string!'],
    ['if/else', 'Conditionals', 'Pick a path based on a True/False check.'],
    ['for loops', 'Loops', 'Repeat something for each item.'],
    ['range()', 'Loops', 'Makes numbers to loop over; stops before the end.'],
    ['while loops', 'Loops', 'Repeat while a condition is true. Watch for infinite loops.'],
    ['lists', 'Lists', 'An ordered bag of values.'],
    ['list slicing', 'Lists', 'lst[a:b] takes a piece; b is not included.'],
    ['strings', 'Strings', 'Text. Immutable.'],
    ['f-strings', 'Strings', 'f"{name}" puts values inside text.'],
    ['functions', 'Functions', 'Name a chunk of code so you can reuse it.'],
    ['return values', 'Functions', 'What a function hands back.'],
    ['dictionaries', 'Dictionaries', 'Look things up by key.'],
    ['list comprehensions', 'Lists', '[x*2 for x in xs] — a loop in one line.'],
    ['split and join', 'Strings', 'Break text into a list and glue it back.'],
    ['try/except', 'Errors', 'Catch errors so the program keeps going.'],
    ['classes', 'Classes', 'A blueprint for objects.'],
  ];
  const cat = (n: string) => db.categories.find((c) => c.name === n)?.id ?? null;
  const conceptsByName = new Map<string, ConceptRow>();
  let ci = 0;
  const feelingsNeg = ['ft-stuck', 'ft-confused', 'ft-frustrated'];
  const feelingsPos = ['ft-proud', 'ft-aha', 'ft-excited'];
  const titles = ['FizzBuzz', 'Sum of digits', 'Reverse a string', 'Count vowels', 'Max of a list', 'Even numbers', 'Temperature converter', 'Word counter', 'Multiplication table', 'Palindrome check', 'Grade calculator', 'Shopping list', 'Guess the number', 'Remove duplicates', 'Second largest'];
  let ti = 0;

  const skip = new Set([4, 12, 13, 20]);
  for (let i = 0; i < 29; i++) {
    const day = addDays(start, i);
    if (skip.has(i)) continue;
    const hour = 8 + Math.floor(rnd() * 12);
    const mins = 25 + Math.floor(rnd() * 80);
    const sid = uid();
    const sStart = at(day, hour, Math.floor(rnd() * 50));
    db.sessions.push({
      id: sid,
      language_id: i > 22 && i % 3 === 0 ? js.id : py.id,
      started_at: sStart,
      ended_at: iso(Date.parse(sStart) + mins * 60_000 + 300_000),
      paused_seconds: 300,
      paused_at: null,
      day_key: day,
      note: null,
      deleted: false,
    });
    const before = i === 6 ? 2 : 2 + Math.floor(rnd() * 3);
    const after = i === 6 ? 2 : Math.min(5, before + Math.floor(rnd() * 2) + (rnd() > 0.7 ? 1 : 0));
    db.moods.push({ id: uid(), value: before, kind: 'session_start', session_id: sid, at: sStart, day_key: day });
    db.moods.push({ id: uid(), value: after, kind: 'session_end', session_id: sid, at: iso(Date.parse(sStart) + mins * 60_000), day_key: day });

    const nConcepts = ci < conceptPlan.length ? (i < 18 ? 1 + Math.floor(rnd() * 2) : Math.floor(rnd() * 2)) : 0;
    const todays: ConceptRow[] = [];
    for (let k = 0; k < nConcepts && ci < conceptPlan.length; k++, ci++) {
      const [name, category, note] = conceptPlan[ci];
      const c: ConceptRow = {
        id: uid(),
        language_id: py.id,
        name,
        category_id: cat(category),
        note,
        example_code: null,
        example_output: null,
        source_resource_id: null,
        learned_day_key: day,
        deleted: false,
        created_at: at(day, hour + 1),
        updated_at: at(day, hour + 1),
      };
      db.concepts.push(c);
      conceptsByName.set(name, c);
      todays.push(c);
      const stage = Math.min(4, Math.floor((29 - i) / 6));
      db.review.push({ concept_id: c.id, stage, due_day_key: addDays(day, REVIEW_INTERVALS[stage]), last_result: null });
    }

    const known = [...conceptsByName.values()];
    const nProblems = i < 2 ? 0 : i === 9 || i === 11 ? 2 : Math.floor(rnd() * 3);
    for (let k = 0; k < nProblems && known.length; k++) {
      const loops = conceptsByName.get('for loops');
      const useLoops = (i === 9 || i === 11) && loops;
      const concept = useLoops ? loops! : known[Math.floor(rnd() * known.length)];
      const statusRoll = rnd();
      const status: A.ProblemStatus = useLoops ? 'solved' : statusRoll < 0.6 ? 'solved' : statusRoll < 0.78 ? 'solved_with_help' : statusRoll < 0.9 ? 'revisit' : 'gave_up';
      const pid = uid();
      const minutes = 8 + Math.floor(rnd() * 30);
      const aStart = iso(Date.parse(sStart) + (10 + k * 20) * 60_000);
      db.problems.push({
        id: pid,
        language_id: py.id,
        title: titles[ti++ % titles.length] + (ti > titles.length ? ` ${Math.ceil(ti / titles.length)}` : ''),
        url: rnd() > 0.6 ? 'https://www.hackerrank.com/challenges/python-loops' : null,
        origin: 'manual',
        generated_set_id: null,
        difficulty: 1 + Math.floor(rnd() * 3),
        status,
        feeling_tag_id: status === 'solved' ? feelingsPos[Math.floor(rnd() * 3)] : feelingsNeg[Math.floor(rnd() * 3)],
        statement: null,
        solution_text: null,
        solution_path: null,
        hint_revealed: false,
        answer_revealed: false,
        flagged_bad: false,
        day_key: day,
        created_day_key: day,
        concept_ids: [concept.id],
        created_at: aStart,
        updated_at: aStart,
        deleted: false,
      });
      db.attempts.push({ id: uid(), problem_id: pid, session_id: sid, started_at: aStart, ended_at: iso(Date.parse(aStart) + minutes * 60_000), paused_seconds: 0, paused_at: null, day_key: day });
    }

    if (i === 6) {
      const loops = conceptsByName.get('for loops');
      db.diaries.push({
        id: uid(),
        day_key: day,
        body: "I don't get for loops at all. Everyone online makes it look easy and I just stare at range() and feel dumb. Maybe coding isn't for me.",
        links: loops ? [{ concept_id: loops.id, source: 'user_tag' }] : [],
        feeling_tag_ids: ['ft-stuck', 'ft-loser'],
        created_at: at(day, 22),
        updated_at: at(day, 22),
      });
    } else if (rnd() > 0.45) {
      const lines = [
        'Good session. Things are starting to connect.',
        'Slow day but I showed up. That counts.',
        'Finally understood why my loop never ended. Aha!',
        'Watched a long tutorial. Should try more problems myself.',
        'Dictionaries are like a phone book. That helped.',
        'Felt tired, did a short session anyway.',
      ];
      db.diaries.push({
        id: uid(),
        day_key: day,
        body: lines[Math.floor(rnd() * lines.length)],
        links: todays.slice(0, 1).map((c) => ({ concept_id: c.id, source: 'user_tag' as const })),
        feeling_tag_ids: rnd() > 0.5 ? [feelingsPos[Math.floor(rnd() * 3)]] : [],
        created_at: at(day, 21),
        updated_at: at(day, 21),
      });
    }
    db.summaries[day] = daySummary(day, Math.max(0, Math.min(100, calcFor(day).score + Math.round((rnd() - 0.6) * 50))));
    db.summaries[day].closed_at = at(day, 23);
  }

  // Letters, resources, a roadmap, a provider.
  db.letters.push({ id: uid(), body: 'I want to build a little app that helps my mum track her plants. Remember that when it gets hard.', written_at: at(start, 9), open_after: addDays(start, 30), opened_at: null });
  db.letters.push({ id: uid(), body: 'Two weeks in. You kept going. Proud of you.', written_at: at(addDays(start, 2), 21), open_after: addDays(t0, -1), opened_at: null });
  const loops = conceptsByName.get('for loops');
  db.resources.push(
    { id: uid(), kind: 'link', title: 'Python docs — for statements', url: 'https://docs.python.org/3/tutorial/controlflow.html', file_path: null, abs_path: null, body: null, sha256: null, language_id: py.id, concept_ids: loops ? [loops.id] : [], created_at: at(addDays(start, 5), 10), updated_at: at(addDays(start, 5), 10), deleted: false },
    { id: uid(), kind: 'note', title: 'range() cheat sheet', url: null, file_path: null, abs_path: null, body: 'range(5) → 0..4\nrange(2, 5) → 2, 3, 4\nrange(0, 10, 2) → evens', sha256: null, language_id: py.id, concept_ids: [], created_at: at(addDays(start, 7), 10), updated_at: at(addDays(start, 7), 10), deleted: false },
    { id: uid(), kind: 'pdf', title: 'Think Python (chapter 7).pdf', url: null, file_path: '2026/09/think-python-ch7.pdf', abs_path: null, body: null, sha256: 'ab12', language_id: py.id, concept_ids: [], created_at: at(addDays(start, 9), 10), updated_at: at(addDays(start, 9), 10), deleted: false },
  );
  const rm = { id: uid(), title: 'Python basics', source: 'custom' as const, source_ref: null, created_at: at(start, 10), updated_at: at(start, 10) };
  db.roadmaps.push(rm);
  const mk = (title: string, parent: string | null, pos: number, status: A.NodeStatus, cids: string[] = []) => {
    const n: A.RoadmapNode = { id: uid(), roadmap_id: rm.id, parent_id: parent, title, position: pos, status, concept_ids: cids, updated_at: at(start, 10) };
    db.nodes.push(n);
    return n;
  };
  const basics = mk('Syntax basics', null, 0, 'done');
  mk('Printing and input', basics.id, 0, 'done');
  mk('Variables and types', basics.id, 1, 'done');
  const flow = mk('Control flow', null, 1, 'learning');
  mk('Conditionals', flow.id, 0, 'done');
  mk('Loops', flow.id, 1, 'learning', loops ? [loops.id] : []);
  const data = mk('Data structures', null, 2, 'learning');
  mk('Lists', data.id, 0, 'learning');
  mk('Dictionaries', data.id, 1, 'not_started');
  mk('Sets', data.id, 2, 'not_started');
  mk('Object-oriented programming', null, 3, 'not_started');
  db.providers.push({ id: uid(), kind: 'ollama', label: 'Local Llama', base_url: 'http://localhost:11434', model: 'llama3.1:8b', key: null, is_default: true });
  db.backups.push({ id: `app-${t0.replace(/-/g, '')}-090000-auto.db`, kind: 'auto', created_at: at(t0, 9), size_bytes: 398_000 });
  const errorAt = (daysAgo: number) => at(addDays(t0, -daysAgo), 19);
  const listy = db.concepts.find((c) => c.name.toLowerCase().includes('list'));
  db.errorNotes.push(
    {
      id: uid(),
      language_id: py.id,
      message: 'IndexError: list index out of range',
      cause: 'My loop went one step past the end of the list.',
      fix: 'Loop over the items directly, or use range(len(items)).',
      concept_id: listy?.id ?? null,
      problem_id: null,
      hits: 2,
      last_hit_at: errorAt(3),
      day_key: addDays(t0, -9),
      created_at: errorAt(9),
      updated_at: errorAt(3),
      deleted: false,
    },
    {
      id: uid(),
      language_id: py.id,
      message: 'TypeError: can only concatenate str (not "int") to str',
      cause: 'I added a number to some text.',
      fix: 'Wrap the number in str(), or use an f-string.',
      concept_id: null,
      problem_id: null,
      hits: 1,
      last_hit_at: errorAt(16),
      day_key: addDays(t0, -16),
      created_at: errorAt(16),
      updated_at: errorAt(16),
      deleted: false,
    },
  );

  evaluate('day_closed');
  evaluate('app_opened');
  void nowMs;
}

let initialized = false;
function init() {
  if (initialized) return;
  initialized = true;
}

/** Reset for tests. */
export function resetMock(opts: { seeded: boolean }) {
  db = emptyDb();
  initialized = true;
  if (opts.seeded) seed();
}

export async function mockInvoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  init();
  const h = handlers[cmd as A.CommandName];
  if (!h) throw err('NOT_FOUND', `unknown command ${cmd}`);
  await new Promise((r) => setTimeout(r, 0));
  if (db.sessions.some((s) => !s.ended_at && !s.deleted)) db.heartbeat = nowIso();
  try {
    return clone(await h(args));
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e) throw e;
    throw err('INTERNAL', (e as Error).message);
  }
}
