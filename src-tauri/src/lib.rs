mod dofus_companion_sync;

use tauri::Emitter;

#[derive(serde::Serialize)]
struct HttpTextResponse {
    body: String,
    content_length: Option<u64>,
}

#[derive(serde::Serialize)]
struct CachedImage {
    item_id: u32,
    bytes: Vec<u8>,
}

#[derive(serde::Serialize)]
struct CachedAsset {
    file: String,
    bytes: Vec<u8>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct SharedSyncLock {
    app: String,
    pid: u32,
    started_at: u64,
    heartbeat_at: u64,
    phase: String,
}

#[derive(serde::Serialize)]
struct SharedSyncLockStatus {
    acquired: bool,
    lock: Option<SharedSyncLock>,
}

const SHARED_LOCK_STALE_MS: u64 = 2 * 60 * 1000;

fn now_millis() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn is_process_running(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }
    unsafe {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }

        let mut exit_code = 0;
        let ok = GetExitCodeProcess(handle, &mut exit_code);
        let _ = CloseHandle(handle);
        ok != 0 && exit_code == STILL_ACTIVE as u32
    }
}

#[cfg(not(windows))]
fn is_process_running(pid: u32) -> bool {
    pid == std::process::id()
}

fn shared_data_dir() -> Result<std::path::PathBuf, String> {
    dofus_companion_sync::shared_data_dir()
}

fn shared_json_path(key: &str) -> Result<std::path::PathBuf, String> {
    let relative = match key {
        "catalog" => ["catalog", "catalog.json"]
            .iter()
            .collect::<std::path::PathBuf>(),
        "failed-images" => ["catalog", "failed-images.json"]
            .iter()
            .collect::<std::path::PathBuf>(),
        "characteristics" => ["catalog", "characteristics.json"]
            .iter()
            .collect::<std::path::PathBuf>(),
        "characteristic-icons" => ["catalog", "characteristic-icons.json"]
            .iter()
            .collect::<std::path::PathBuf>(),
        "characteristic-icon-aliases" => ["catalog", "characteristic-icon-aliases.json"]
            .iter()
            .collect::<std::path::PathBuf>(),
        "sync-manifest" => ["catalog", "sync-manifest.json"]
            .iter()
            .collect::<std::path::PathBuf>(),
        _ => return Err("Clé de données commune non autorisée".to_string()),
    };
    Ok(shared_data_dir()?.join(relative))
}

fn shared_image_path(item_id: u32) -> Result<std::path::PathBuf, String> {
    Ok(shared_data_dir()?
        .join("images")
        .join("items")
        .join(format!("{item_id}.png")))
}

fn safe_png_file_name(file: &str) -> Result<String, String> {
    let path = std::path::Path::new(file);
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Nom de fichier invalide".to_string())?;
    if name != file || !name.ends_with(".png") || name.contains('/') || name.contains('\\') {
        return Err("Nom de fichier non autorisé".to_string());
    }
    Ok(name.to_string())
}

fn shared_characteristic_icon_path(file: &str) -> Result<std::path::PathBuf, String> {
    Ok(shared_data_dir()?
        .join("icons")
        .join("characteristics")
        .join(safe_png_file_name(file)?))
}

fn shared_lock_path() -> Result<std::path::PathBuf, String> {
    Ok(shared_data_dir()?.join("sync.lock"))
}

fn cleanup_tmp_files(dir: &std::path::Path) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().and_then(|value| value.to_str()) == Some("tmp") {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}

fn write_file_safely(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        cleanup_tmp_files(parent)?;
    }
    let tmp_path = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&tmp_path, bytes).map_err(|error| error.to_string())?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    std::fs::rename(tmp_path, path).map_err(|error| error.to_string())
}

fn read_lock_file() -> Result<Option<SharedSyncLock>, String> {
    let path = shared_lock_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn write_lock_file(lock: &SharedSyncLock) -> Result<(), String> {
    let value = serde_json::to_vec(lock).map_err(|error| error.to_string())?;
    write_file_safely(&shared_lock_path()?, &value)
}

fn is_lock_fresh(lock: &SharedSyncLock, now: u64) -> bool {
    is_process_running(lock.pid) && now.saturating_sub(lock.heartbeat_at) < SHARED_LOCK_STALE_MS
}

#[tauri::command]
fn shared_data_path() -> Result<String, String> {
    Ok(shared_data_dir()?.to_string_lossy().to_string())
}

#[tauri::command]
fn read_shared_json(key: String) -> Result<Option<String>, String> {
    let path = shared_json_path(&key)?;
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(path)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn write_shared_json(key: String, value: String) -> Result<(), String> {
    let path = shared_json_path(&key)?;
    write_file_safely(&path, value.as_bytes())
}

#[tauri::command]
fn list_shared_image_ids() -> Result<Vec<u32>, String> {
    let dir = shared_data_dir()?.join("images").join("items");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut ids = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("png") {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|value| value.to_str()) {
            if let Ok(id) = stem.parse::<u32>() {
                ids.push(id);
            }
        }
    }
    Ok(ids)
}

#[tauri::command]
fn read_shared_images(item_ids: Vec<u32>) -> Result<Vec<CachedImage>, String> {
    let mut rows = Vec::new();
    for item_id in item_ids {
        let path = shared_image_path(item_id)?;
        if path.exists() {
            rows.push(CachedImage {
                item_id,
                bytes: std::fs::read(path).map_err(|error| error.to_string())?,
            });
        }
    }
    Ok(rows)
}

#[tauri::command]
fn write_shared_image(item_id: u32, bytes: Vec<u8>) -> Result<(), String> {
    let path = shared_image_path(item_id)?;
    write_file_safely(&path, &bytes)
}

#[tauri::command]
fn list_shared_characteristic_icons() -> Result<Vec<String>, String> {
    let dir = shared_data_dir()?.join("icons").join("characteristics");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("png") {
            continue;
        }
        if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
            files.push(name.to_string());
        }
    }
    Ok(files)
}

