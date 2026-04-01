use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

pub const LICENSE_SYNC_COOLDOWN_MS: u64 = 5 * 60 * 1000;

#[derive(Debug, Clone, Copy, Default)]
pub struct LicenseSyncCooldownState {
    pub last_successful_sync_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LicenseSyncCooldownFile {
    last_successful_sync_unix_ms: Option<u64>,
}

fn now_unix_ms() -> Result<u64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("System clock error: {e}"))?;

    let ms: u128 = duration.as_millis();
    u64::try_from(ms).map_err(|_| "Current system time is too large.".to_string())
}

fn cooldown_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create app data directory {}: {e}", dir.display()))?;

    Ok(dir.join("license_sync_cooldown.json"))
}

pub fn load_state(app: &AppHandle) -> Result<LicenseSyncCooldownState, String> {
    let path = cooldown_file_path(app)?;

    if !path.exists() {
        return Ok(LicenseSyncCooldownState::default());
    }

    let contents = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read cooldown file {}: {e}", path.display()))?;

    let parsed: LicenseSyncCooldownFile = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse cooldown file {}: {e}", path.display()))?;

    Ok(LicenseSyncCooldownState {
        last_successful_sync_unix_ms: parsed.last_successful_sync_unix_ms,
    })
}

pub fn save_state(app: &AppHandle, state: &LicenseSyncCooldownState) -> Result<(), String> {
    let path = cooldown_file_path(app)?;
    let file = LicenseSyncCooldownFile {
        last_successful_sync_unix_ms: state.last_successful_sync_unix_ms,
    };

    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| format!("Failed to serialize cooldown file: {e}"))?;

    fs::write(&path, json)
        .map_err(|e| format!("Failed to write cooldown file {}: {e}", path.display()))
}

pub fn remaining_cooldown_ms(state: &LicenseSyncCooldownState) -> Result<u64, String> {
    let Some(last_ms) = state.last_successful_sync_unix_ms else {
        return Ok(0);
    };

    let now_ms = now_unix_ms()?;
    let next_allowed_ms = last_ms.saturating_add(LICENSE_SYNC_COOLDOWN_MS);

    if now_ms >= next_allowed_ms {
        Ok(0)
    } else {
        Ok(next_allowed_ms - now_ms)
    }
}

pub fn enforce(state: &LicenseSyncCooldownState) -> Result<(), String> {
    let remaining_ms = remaining_cooldown_ms(state)?;

    if remaining_ms == 0 {
        return Ok(());
    }

    let remaining_seconds = remaining_ms.div_ceil(1000);

    Err(format!(
        "Please wait {} more second{} before syncing the license again.",
        remaining_seconds,
        if remaining_seconds == 1 { "" } else { "s" }
    ))
}

pub fn mark_success_and_persist(
    app: &AppHandle,
    state: &mut LicenseSyncCooldownState,
) -> Result<(), String> {
    let now_ms = now_unix_ms()?;
    state.last_successful_sync_unix_ms = Some(now_ms);
    save_state(app, state)
}