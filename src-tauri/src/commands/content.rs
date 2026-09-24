//! Concepts, problems, diary, day, stats, insights, review, search, letters.

use chrono::Utc;
use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::services::concepts::{self, Concept, ConceptCategory, ConceptInput, ConceptUpdate, DayRange};
use crate::services::day::{self, DaySummary, DayView};
use crate::services::diary::{self, DiaryEntry, DiarySaveInput, FeelingTag};
use crate::services::insights::{self, Insight, InsightRulePref, Trigger};
use crate::services::letters::{self, Letter};
use crate::services::problems::{self, Problem, ProblemFilter, ProblemInput, ProblemUpdate};
use crate::services::review::{self, ReviewItem};
use crate::services::score::{UsefulnessBreakdown, UsefulnessComparison};
use crate::services::search::{self, SearchFilters, SearchHit};
use crate::services::stats::{self, DailyPoint, HeatCell, InsightCharts, SeriesPoint, StatsOverview};
use crate::services::profile;
use crate::state::AppState;

// ───────────────────────── Concepts ─────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub async fn concept_category_list(state: State<'_, AppState>) -> AppResult<Vec<ConceptCategory>> {
    state.read(concepts::list_categories)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn concept_category_add(state: State<'_, AppState>, name: String) -> AppResult<ConceptCategory> {
    state.write(|c| concepts::add_category(c, &name))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn concept_add(state: State<'_, AppState>, input: ConceptInput) -> AppResult<Concept> {
    state.write(|c| concepts::add(c, input, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn concept_update(state: State<'_, AppState>, input: ConceptUpdate) -> AppResult<Concept> {
    state.write(|c| concepts::update(c, input, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn concept_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.write(|c| concepts::delete(c, &id, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn concept_search(
    state: State<'_, AppState>,
    prefix: String,
    language_id: Option<String>,
) -> AppResult<Vec<Concept>> {
    state.read(|c| concepts::search_prefix(c, &prefix, language_id.as_deref()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn concept_list(
    state: State<'_, AppState>,
    range: Option<DayRange>,
    language_id: Option<String>,
) -> AppResult<Vec<Concept>> {
    state.read(|c| concepts::list(c, range.as_ref(), language_id.as_deref()))
}

// ───────────────────────── Problems ─────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub async fn problem_add(state: State<'_, AppState>, input: ProblemInput) -> AppResult<Problem> {
    state.write(|c| problems::add(c, input, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn problem_update(state: State<'_, AppState>, input: ProblemUpdate) -> AppResult<Problem> {
    state.write(|c| problems::update(c, input, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn problem_get(state: State<'_, AppState>, id: String) -> AppResult<Problem> {
    state.read(|c| problems::get(c, &id, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn problem_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.write(|c| problems::delete(c, &id, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn problem_set_status(state: State<'_, AppState>, id: String, status: String) -> AppResult<Problem> {
    state.write(|c| problems::set_status(c, &id, &status, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn problem_reveal(state: State<'_, AppState>, id: String, what: String) -> AppResult<Problem> {
    state.write(|c| problems::reveal(c, &id, &what, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn problem_flag_bad(state: State<'_, AppState>, id: String, flagged: bool) -> AppResult<Problem> {
    state.write(|c| problems::flag_bad(c, &id, flagged, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn problem_list(state: State<'_, AppState>, filter: ProblemFilter) -> AppResult<Vec<Problem>> {
    state.read(|c| problems::list(c, &filter, Utc::now()))
}

// ───────────────────────── Diary / feelings ─────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub async fn diary_save(state: State<'_, AppState>, input: DiarySaveInput) -> AppResult<DiaryEntry> {
    state.write(|c| diary::save(c, input, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn diary_get(state: State<'_, AppState>, day_key: String) -> AppResult<Option<DiaryEntry>> {
    state.read(|c| diary::get(c, &day_key))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn diary_dismiss_link(
    state: State<'_, AppState>,
    diary_id: String,
    concept_id: String,
) -> AppResult<DiaryEntry> {
    state.write(|c| diary::dismiss_link(c, &diary_id, &concept_id))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn feeling_tag_list(state: State<'_, AppState>) -> AppResult<Vec<FeelingTag>> {
    state.read(diary::feeling_tags)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn feeling_tag_add(state: State<'_, AppState>, name: String, valence: i64) -> AppResult<FeelingTag> {
    state.write(|c| diary::add_feeling_tag(c, &name, valence))
}

// ───────────────────────── Day ─────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub async fn day_get(state: State<'_, AppState>, day_key: String) -> AppResult<DayView> {
    state.read(|c| day::get(c, &day_key, Utc::now()))
}

#[derive(Debug, Serialize)]
pub struct DayCloseResult {
    pub summary: DaySummary,
    pub comparison: Option<UsefulnessComparison>,
    pub insights: Vec<Insight>,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn day_close(
    state: State<'_, AppState>,
    day_key: String,
    self_usefulness: Option<i64>,
) -> AppResult<DayCloseResult> {
    let now = Utc::now();
    state.write(|c| {
        let (summary, comparison) = day::close(c, &day_key, self_usefulness, now)?;
        let insights = insights::evaluate(c, Trigger::DayClosed, Some(&day_key), None, now)?;
        tracing::info!("day closed");
        Ok(DayCloseResult { summary, comparison, insights })
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn day_calc_usefulness(state: State<'_, AppState>, day_key: String) -> AppResult<UsefulnessBreakdown> {
    state.read(|c| day::calc(c, &day_key, Utc::now()).map(|(_, b)| b))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn day_set_self_usefulness(state: State<'_, AppState>, day_key: String, value: i64) -> AppResult<DayView> {
    state.write(|c| day::set_self_usefulness(c, &day_key, value, Utc::now()))
}

// ───────────────────────── Stats ─────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub async fn stats_overview(state: State<'_, AppState>, language_id: Option<String>) -> AppResult<StatsOverview> {
    state.read(|c| stats::overview(c, language_id.as_deref(), Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn stats_series(
    state: State<'_, AppState>,
    metric: String,
    range: DayRange,
    language_id: Option<String>,
) -> AppResult<Vec<SeriesPoint>> {
    state.read(|c| stats::series(c, &metric, &range, language_id.as_deref(), Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn stats_daily(
    state: State<'_, AppState>,
    range: DayRange,
    language_id: Option<String>,
) -> AppResult<Vec<DailyPoint>> {
    state.read(|c| stats::daily(c, &range, language_id.as_deref(), Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn stats_heatmap(state: State<'_, AppState>, range: DayRange) -> AppResult<Vec<HeatCell>> {
    state.read(|c| stats::heatmap(c, &range, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn stats_charts(
    state: State<'_, AppState>,
    range: DayRange,
    language_id: Option<String>,
) -> AppResult<InsightCharts> {
    state.read(|c| stats::charts(c, &range, language_id.as_deref(), Utc::now()))
}

// ───────────────────────── Insights ─────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub async fn insights_evaluate(state: State<'_, AppState>, trigger: String) -> AppResult<Vec<Insight>> {
    let t = Trigger::parse(&trigger)?;
    let now = Utc::now();
    state.write(|c| match t {
        Trigger::AppOpened => insights::on_app_opened(c, now),
        Trigger::MoodLogged => Err(AppError::validation("mood_logged is evaluated by mood_checkin")),
        other => insights::evaluate(c, other, None, None, now),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn insights_list(state: State<'_, AppState>, include_dismissed: Option<bool>) -> AppResult<Vec<Insight>> {
    state.read(|c| insights::list(c, include_dismissed.unwrap_or(false)))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn insight_dismiss(state: State<'_, AppState>, id: String, disable_rule: Option<bool>) -> AppResult<()> {
    state.write(|c| insights::dismiss(c, &id, disable_rule.unwrap_or(false), Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn insight_mark_seen(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<()> {
    state.write(|c| insights::mark_seen(c, &ids, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn insight_rule_toggle(
    state: State<'_, AppState>,
    rule_id: String,
    enabled: bool,
) -> AppResult<Vec<InsightRulePref>> {
    state.write(|c| insights::toggle_rule(c, &rule_id, enabled))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn insight_rule_prefs(state: State<'_, AppState>) -> AppResult<Vec<InsightRulePref>> {
    state.read(insights::rule_prefs)
}

// ───────────────────────── Review ─────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub async fn review_due(state: State<'_, AppState>, limit: i64) -> AppResult<Vec<ReviewItem>> {
    state.read(|c| review::due(c, limit, &profile::today(c, Utc::now())?))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn review_record(state: State<'_, AppState>, concept_id: String, result: String) -> AppResult<ReviewItem> {
    let now = Utc::now();
    state.write(|c| review::record(c, &concept_id, &result, &profile::today(c, now)?, now))
}

// ───────────────────────── Search / letters ─────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub async fn search(state: State<'_, AppState>, query: String, filters: Option<SearchFilters>) -> AppResult<Vec<SearchHit>> {
    let f = filters.unwrap_or_default();
    state.read(|c| search::query(c, &query, &f))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn letter_write(state: State<'_, AppState>, body: String, open_after: String) -> AppResult<Letter> {
    let now = Utc::now();
    state.write(|c| letters::write(c, &body, &open_after, &profile::today(c, now)?, now))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn letter_list(state: State<'_, AppState>) -> AppResult<Vec<Letter>> {
    state.read(|c| letters::list(c, &profile::today(c, Utc::now())?))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn letter_open(state: State<'_, AppState>, id: String) -> AppResult<Letter> {
    let now = Utc::now();
    state.write(|c| letters::open(c, &id, &profile::today(c, now)?, now))
}
