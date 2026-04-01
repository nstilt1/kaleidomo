use tauri::State;

use crate::{AppState, VERSION};

pub mod cooldown;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseInfo {
    pub is_unlocked: bool,
    pub license_data: kaleidomo_core::LicenseData,
}

#[tauri::command]
pub async fn license_data(state: tauri::State<'_, AppState>) -> Result<LicenseInfo, String> {
    Ok(match state.license_status.check_license(true).await {
        Ok(v) => LicenseInfo {
            is_unlocked: v.0,
            license_data: v.1,
        },
        Err(v) => LicenseInfo {
            is_unlocked: false,
            license_data: v.1,
        },
    })
}

#[tauri::command]
pub async fn is_unlocked(state: tauri::State<'_, AppState>) -> Result<LicenseInfo, String> {
    match state.license_status.check_license(true).await {
        Ok(v) => Ok(LicenseInfo {
            is_unlocked: v.0,
            license_data: v.1,
        }),
        Err(v) => Err(v.0.to_string()),
    }
}

#[tauri::command]
pub async fn read_reply_from_webserver(state: State<'_, AppState>, license_code: String, save_system_stats: bool) -> Result<LicenseInfo, String> {
    match state.license_status.read_reply_from_webserver(&license_code, save_system_stats).await {
        Ok(v) => Ok(LicenseInfo {
            is_unlocked: v.0,
            license_data: v.1,
        }),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn is_new_version_available(state: tauri::State<'_, AppState>) -> bool {
    state.license_status.is_update_available(VERSION, &state.license_data)
}

#[tauri::command]
pub fn current_version() -> String {
    VERSION.to_string()
}

#[tauri::command]
pub fn display_system_stats() -> Result<kaleidomo_core::StatsDisplay, String> {
    // Safety: function is only used to display hardware information.
    unsafe {
        kaleidomo_core::get_machine_stats_for_display()
    }
}

#[tauri::command]
pub async fn get_current_cloud_info(state: tauri::State<'_, AppState>) -> Result<kaleidomo_core::StatsDisplay, String> {
    Ok(state.license_status.get_current_system_information_that_is_stored_in_cloud().await)
}

#[tauri::command]
pub async fn delete_hardware_info_from_cloud(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    license_code: String,
) -> Result<LicenseInfo, String> {
    let mut cooldown = state.license_sync_cooldown.lock().await;

    cooldown::enforce(&cooldown)?;

    let result = state
        .license_status
        .read_reply_from_webserver(&license_code, false)
        .await;

    match result {
        Ok(v) => {
            cooldown::mark_success_and_persist(&app, &mut cooldown)?;

            Ok(LicenseInfo {
                is_unlocked: v.0,
                license_data: v.1,
            })
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn update_license(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    license_code: String,
    save_system_stats: bool,
) -> Result<LicenseInfo, String> {
    let mut cooldown = state.license_sync_cooldown.lock().await;

    cooldown::enforce(&cooldown)?;

    let result = state
        .license_status
        .read_reply_from_webserver(&license_code, save_system_stats)
        .await;

    match result {
        Ok(v) => {
            cooldown::mark_success_and_persist(&app, &mut cooldown)?;

            Ok(LicenseInfo {
                is_unlocked: v.0,
                license_data: v.1,
            })
        }
        Err(e) => Err(e.to_string()),
    }
}