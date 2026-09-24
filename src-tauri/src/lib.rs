//! Hello World — Rust core. Owns all data: SQLite, library files, backups,
//! keychain secrets and AI calls. The React UI talks to it only via commands.

pub mod commands;
pub mod db;
pub mod error;
pub mod paths;
pub mod secrets;
pub mod services;
pub mod state;
pub mod time;

use std::sync::OnceLock;
use std::time::Duration;

use chrono::{Timelike, Utc};
use serde_json::Value;
use tauri::{Emitter, Manager};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::EnvFilter;

use crate::services::{day, insights, profile, sessions, settings, stats};
use crate::state::AppState;

static LOG_GUARD: OnceLock<WorkerGuard> = OnceLock::new();

fn init_logging(dir: &std::path::Path, level: &str) {
    let _ = std::fs::create_dir_all(dir);
    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("hello-world")
        .filename_suffix("log")
        .max_log_files(7)
        .build(dir);
    let Ok(appender) = appender else { return };
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let filter = EnvFilter::try_new(format!("hello_world_lib={level},warn")).unwrap_or_else(|_| EnvFilter::new("info"));
    let ok = tracing_subscriber::fmt().with_writer(writer).with_ansi(false).with_env_filter(filter).try_init();
    if ok.is_ok() {
        let _ = LOG_GUARD.set(guard);
    }
}

/// Startup work: daily backup, day auto-close, app-open insights.
fn on_startup(state: &AppState) {
    let now = Utc::now();
    let p = state.paths();
    if let Err(e) = state.read(|c| db::backup::daily_if_needed(c, &p.backups)) {
        tracing::warn!(error = e.code(), "daily backup failed");
    }
    let r = state.write(|c| {
        if profile::get(c)?.is_none() {
            return Ok(());
        }
        for d in day::auto_close_past_days(c, now)? {
            insights::evaluate(c, insights::Trigger::DayClosed, Some(&d), None, now)?;
        }
        insights::on_app_opened(c, now)?;
        Ok(())
    });
    if let Err(e) = r {
        tracing::warn!(error = e.code(), "startup evaluation failed");
    }
}

const REMINDER_SENT_KEY: &str = "reminder_sent_day";

