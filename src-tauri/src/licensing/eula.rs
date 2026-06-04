use serde::{Serialize, Deserialize};
use tauri::Manager;
use crate::fs;
use std::path::PathBuf;

const EULA_VERSION: &str = "2026-06-03";
const EULA_TEXT: &str = include_str!("../../resources/EULA.txt");

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EulaStatus {
    accepted: bool,
    accepted_version: Option<String>,
    current_version: String,
    text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct EulaAcceptanceRecord {
    accepted_version: Option<String>,
}

fn eula_acceptance_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("failed to resolve app config dir: {e}"))?;

    fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create app config dir '{}': {e}", dir.display()))?;

    dir.push("eula_acceptance.json");
    Ok(dir)
}

fn load_eula_acceptance(app: &tauri::AppHandle) -> Result<EulaAcceptanceRecord, String> {
    let path = eula_acceptance_path(app)?;

    if !path.exists() {
        return Ok(EulaAcceptanceRecord::default());
    }

    let contents = fs::read_to_string(&path)
        .map_err(|e| format!("failed to read EULA acceptance file '{}': {e}", path.display()))?;

    serde_json::from_str::<EulaAcceptanceRecord>(&contents)
        .map_err(|e| format!("failed to parse EULA acceptance file '{}': {e}", path.display()))
}

fn save_eula_acceptance(app: &tauri::AppHandle, record: &EulaAcceptanceRecord) -> Result<(), String> {
    let path = eula_acceptance_path(app)?;

    let json = serde_json::to_string_pretty(record)
        .map_err(|e| format!("failed to serialize EULA acceptance record: {e}"))?;

    fs::write(&path, json)
        .map_err(|e| format!("failed to write EULA acceptance file '{}': {e}", path.display()))
}

#[tauri::command]
pub fn get_eula_status(app: tauri::AppHandle) -> Result<EulaStatus, String> {
    let record = load_eula_acceptance(&app)?;
    let accepted = record.accepted_version.as_deref() == Some(EULA_VERSION);

    Ok(EulaStatus {
        accepted,
        accepted_version: record.accepted_version,
        current_version: EULA_VERSION.to_string(),
        text: EULA_TEXT.to_string(),
    })
}

#[tauri::command]
pub fn accept_eula(app: tauri::AppHandle) -> Result<(), String> {
    let record = EulaAcceptanceRecord {
        accepted_version: Some(EULA_VERSION.to_string()),
    };

    save_eula_acceptance(&app, &record)
}