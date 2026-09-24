//! Business logic. Every function takes a `&Connection` (and `now` where time
//! matters) so it can be tested against an in-memory database.

pub mod concepts;
pub mod data;
pub mod ai;
pub mod day;
#[cfg(test)]
pub mod fixtures;
pub mod diary;
pub mod insights;
pub mod letters;
pub mod library;
pub mod mood;
pub mod practice;
pub mod problems;
pub mod profile;
pub mod reports;
pub mod review;
pub mod roadmaps;
pub mod score;
pub mod search;
pub mod sessions;
pub mod settings;
pub mod stats;
pub mod util;

use serde::{Deserialize, Deserializer};

/// For PATCH-style inputs: missing → `None`, `null` → `Some(None)`, value → `Some(Some(v))`.
pub fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}
