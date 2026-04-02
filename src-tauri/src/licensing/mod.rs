use kaleidomo_core::LicenseData;
use tauri::State;

use crate::{AppState, VERSION, PRODUCT_NAME};

pub mod cooldown;

const UNKNOWN_ERROR_CODE: i32 = 512;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseInfo {
    pub is_unlocked: bool,
    pub license_data: kaleidomo_core::LicenseData,
}

impl From<String> for LicenseInfo {
    fn from(value: String) -> Self {
        LicenseInfo {
            is_unlocked: false,
            license_data: LicenseData {
                result_code: UNKNOWN_ERROR_CODE,
                customer_first_name: "".into(),
                customer_last_name: "".into(),
                customer_email: "".into(),
                license_type: "".into(),
                version: "".into(),
                error_message: value,
                license_code: "".into(),
                machine_count: None,
                machine_limit: None,
            }
        }
    }
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
pub async fn read_reply_from_webserver(state: State<'_, AppState>, license_code: String, save_system_stats: bool) -> Result<LicenseInfo, LicenseInfo> {
    match state.license_status.read_reply_from_webserver(&license_code, save_system_stats).await {
        Ok(v) => Ok(LicenseInfo {
            is_unlocked: v.0,
            license_data: v.1,
        }),
        Err(e) => Err(LicenseInfo {
            is_unlocked: false,
            license_data: e.1,
        }),
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
pub fn product_name() -> String {
    PRODUCT_NAME.to_string()
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
) -> Result<LicenseInfo, LicenseInfo> {
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
        Err(e) => Err(LicenseInfo {
            is_unlocked: false,
            license_data: e.1,
        }),
    }
}

#[tauri::command]
pub async fn update_license(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    license_code: String,
    save_system_stats: bool,
) -> Result<LicenseInfo, LicenseInfo> {
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
        Err(e) => Ok(LicenseInfo {
            is_unlocked: false,
            license_data: e.1,
        })
    }
}