//! Time handling (backend §2.3). `day_key` is the only place the day-boundary
//! logic lives; everything else calls it.

use chrono::{DateTime, Duration, NaiveDate, NaiveTime, SecondsFormat, TimeZone, Utc};
use chrono_tz::Tz;

use crate::error::{AppError, AppResult};

pub const DEFAULT_BOUNDARY: &str = "04:00";

/// UTC ISO-8601 text with second precision, e.g. `2026-09-24T14:30:00Z`.
pub fn fmt_ts(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub fn parse_ts(s: &str) -> AppResult<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .map_err(|_| AppError::validation(format!("invalid timestamp: {s}")))
}

pub fn parse_boundary(s: &str) -> AppResult<NaiveTime> {
    NaiveTime::parse_from_str(s, "%H:%M")
        .map_err(|_| AppError::validation(format!("invalid day boundary '{s}', expected HH:MM")))
}

pub fn parse_tz(s: &str) -> AppResult<Tz> {
    s.parse::<Tz>().map_err(|_| AppError::validation(format!("unknown timezone '{s}'")))
}

pub fn system_timezone() -> String {
    iana_time_zone::get_timezone()
        .ok()
        .filter(|z| z.parse::<Tz>().is_ok())
        .unwrap_or_else(|| "UTC".to_string())
}

/// The day a moment belongs to: local time minus the day boundary.
/// A session at 01:30 on the 25th with a 04:00 boundary belongs to the 24th.
pub fn day_key(ts_utc: DateTime<Utc>, tz: Tz, boundary: NaiveTime) -> String {
    let local = ts_utc.with_timezone(&tz).naive_local();
    let offset = boundary.signed_duration_since(NaiveTime::MIN);
    (local - offset).date().format("%Y-%m-%d").to_string()
}

pub fn parse_day(day: &str) -> AppResult<NaiveDate> {
    NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .map_err(|_| AppError::validation(format!("invalid day '{day}', expected YYYY-MM-DD")))
}

pub fn fmt_day(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

pub fn add_days(day: &str, n: i64) -> AppResult<String> {
    Ok(fmt_day(parse_day(day)? + Duration::days(n)))
}

/// Whole days from `a` to `b` (b − a).
pub fn days_between(a: &str, b: &str) -> AppResult<i64> {
    Ok((parse_day(b)? - parse_day(a)?).num_days())
}

/// Start of a logical day in UTC (local midnight + boundary). DST gaps resolve
/// to the earliest valid instant.
pub fn day_start_utc(day: &str, tz: Tz, boundary: NaiveTime) -> AppResult<DateTime<Utc>> {
    let naive = parse_day(day)?.and_time(boundary);
    let local = tz
        .from_local_datetime(&naive)
        .earliest()
        .or_else(|| tz.from_local_datetime(&(naive + Duration::hours(1))).earliest())
        .ok_or_else(|| AppError::Internal(format!("cannot resolve local time for {day}")))?;
    Ok(local.with_timezone(&Utc))
}

/// The timezone + boundary active right now, used when writing rows.
#[derive(Debug, Clone, Copy)]
pub struct Clock {
    pub tz: Tz,
    pub boundary: NaiveTime,
}

impl Clock {
    pub fn new(tz: &str, boundary: &str) -> AppResult<Self> {
        Ok(Self { tz: parse_tz(tz)?, boundary: parse_boundary(boundary)? })
    }

    pub fn system_default() -> Self {
        // Tests must not depend on the machine's timezone.
        let tz = if cfg!(test) { chrono_tz::UTC } else { system_timezone().parse().unwrap_or(chrono_tz::UTC) };
        Self {
            tz,
            boundary: parse_boundary(DEFAULT_BOUNDARY).expect("valid default"),
        }
    }

    pub fn day_key(&self, ts: DateTime<Utc>) -> String {
        day_key(ts, self.tz, self.boundary)
    }

    /// Local hour (0–23) of a timestamp, for "best time" style grouping.
    pub fn local_hour(&self, ts: DateTime<Utc>) -> u32 {
        use chrono::Timelike;
        ts.with_timezone(&self.tz).hour()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> DateTime<Utc> {
        parse_ts(s).unwrap()
    }

    #[test]
    fn late_night_counts_toward_previous_day() {
        let b = parse_boundary("04:00").unwrap();
        // 01:30 local on the 25th in UTC.
        assert_eq!(day_key(t("2026-09-25T01:30:00Z"), chrono_tz::UTC, b), "2026-09-24");
        assert_eq!(day_key(t("2026-09-25T04:00:00Z"), chrono_tz::UTC, b), "2026-09-25");
        assert_eq!(day_key(t("2026-09-25T03:59:59Z"), chrono_tz::UTC, b), "2026-09-24");
    }

    #[test]
    fn midnight_boundary_is_calendar_day() {
        let b = parse_boundary("00:00").unwrap();
        assert_eq!(day_key(t("2026-09-25T00:00:00Z"), chrono_tz::UTC, b), "2026-09-25");
        assert_eq!(day_key(t("2026-09-24T23:59:59Z"), chrono_tz::UTC, b), "2026-09-24");
    }

    #[test]
    fn uses_local_timezone() {
        let b = parse_boundary("04:00").unwrap();
        let dhaka: Tz = "Asia/Dhaka".parse().unwrap(); // UTC+6
        // 20:00Z on the 24th = 02:00 local on the 25th → still the 24th.
        assert_eq!(day_key(t("2026-09-24T20:00:00Z"), dhaka, b), "2026-09-24");
        // 22:30Z = 04:30 local on the 25th.
        assert_eq!(day_key(t("2026-09-24T22:30:00Z"), dhaka, b), "2026-09-25");
    }

    #[test]
    fn dst_transitions() {
        let b = parse_boundary("04:00").unwrap();
        let ny: Tz = "America/New_York".parse().unwrap();
        // Spring forward 2026-03-08 02:00 → 03:00 local. 03:30 EDT = 07:30Z → 8th before boundary.
        assert_eq!(day_key(t("2026-03-08T07:30:00Z"), ny, b), "2026-03-07");
        // 04:30 EDT = 08:30Z → the 8th.
        assert_eq!(day_key(t("2026-03-08T08:30:00Z"), ny, b), "2026-03-08");
        // Fall back 2026-11-01 02:00 → 01:00 local. 01:30 EST (second time) = 06:30Z.
        assert_eq!(day_key(t("2026-11-01T06:30:00Z"), ny, b), "2026-10-31");
        let start = day_start_utc("2026-03-08", ny, b).unwrap();
        assert_eq!(fmt_ts(start), "2026-03-08T08:00:00Z");
    }

    #[test]
    fn day_arithmetic() {
        assert_eq!(add_days("2026-02-28", 1).unwrap(), "2026-03-01");
        assert_eq!(days_between("2026-09-01", "2026-09-24").unwrap(), 23);
    }

    #[test]
    fn ts_roundtrip() {
        let s = "2026-09-24T14:30:00Z";
        assert_eq!(fmt_ts(t(s)), s);
    }
}