#[tauri::command]
fn read_shared_characteristic_icons(files: Vec<String>) -> Result<Vec<CachedAsset>, String> {
    let mut rows = Vec::new();
    for file in files {
        let safe_file = safe_png_file_name(&file)?;
        let path = shared_characteristic_icon_path(&safe_file)?;
        if path.exists() {
            rows.push(CachedAsset {
                file: safe_file,
                bytes: std::fs::read(path).map_err(|error| error.to_string())?,
            });
        }
    }
    Ok(rows)
}

#[tauri::command]
fn write_shared_characteristic_icon(file: String, bytes: Vec<u8>) -> Result<(), String> {
    let path = shared_characteristic_icon_path(&file)?;
    write_file_safely(&path, &bytes)
}

#[tauri::command]
fn clear_shared_images() -> Result<(), String> {
    let dir = shared_data_dir()?.join("images").join("items");
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|error| error.to_string())?;
    }
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())
}

#[tauri::command]
fn prune_shared_images(valid_item_ids: Vec<u32>) -> Result<usize, String> {
    let dir = shared_data_dir()?.join("images").join("items");
    if !dir.exists() {
        return Ok(0);
    }
    let valid: std::collections::HashSet<u32> = valid_item_ids.into_iter().collect();
    let mut removed = 0;
    for entry in std::fs::read_dir(dir).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("png") {
            continue;
        }
        let Some(id) = path
            .file_stem()
            .and_then(|value| value.to_str())
            .and_then(|value| value.parse::<u32>().ok())
        else {
            continue;
        };
        if !valid.contains(&id) {
            std::fs::remove_file(path).map_err(|error| error.to_string())?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[tauri::command]
fn read_shared_sync_lock() -> Result<Option<SharedSyncLock>, String> {
    match read_lock_file()? {
        Some(lock) if is_lock_fresh(&lock, now_millis()?) => Ok(Some(lock)),
        Some(_) => {
            let _ = std::fs::remove_file(shared_lock_path()?);
            Ok(None)
        }
        None => Ok(None),
    }
}

#[tauri::command]
fn acquire_shared_sync_lock(app: String, phase: String) -> Result<SharedSyncLockStatus, String> {
    let now = now_millis()?;
    if let Some(lock) = read_lock_file()? {
        if is_lock_fresh(&lock, now) && lock.pid != std::process::id() {
            return Ok(SharedSyncLockStatus {
                acquired: false,
                lock: Some(lock),
            });
        }
    }
    let lock = SharedSyncLock {
        app,
        pid: std::process::id(),
        started_at: now,
        heartbeat_at: now,
        phase,
    };
    write_lock_file(&lock)?;
    Ok(SharedSyncLockStatus {
        acquired: true,
        lock: Some(lock),
    })
}

#[tauri::command]
fn heartbeat_shared_sync_lock(
    app: String,
    phase: String,
) -> Result<Option<SharedSyncLock>, String> {
    let now = now_millis()?;
    let mut lock = match read_lock_file()? {
        Some(lock) if lock.pid == std::process::id() || !is_lock_fresh(&lock, now) => lock,
        other => return Ok(other),
    };
    lock.app = app;
    lock.pid = std::process::id();
    lock.heartbeat_at = now;
    lock.phase = phase;
    write_lock_file(&lock)?;
    Ok(Some(lock))
}

#[tauri::command]
fn release_shared_sync_lock() -> Result<(), String> {
    if let Some(lock) = read_lock_file()? {
        if lock.pid == std::process::id() {
            let _ = std::fs::remove_file(shared_lock_path()?);
        }
    }
    Ok(())
}

#[tauri::command]
async fn run_shared_sync_engine(
    app: tauri::AppHandle,
    app_name: String,
    force: Option<bool>,
) -> Result<(), String> {
    let engine = dofus_companion_sync::ensure_engine(&app).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        dofus_companion_sync::run_engine(engine, app_name, force.unwrap_or(false), move |line| {
            let _ = app.emit("shared-sync-event", line);
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn http_get(url: String) -> Result<String, String> {
    let response = reqwest::get(url)
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;

    response.text().await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn http_get_with_metadata(url: String) -> Result<HttpTextResponse, String> {
    let response = reqwest::get(url)
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    let content_length = response.content_length();
    let body = response.text().await.map_err(|error| error.to_string())?;

    Ok(HttpTextResponse {
        body,
        content_length,
    })
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://dofusdb.fr/database/") {
        return Err("URL externe non autorisée".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn read_clipboard() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    clipboard.get_text().map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            http_get,
            http_get_with_metadata,
            open_external_url,
            read_clipboard,
            shared_data_path,
            read_shared_json,
            write_shared_json,
            list_shared_image_ids,
            read_shared_images,
            write_shared_image,
            list_shared_characteristic_icons,
            read_shared_characteristic_icons,
            write_shared_characteristic_icon,
            clear_shared_images,
            prune_shared_images,
            read_shared_sync_lock,
            acquire_shared_sync_lock,
            heartbeat_shared_sync_lock,
            release_shared_sync_lock,
            run_shared_sync_engine
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
