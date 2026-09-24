//! App bootstrap, settings, profile, languages and timers.

use chrono::Utc;
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::services::insights::{self, Insight};
use crate::services::mood::{self, MoodCheckin};
use crate::services::profile::{self, Language, OnboardingInput, Profile, ProfileUpdate};
use crate::services::sessions::{self, ActiveState, Session, SessionEndResult};
use crate::services::settings::{self, AppSettings};
use crate::state::AppState;
use crate::time::parse_ts;

#[derive(Debug, Serialize)]
pub struct AppSnapshot {
    pub onboarding_done: bool,
    pub profile: Option<Profile>,
    pub languages: Vec<Language>,
    pub settings: AppSettings,
    pub today: String,
    pub journey_day: i64,
    pub active: ActiveState,
    pub app_version: String,
    pub is_debug: bool,
}

fn snapshot(state: &AppState) -> AppResult<AppSnapshot> {
    let now = Utc::now();
    state.read(|c| {
        let today = profile::today(c, now)?;
        let settings = settings::get_all(c)?;
        let profile = profile::get(c)?;
        Ok(AppSnapshot {
            onboarding_done: settings.onboarding_done && profile.is_some(),
            journey_day: profile::journey_day(c, &today)?,
            profile,
            languages: profile::list_languages(c)?,
            settings,
            today,
            active: state.active(c, now)?,
            app_version: state.app_version.clone(),
            is_debug: cfg!(debug_assertions),
        })
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn app_state(state: State<'_, AppState>) -> AppResult<AppSnapshot> {
    snapshot(&state)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn settings_get(state: State<'_, AppState>) -> AppResult<AppSettings> {
    state.read(settings::get_all)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn settings_update(state: State<'_, AppState>, patch: Map<String, Value>) -> AppResult<AppSettings> {
    state.write(|c| settings::update(c, patch))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn profile_get(state: State<'_, AppState>) -> AppResult<Option<Profile>> {
    state.read(profile::get)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn profile_update(state: State<'_, AppState>, input: ProfileUpdate) -> AppResult<Profile> {
    state.write(|c| profile::update(c, input, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn onboarding_complete(state: State<'_, AppState>, input: OnboardingInput) -> AppResult<AppSnapshot> {
    state.write(|c| profile::onboarding_complete(c, input, Utc::now()))?;
    tracing::info!("onboarding complete");
    snapshot(&state)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn language_list(state: State<'_, AppState>) -> AppResult<Vec<Language>> {
    state.read(profile::list_languages)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn language_add(state: State<'_, AppState>, name: String) -> AppResult<Language> {
    state.write(|c| profile::add_language(c, &name, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn language_update(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    is_active: Option<bool>,
) -> AppResult<Language> {
    state.write(|c| profile::update_language(c, &id, name, is_active, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn language_set_primary(state: State<'_, AppState>, id: String) -> AppResult<Vec<Language>> {
    state.write(|c| profile::set_primary(c, &id, Utc::now()))
}

// ───────────────────────── Timers ─────────────────────────

fn timer_op(state: &AppState, f: impl FnOnce(&rusqlite::Connection, chrono::DateTime<Utc>) -> AppResult<()>) -> AppResult<ActiveState> {
    let now = Utc::now();
    state.write(|c| {
        f(c, now)?;
        state.active(c, now)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn session_start(state: State<'_, AppState>, language_id: Option<String>) -> AppResult<ActiveState> {
    if state.stale_pending() {
        return Err(AppError::Conflict("Resolve the session that was still running first.".into()));
    }
    timer_op(&state, |c, now| sessions::start(c, language_id, now).map(|_| ()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn session_pause(state: State<'_, AppState>) -> AppResult<ActiveState> {
    timer_op(&state, |c, now| sessions::pause(c, now).map(|_| ()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn session_resume(state: State<'_, AppState>) -> AppResult<ActiveState> {
    timer_op(&state, |c, now| sessions::resume(c, now).map(|_| ()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn session_end(
    state: State<'_, AppState>,
    ended_at: Option<String>,
    confirm_long: Option<bool>,
) -> AppResult<SessionEndResult> {
    let now = Utc::now();
    let end = ended_at.as_deref().map(parse_ts).transpose()?;
    state.write(|c| {
        let (needs, el) = sessions::end(c, end, confirm_long.unwrap_or(false), now)?;
        Ok(SessionEndResult { needs_confirmation: needs, elapsed_seconds: el, state: state.active(c, now)? })
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn session_active(state: State<'_, AppState>) -> AppResult<ActiveState> {
    state.read(|c| state.active(c, Utc::now()))
}

/// "Your session was still running. Keep it, or end it at the time you stopped?"
#[tauri::command(rename_all = "snake_case")]
pub async fn session_resolve_stale(
    state: State<'_, AppState>,
    action: String,
    ended_at: Option<String>,
) -> AppResult<ActiveState> {
    let now = Utc::now();
    let out = state.write(|c| {
        let stale = sessions::detect_stale(c, now)?;
        match action.as_str() {
            "keep" => sessions::write_heartbeat(c, now)?,
            "end" => {
                let end = match ended_at.as_deref() {
                    Some(t) => Some(parse_ts(t)?),
                    None => stale
                        .as_ref()
                        .and_then(|s| s.last_heartbeat.as_deref())
                        .and_then(|h| parse_ts(h).ok()),
                };
                if sessions::running_session(c, now)?.is_some() {
                    sessions::end(c, end, true, now)?;
                }
            }
            _ => return Err(AppError::validation("action must be 'keep' or 'end'")),
        }
        Ok(())
    });
    out?;
    state.set_stale_pending(false);
    state.read(|c| state.active(c, now))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn session_list(state: State<'_, AppState>, day_key: String) -> AppResult<Vec<Session>> {
    state.read(|c| sessions::list(c, &day_key, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn session_update(
    state: State<'_, AppState>,
    id: String,
    started_at: Option<String>,
    ended_at: Option<String>,
    language_id: Option<String>,
    note: Option<String>,
) -> AppResult<Session> {
    state.write(|c| sessions::update(c, &id, started_at, ended_at, language_id, note, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn session_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.write(|c| sessions::delete(c, &id, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn attempt_start(state: State<'_, AppState>, problem_id: String) -> AppResult<ActiveState> {
    if state.stale_pending() {
        return Err(AppError::Conflict("Resolve the session that was still running first.".into()));
    }
    timer_op(&state, |c, now| sessions::attempt_start(c, &problem_id, now).map(|_| ()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn attempt_pause(state: State<'_, AppState>) -> AppResult<ActiveState> {
    timer_op(&state, sessions::attempt_pause)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn attempt_resume(state: State<'_, AppState>) -> AppResult<ActiveState> {
    timer_op(&state, sessions::attempt_resume)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn attempt_end(state: State<'_, AppState>) -> AppResult<ActiveState> {
    timer_op(&state, sessions::attempt_end)
}

// ───────────────────────── Mood ─────────────────────────

#[derive(Debug, Serialize)]
pub struct MoodCheckinResult {
    pub checkin: MoodCheckin,
    pub insights: Vec<Insight>,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mood_checkin(
    state: State<'_, AppState>,
    value: i64,
    kind: String,
    session_id: Option<String>,
) -> AppResult<MoodCheckinResult> {
    let now = Utc::now();
    state.write(|c| {
        let checkin = mood::checkin(c, value, &kind, session_id, now)?;
        let insights = if value <= 2 {
            insights::evaluate(c, insights::Trigger::MoodLogged, None, Some(value), now)?
                .into_iter()
                .filter(|i| i.rule_id == "been_here_before")
                .collect()
        } else {
            vec![]
        };
        Ok(MoodCheckinResult { checkin, insights })
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mood_history(
    state: State<'_, AppState>,
    range: crate::services::concepts::DayRange,
) -> AppResult<Vec<MoodCheckin>> {
    state.read(|c| mood::history(c, &range))
}