/// Every 60 s: timer heartbeat, day-boundary auto-close, and the optional daily reminder.
async fn background_loop(app: tauri::AppHandle) {
    let mut tick = tokio::time::interval(Duration::from_secs(60));
    let mut last_today: Option<String> = None;
    loop {
        tick.tick().await;
        let state = app.state::<AppState>();
        let now = Utc::now();
        let result = state.write(|c| {
            if !state.stale_pending() && sessions::running_session(c, now)?.is_some() {
                sessions::write_heartbeat(c, now)?;
            }
            if profile::get(c)?.is_none() {
                return Ok((None, false));
            }
            let today = profile::today(c, now)?;
            let mut day_changed = false;
            if last_today.as_deref() != Some(today.as_str()) {
                if last_today.is_some() {
                    for d in day::auto_close_past_days(c, now)? {
                        insights::evaluate(c, insights::Trigger::DayClosed, Some(&d), None, now)?;
                    }
                    day_changed = true;
                }
                last_today = Some(today.clone());
            }
            // Daily reminder: only if nothing is logged yet today.
            let s = settings::get_all(c)?;
            let mut remind = None;
            if let Some(t) = s.reminder_time.as_deref().and_then(|t| time::parse_boundary(t).ok()) {
                let clock = profile::clock(c)?;
                let local = now.with_timezone(&clock.tz);
                let sent = settings::get_str(c, REMINDER_SENT_KEY)?;
                let local_day = local.date_naive().to_string();
                let due = (local.hour(), local.minute()) >= (t.hour(), t.minute());
                if due && sent.as_deref() != Some(local_day.as_str()) {
                    settings::set_raw(c, REMINDER_SENT_KEY, &Value::String(local_day))?;
                    let logged = stats::day_agg(c, &today, now)?.has_activity();
                    if !logged && sessions::running_session(c, now)?.is_none() {
                        remind = Some(());
                    }
                }
            }
            Ok((remind, day_changed))
        });
        match result {
            Ok((remind, day_changed)) => {
                if remind.is_some() {
                    use tauri_plugin_notification::NotificationExt;
                    let _ = app
                        .notification()
                        .builder()
                        .title("Hello World")
                        .body("A few minutes today still count. What did you learn?")
                        .show();
                }
                if day_changed {
                    let _ = app.emit("day-changed", ());
                }
            }
            Err(e) => tracing::warn!(error = e.code(), "background tick failed"),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let base = app.path().app_data_dir()?;
            let paths = paths::resolve(&base);
            paths.ensure()?;
            let conn = db::open(&paths.db, &paths.backups)?;
            let level = settings::get_all(&conn).map(|s| s.log_level).unwrap_or_else(|_| "info".into());
            init_logging(&paths.logs, &level);
            tracing::info!(version = %app.package_info().version, "starting");
            let _ = app.asset_protocol_scope().allow_directory(&paths.library, true);
            let state = AppState::new(conn, paths, base, app.package_info().version.to_string())?;
            on_startup(&state);
            app.manage(state);
            tauri::async_runtime::spawn(background_loop(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::core::app_state,
            commands::core::settings_get,
            commands::core::settings_update,
            commands::core::profile_get,
            commands::core::profile_update,
            commands::core::onboarding_complete,
            commands::core::language_list,
            commands::core::language_add,
            commands::core::language_update,
            commands::core::language_set_primary,
            commands::core::session_start,
            commands::core::session_pause,
            commands::core::session_resume,
            commands::core::session_end,
            commands::core::session_active,
            commands::core::session_resolve_stale,
            commands::core::session_list,
            commands::core::session_update,
            commands::core::session_delete,
            commands::core::attempt_start,
            commands::core::attempt_pause,
            commands::core::attempt_resume,
            commands::core::attempt_end,
            commands::core::mood_checkin,
            commands::core::mood_history,
            commands::content::concept_category_list,
            commands::content::concept_category_add,
            commands::content::concept_add,
            commands::content::concept_update,
            commands::content::concept_delete,
            commands::content::concept_search,
            commands::content::concept_list,
            commands::content::problem_add,
            commands::content::problem_update,
            commands::content::problem_get,
            commands::content::problem_delete,
            commands::content::problem_set_status,
            commands::content::problem_reveal,
            commands::content::problem_flag_bad,
            commands::content::problem_list,
            commands::content::diary_save,
            commands::content::diary_get,
            commands::content::diary_dismiss_link,
            commands::content::feeling_tag_list,
            commands::content::feeling_tag_add,
            commands::content::day_get,
            commands::content::day_close,
            commands::content::day_calc_usefulness,
            commands::content::day_set_self_usefulness,
            commands::content::stats_overview,
            commands::content::stats_series,
            commands::content::stats_daily,
            commands::content::stats_heatmap,
            commands::content::stats_charts,
            commands::content::insights_evaluate,
            commands::content::insights_list,
            commands::content::insight_dismiss,
            commands::content::insight_mark_seen,
            commands::content::insight_rule_toggle,
            commands::content::insight_rule_prefs,
            commands::content::review_due,
            commands::content::review_record,
            commands::content::search,
            commands::content::letter_write,
            commands::content::letter_list,
            commands::content::letter_open,
            commands::practice::practice_build_prompt,
            commands::practice::practice_generate,
            commands::practice::practice_cancel,
            commands::practice::practice_validate_response,
            commands::practice::practice_import_response,
            commands::practice::practice_fixup_prompt,
            commands::practice::practice_reliability,
            commands::practice::diary_ai_suggest_links,
            commands::practice::ai_provider_list,
            commands::practice::ai_provider_save,
            commands::practice::ai_provider_delete,
            commands::practice::ai_provider_set_key,
            commands::practice::ai_provider_test,
            commands::files::report_data,
            commands::files::report_markdown,
            commands::files::report_save_pdf,
            commands::files::report_save_markdown,
            commands::files::resource_add_link,
            commands::files::resource_add_file,
            commands::files::resource_add_note,
            commands::files::resource_update,
            commands::files::resource_delete,
            commands::files::resource_list,
            commands::files::resource_open,
            commands::files::resource_fetch_title,
            commands::files::library_open_folder,
            commands::files::roadmap_create,
            commands::files::roadmap_list,
            commands::files::roadmap_get,
            commands::files::roadmap_update,
            commands::files::roadmap_delete,
            commands::files::roadmap_node_upsert,
            commands::files::roadmap_node_delete,
            commands::files::roadmap_node_move,
            commands::files::roadmap_node_set_status,
            commands::files::roadmap_import_json,
            commands::files::roadmap_export_json,
            commands::files::backup_now,
            commands::files::backup_list,
            commands::files::backup_restore,
            commands::files::export_all_json,
            commands::files::delete_all_data,
            commands::files::data_info,
            commands::files::data_dir_move,
            commands::files::diagnostics_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hello World");
}
