use kaleidomo_core::LicenseData;
use tauri::{Manager, State};

use crate::{AppState, DOWNLOADS_URL, PRODUCT_NAME, STORE_PAGE_URL, VERSION_URL, log_error};
use kaleidomo_core::software_licensor_static_rust_lib::reqwest;

pub mod cooldown;
pub mod eula;
pub use eula::*;
pub mod signature_verification;
pub use signature_verification::*;

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
pub async fn is_new_version_available(state: tauri::State<'_, AppState>, app: tauri::AppHandle) -> Result<bool, String> {
    let mut last = state.last_version_fetch.lock().await;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();

    let should_fetch = match *last {
        Some(ts) => now - ts >= Duration::from_hours(1).as_secs(),
        None => true
    };

    if should_fetch {
        let response = reqwest::get(VERSION_URL)
            .await
            .map_err(|e| e.to_string())?;
        let text = match response.text().await {
            Ok(v) => v,
            Err(e) => {
                log_error!("is_new_version_available() text error: {}", e);
                return Err(e.to_string());
            }
        };
        let cloud_version = text.trim();
        *last = Some(now);
        match persist_timestamp(&app, now) {
            Ok(()) => (),
            Err(e) => {
                log_error!("is_new_version_available persist_timestamp_err: {}", e);
                return Err(e);
            }
        }
        return Ok(state.license_status.is_update_available_manual(&app.package_info().version.to_string(), cloud_version));
    }
    Ok(state.license_status.is_update_available(&app.package_info().version.to_string(), &state.license_data))
}

#[tauri::command]
pub fn current_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn product_name() -> String {
    PRODUCT_NAME.to_string()
}

#[tauri::command]
pub fn downloads_url() -> String {
    DOWNLOADS_URL.to_string()
}

#[tauri::command]
pub fn store_page_url() -> String {
    STORE_PAGE_URL.to_string()
}

#[tauri::command]
pub async fn display_system_stats() -> Result<kaleidomo_core::StatsDisplay, String> {
    // Safety: function is only used to display hardware information.
    unsafe {
        kaleidomo_core::get_machine_stats_for_display().await
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

use tauri::AppHandle;
use std::{fs, time::{Duration, SystemTime, UNIX_EPOCH}};

fn persist_timestamp(app: &AppHandle, ts: u64) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("last_fetch.txt");

    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(path, ts.to_string()).map_err(|e| e.to_string())?;

    Ok(())
}

pub fn load_timestamp(app: &AppHandle) -> Option<u64> {
    let path = app.path().app_data_dir().ok()?.join("last_fetch.txt");
    let text = fs::read_to_string(path).ok()?;
    u64::from_str_radix(&text, 10).ok()
}
