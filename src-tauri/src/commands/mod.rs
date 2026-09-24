//! IPC entry points (backend §5). Commands validate input via serde + the
//! service layer, take snake_case arguments, and return `{ code, message }` errors.

pub mod content;
pub mod core;
pub mod files;
pub mod practice;
