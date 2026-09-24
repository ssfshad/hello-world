use serde::Serialize;

/// Error shape returned to the UI: `{ code, message }` (backend §5).
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    AiProvider(String),
    #[error("{0}")]
    InvalidJson(String),
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    Db(String),
    #[error("{0}")]
    Cancelled(String),
    #[error("{0}")]
    Internal(String),
}

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Serialize)]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Validation(_) => "VALIDATION",
            AppError::NotFound(_) => "NOT_FOUND",
            AppError::Conflict(_) => "CONFLICT",
            AppError::AiProvider(_) => "AI_PROVIDER",
            AppError::InvalidJson(_) => "INVALID_JSON",
            AppError::Io(_) => "IO",
            AppError::Db(_) => "DB",
            AppError::Cancelled(_) => "CANCELLED",
            AppError::Internal(_) => "INTERNAL",
        }
    }

    pub fn validation(msg: impl Into<String>) -> Self {
        AppError::Validation(msg.into())
    }

    pub fn not_found(what: impl Into<String>) -> Self {
        AppError::NotFound(format!("{} not found", what.into()))
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        ErrorPayload { code: self.code().to_string(), message: self.to_string() }.serialize(s)
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        match &e {
            rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("record not found".into()),
            rusqlite::Error::SqliteFailure(err, _)
                if err.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                AppError::Conflict(format!("constraint violated: {e}"))
            }
            _ => AppError::Db(e.to_string()),
        }
    }
}

impl From<rusqlite_migration::Error> for AppError {
    fn from(e: rusqlite_migration::Error) -> Self {
        AppError::Db(format!("migration failed: {e}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Internal(format!("json: {e}"))
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            AppError::AiProvider("The AI provider took too long to answer (timeout).".into())
        } else if e.is_connect() {
            AppError::AiProvider(
                "Could not reach the AI provider. Is it running and is the address right?".into(),
            )
        } else {
            AppError::AiProvider(e.to_string())
        }
    }
}

impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        match e {
            keyring::Error::NoEntry => AppError::NotFound("API key not set".into()),
            other => AppError::Internal(format!("keychain: {other}")),
        }
    }
}
