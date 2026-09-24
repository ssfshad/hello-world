//! API keys live only in the OS keychain (Windows Credential Manager, macOS
//! Keychain, Linux Secret Service). The database stores a reference name.
//! Keys are read at request time and never returned to the UI.

use crate::error::AppResult;

const SERVICE: &str = "app.helloworld.journal";

fn entry(key_ref: &str) -> AppResult<keyring::Entry> {
    Ok(keyring::Entry::new(SERVICE, key_ref)?)
}

pub fn set(key_ref: &str, secret: &str) -> AppResult<()> {
    entry(key_ref)?.set_password(secret)?;
    Ok(())
}

pub fn get(key_ref: &str) -> AppResult<Option<String>> {
    match entry(key_ref)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete(key_ref: &str) -> AppResult<()> {
    match entry(key_ref)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
