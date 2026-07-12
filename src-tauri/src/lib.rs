use tauri::{Emitter, Manager};

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

#[derive(serde::Serialize, serde::Deserialize)]
struct SyncEngineVersion {
    version: String,
    source: String,
}

#[derive(serde::Deserialize)]
struct GitHubRelease {
    tag_name: String,
    assets: Vec<GitHubReleaseAsset>,
}

#[derive(serde::Deserialize)]
struct GitHubReleaseAsset {
    name: String,
    browser_download_url: String,
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
const BUNDLED_SYNC_ENGINE_VERSION: &str = "0.1.0";
const SYNC_ENGINE_RELEASE_API: &str =
    "https://api.github.com/repos/jdtaccounts-create/DofusCompanionSync/releases/latest";
const SYNC_ENGINE_ASSET_NAME: &str = "dofus-companion-sync.exe";

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
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(std::path::PathBuf::from)
                .map(|path| path.join("AppData").join("Local"))
        })
        .ok_or_else(|| "Dossier AppData local introuvable".to_string())?;
    Ok(local_app_data.join("DofusCompanionData"))
}

fn files_are_identical(left: &std::path::Path, right: &std::path::Path) -> Result<bool, String> {
    let left_meta = std::fs::metadata(left).map_err(|error| error.to_string())?;
    let right_meta = std::fs::metadata(right).map_err(|error| error.to_string())?;
    if left_meta.len() != right_meta.len() {
        return Ok(false);
    }
    let left_bytes = std::fs::read(left).map_err(|error| error.to_string())?;
    let right_bytes = std::fs::read(right).map_err(|error| error.to_string())?;
    Ok(left_bytes == right_bytes)
}

fn sync_engine_version_path() -> Result<std::path::PathBuf, String> {
    Ok(shared_data_dir()?.join("sync").join("engine-version.json"))
}

fn read_sync_engine_version() -> Option<SyncEngineVersion> {
    let path = sync_engine_version_path().ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_sync_engine_version(version: &str, source: &str) -> Result<(), String> {
    let payload = SyncEngineVersion {
        version: version.to_string(),
        source: source.to_string(),
    };
    let bytes = serde_json::to_vec_pretty(&payload).map_err(|error| error.to_string())?;
    write_file_safely(&sync_engine_version_path()?, &bytes)
}

fn normalize_version(version: &str) -> &str {
    version.trim().trim_start_matches('v')
}

fn version_parts(version: &str) -> Vec<u64> {
    normalize_version(version)
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

fn is_version_newer(candidate: &str, current: &str) -> bool {
    let mut left = version_parts(candidate);
    let mut right = version_parts(current);
    let len = left.len().max(right.len());
    left.resize(len, 0);
    right.resize(len, 0);
    left > right
}

fn bundled_sync_engine_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    ["dofus-companion-sync.exe", "resources/dofus-companion-sync.exe"]
        .iter()
        .filter_map(|relative| {
            app.path()
                .resolve(relative, tauri::path::BaseDirectory::Resource)
                .ok()
        })
        .find(|path| path.exists())
}

fn install_bundled_sync_engine(
    app: &tauri::AppHandle,
    installed: &std::path::Path,
) -> Result<(), String> {
    let Some(bundled) = bundled_sync_engine_path(app) else {
        return Ok(());
    };

    if installed.exists() {
        if let Some(current) = read_sync_engine_version() {
            if is_version_newer(&current.version, BUNDLED_SYNC_ENGINE_VERSION) {
                return Ok(());
            }
        }
        if files_are_identical(installed, &bundled)? {
            write_sync_engine_version(BUNDLED_SYNC_ENGINE_VERSION, "bundled")?;
            return Ok(());
        }
    }

    if let Some(parent) = installed.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let temp = installed.with_extension(format!("exe.{}.tmp", std::process::id()));
    if temp.exists() {
        let _ = std::fs::remove_file(&temp);
    }
    std::fs::copy(&bundled, &temp).map_err(|error| error.to_string())?;

    if installed.exists() {
        if let Err(error) = std::fs::remove_file(installed) {
            let _ = std::fs::remove_file(&temp);
            if installed.exists() {
                return Ok(());
            }
            return Err(error.to_string());
        }
    }

    std::fs::rename(&temp, installed).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        error.to_string()
    })?;
    write_sync_engine_version(BUNDLED_SYNC_ENGINE_VERSION, "bundled")?;

    Ok(())
}

async fn update_sync_engine_from_github(installed: &std::path::Path) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent("DofusCompanionApps/1.0")
        .build()
        .map_err(|error| error.to_string())?;
    let release_text = client
        .get(SYNC_ENGINE_RELEASE_API)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .text()
        .await
        .map_err(|error| error.to_string())?;
    let release: GitHubRelease =
        serde_json::from_str(&release_text).map_err(|error| error.to_string())?;

    let latest_version = normalize_version(&release.tag_name).to_string();
    let current_version = read_sync_engine_version()
        .map(|value| value.version)
        .unwrap_or_else(|| "0.0.0".to_string());
    if installed.exists() && !is_version_newer(&latest_version, &current_version) {
        return Ok(());
    }

    let Some(asset) = release
        .assets
        .into_iter()
        .find(|asset| asset.name == SYNC_ENGINE_ASSET_NAME)
    else {
        return Ok(());
    };

    let bytes = client
        .get(asset.browser_download_url)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .bytes()
        .await
        .map_err(|error| error.to_string())?;

    if let Some(parent) = installed.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temp = installed.with_extension(format!("exe.github.{}.tmp", std::process::id()));
    if temp.exists() {
        let _ = std::fs::remove_file(&temp);
    }
    std::fs::write(&temp, &bytes).map_err(|error| error.to_string())?;
    if installed.exists() {
        std::fs::remove_file(installed).map_err(|error| error.to_string())?;
    }
    std::fs::rename(&temp, installed).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        error.to_string()
    })?;
    write_sync_engine_version(&latest_version, "github")?;
    Ok(())
}

async fn shared_sync_engine_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let installed = shared_data_dir()?
        .join("sync")
        .join("dofus-companion-sync.exe");
    install_bundled_sync_engine(app, &installed)?;
    if let Err(error) = update_sync_engine_from_github(&installed).await {
        let _ = app.emit(
            "shared-sync-event",
            serde_json::json!({
                "kind": "message",
                "message": format!("Moteur commun GitHub indisponible, version locale conservee ({error})")
            })
            .to_string(),
        );
    }
    if installed.exists() {
        return Ok(installed);
    }

    let development = std::path::PathBuf::from(
        "D:\\GitHub\\DofusCompanionSync\\target\\release\\dofus-companion-sync.exe",
    );
    if development.exists() {
        return Ok(development);
    }

    Err("Moteur commun DofusCompanionSync introuvable".to_string())
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
    let engine = shared_sync_engine_path(&app).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut command = std::process::Command::new(engine);
        command.args(["sync", "--app", &app_name]);
        if force.unwrap_or(false) {
            command.arg("--force");
        }
        command
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Sortie moteur indisponible".to_string())?;
        let reader = std::io::BufReader::new(stdout);
        for line in std::io::BufRead::lines(reader) {
            let line = line.map_err(|error| error.to_string())?;
            let _ = app.emit("shared-sync-event", line);
        }
        let status = child.wait().map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                let _ = std::io::Read::read_to_string(&mut pipe, &mut stderr);
            }
            Err(if stderr.trim().is_empty() {
                format!("DofusCompanionSync a quitté avec le code {status}")
            } else {
                stderr.trim().to_string()
            })
        }
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
