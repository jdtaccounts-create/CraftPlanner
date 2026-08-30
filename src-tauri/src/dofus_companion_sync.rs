use fs2::FileExt;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

pub const SUPPORTED_SYNC_PROTOCOL: u32 = 1;

const DISTRIBUTION_MANIFEST_VERSION: u32 = 1;
const SYNC_ENGINE_ASSET_NAME: &str = "dofus-companion-sync.exe";
const SYNC_ENGINE_MANIFEST_NAME: &str = "dofus-companion-sync.manifest.json";
const RELEASE_MANIFEST_ASSET_NAME: &str = "manifest.json";
const SUPPORTED_TARGET: &str = "x86_64-pc-windows-msvc";
const SYNC_ENGINE_RELEASE_API: &str =
    "https://api.github.com/repos/jdtaccounts-create/DofusCompanionSync/releases/latest";
const INSTALL_LOCK_TIMEOUT: Duration = Duration::from_secs(15);
const INSTALL_LOCK_RETRY: Duration = Duration::from_millis(25);
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

static STAGING_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DistributionManifest {
    manifest_version: u32,
    engine_version: String,
    protocol_version: u32,
    catalog_schema_version: u32,
    sync_manifest_schema_version: u32,
    asset_name: String,
    target: String,
    size: u64,
    sha256: String,
    commit: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct EngineIdentity {
    engine_version: String,
    protocol_version: u32,
    catalog_schema_version: u32,
    sync_manifest_schema_version: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum InstallSource {
    Bundled,
    Github,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EngineMarkerV2 {
    manifest_version: u32,
    engine_version: String,
    protocol_version: u32,
    catalog_schema_version: u32,
    sync_manifest_schema_version: u32,
    sha256: String,
    size: u64,
    commit: String,
    source: InstallSource,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    assets: Vec<GitHubReleaseAsset>,
}

#[derive(Clone, Debug, Deserialize)]
struct GitHubReleaseAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Clone)]
struct Candidate {
    manifest: DistributionManifest,
    source: InstallSource,
    bytes: Vec<u8>,
}

struct RemoteCandidateDescriptor {
    manifest: DistributionManifest,
    binary_url: String,
}

#[derive(Clone, Debug)]
struct InstallPaths {
    install_root: PathBuf,
    engine: PathBuf,
    marker: PathBuf,
    install_lock: PathBuf,
    previous: PathBuf,
}

impl InstallPaths {
    fn new(data_root: PathBuf, install_root: PathBuf) -> Self {
        Self {
            engine: install_root.join(SYNC_ENGINE_ASSET_NAME),
            marker: data_root.join("sync").join("engine-version.json"),
            install_lock: data_root.join("sync").join("engine-install.lock"),
            previous: install_root.join("dofus-companion-sync.previous.exe"),
            install_root,
        }
    }

    fn production() -> Result<Self, String> {
        let data_root = shared_data_dir()?;
        Ok(Self::new(data_root.clone(), data_root.join("sync")))
    }
}

struct InstallLock {
    file: File,
}

impl Drop for InstallLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

#[derive(Clone, Debug)]
struct ValidatedInstallation {
    version: Version,
    marker: EngineMarkerV2,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum MarkerState {
    Missing,
    Legacy,
    Valid(EngineMarkerV2),
    Invalid,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ActivationKind {
    Unchanged,
    FirstInstall,
    Replacement,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct InstallReport {
    activation: ActivationKind,
    marker_written: bool,
}

pub(crate) fn shared_data_dir() -> Result<PathBuf, String> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .map(|path| path.join("AppData").join("Local"))
        })
        .ok_or_else(|| "Dossier AppData local introuvable".to_string())?;
    Ok(local_app_data.join("DofusCompanionData"))
}

fn validate_hex(value: &str, expected_len: usize, label: &str) -> Result<(), String> {
    if value.len() != expected_len || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{label} invalide"));
    }
    Ok(())
}

fn validate_manifest(manifest: &DistributionManifest) -> Result<Version, String> {
    if manifest.manifest_version != DISTRIBUTION_MANIFEST_VERSION {
        return Err(format!(
            "Distribution manifest {} non supporté",
            manifest.manifest_version
        ));
    }
    if manifest.protocol_version != SUPPORTED_SYNC_PROTOCOL {
        return Err(format!(
            "Protocole Sync {} non supporté (attendu {})",
            manifest.protocol_version, SUPPORTED_SYNC_PROTOCOL
        ));
    }
    if manifest.target != SUPPORTED_TARGET {
        return Err(format!("Target Sync non supporté: {}", manifest.target));
    }
    if manifest.asset_name != SYNC_ENGINE_ASSET_NAME {
        return Err(format!("Asset Sync inattendu: {}", manifest.asset_name));
    }
    if manifest.size == 0 {
        return Err("Taille Sync invalide".to_string());
    }
    validate_hex(&manifest.sha256, 64, "SHA-256 Sync")?;
    validate_hex(&manifest.commit, 40, "Commit Sync")?;
    Version::parse(&manifest.engine_version).map_err(|error| error.to_string())
}

fn validate_marker(marker: &EngineMarkerV2) -> Result<Version, String> {
    let manifest = DistributionManifest {
        manifest_version: marker.manifest_version,
        engine_version: marker.engine_version.clone(),
        protocol_version: marker.protocol_version,
        catalog_schema_version: marker.catalog_schema_version,
        sync_manifest_schema_version: marker.sync_manifest_schema_version,
        asset_name: SYNC_ENGINE_ASSET_NAME.to_string(),
        target: SUPPORTED_TARGET.to_string(),
        size: marker.size,
        sha256: marker.sha256.clone(),
        commit: marker.commit.clone(),
    };
    validate_manifest(&manifest)
}

fn marker_from_manifest(manifest: &DistributionManifest, source: InstallSource) -> EngineMarkerV2 {
    EngineMarkerV2 {
        manifest_version: manifest.manifest_version,
        engine_version: manifest.engine_version.clone(),
        protocol_version: manifest.protocol_version,
        catalog_schema_version: manifest.catalog_schema_version,
        sync_manifest_schema_version: manifest.sync_manifest_schema_version,
        sha256: manifest.sha256.to_ascii_lowercase(),
        size: manifest.size,
        commit: manifest.commit.clone(),
        source,
    }
}

fn parse_manifest(bytes: &[u8]) -> Result<DistributionManifest, String> {
    let manifest: DistributionManifest =
        serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

fn read_marker_state(path: &Path) -> MarkerState {
    let Ok(bytes) = std::fs::read(path) else {
        return MarkerState::Missing;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return MarkerState::Invalid;
    };
    if value.get("manifestVersion").is_none() && value.get("version").is_some() {
        return MarkerState::Legacy;
    }
    let Ok(marker) = serde_json::from_value::<EngineMarkerV2>(value) else {
        return MarkerState::Invalid;
    };
    if validate_marker(&marker).is_err() {
        return MarkerState::Invalid;
    }
    MarkerState::Valid(marker)
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn validate_bytes(bytes: &[u8], manifest: &DistributionManifest) -> Result<(), String> {
    validate_manifest(manifest)?;
    if bytes.len() as u64 != manifest.size {
        return Err(format!(
            "Taille Sync invalide: {} au lieu de {}",
            bytes.len(),
            manifest.size
        ));
    }
    let actual = sha256_bytes(bytes);
    if !actual.eq_ignore_ascii_case(&manifest.sha256) {
        return Err(format!(
            "SHA-256 Sync invalide: {actual} au lieu de {}",
            manifest.sha256
        ));
    }
    Ok(())
}

fn validate_file(path: &Path, manifest: &DistributionManifest) -> Result<(), String> {
    validate_manifest(manifest)?;
    let size = std::fs::metadata(path)
        .map_err(|error| error.to_string())?
        .len();
    if size != manifest.size {
        return Err(format!(
            "Taille Sync invalide: {size} au lieu de {}",
            manifest.size
        ));
    }
    let actual = sha256_file(path)?;
    if !actual.eq_ignore_ascii_case(&manifest.sha256) {
        return Err(format!(
            "SHA-256 Sync invalide: {actual} au lieu de {}",
            manifest.sha256
        ));
    }
    Ok(())
}

fn identity_matches_manifest(
    identity: &EngineIdentity,
    manifest: &DistributionManifest,
) -> Result<(), String> {
    if identity.engine_version != manifest.engine_version
        || identity.protocol_version != manifest.protocol_version
        || identity.catalog_schema_version != manifest.catalog_schema_version
        || identity.sync_manifest_schema_version != manifest.sync_manifest_schema_version
    {
        return Err("Identity Sync différente du distribution manifest".to_string());
    }
    if identity.protocol_version != SUPPORTED_SYNC_PROTOCOL {
        return Err(format!(
            "Protocole Sync {} non supporté",
            identity.protocol_version
        ));
    }
    Ok(())
}

fn identity_matches_marker(
    identity: &EngineIdentity,
    marker: &EngineMarkerV2,
) -> Result<(), String> {
    let manifest = DistributionManifest {
        manifest_version: marker.manifest_version,
        engine_version: marker.engine_version.clone(),
        protocol_version: marker.protocol_version,
        catalog_schema_version: marker.catalog_schema_version,
        sync_manifest_schema_version: marker.sync_manifest_schema_version,
        asset_name: SYNC_ENGINE_ASSET_NAME.to_string(),
        target: SUPPORTED_TARGET.to_string(),
        size: marker.size,
        sha256: marker.sha256.clone(),
        commit: marker.commit.clone(),
    };
    identity_matches_manifest(identity, &manifest)
}

fn hidden_command(path: &Path) -> Command {
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn run_identity(path: &Path) -> Result<EngineIdentity, String> {
    let output = hidden_command(path)
        .arg("identity")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Identity Sync en échec ({}): {}",
            output.status,
            stderr.trim()
        ));
    }
    let stdout = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
    let line = stdout.trim();
    if line.is_empty() || line.lines().count() != 1 {
        return Err("Identity Sync doit contenir une seule ligne JSON".to_string());
    }
    serde_json::from_str(line).map_err(|error| error.to_string())
}

fn validate_existing_with<F>(
    paths: &InstallPaths,
    identity_runner: &F,
) -> Result<Option<ValidatedInstallation>, String>
where
    F: Fn(&Path) -> Result<EngineIdentity, String>,
{
    if !paths.engine.exists() {
        return Ok(None);
    }
    let MarkerState::Valid(marker) = read_marker_state(&paths.marker) else {
        return Ok(None);
    };
    let version = validate_marker(&marker)?;
    let size = std::fs::metadata(&paths.engine)
        .map_err(|error| error.to_string())?
        .len();
    if size != marker.size {
        return Ok(None);
    }
    if !sha256_file(&paths.engine)?.eq_ignore_ascii_case(&marker.sha256) {
        return Ok(None);
    }
    let identity = match identity_runner(&paths.engine) {
        Ok(identity) => identity,
        Err(_) => return Ok(None),
    };
    if identity_matches_marker(&identity, &marker).is_err() {
        return Ok(None);
    }
    Ok(Some(ValidatedInstallation { version, marker }))
}

fn validate_existing(paths: &InstallPaths) -> Result<Option<ValidatedInstallation>, String> {
    validate_existing_with(paths, &run_identity)
}

fn acquire_install_lock(path: &Path, timeout: Duration) -> Result<InstallLock, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    let started = Instant::now();
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(InstallLock { file }),
            Err(error) if started.elapsed() < timeout => {
                let contended = error.kind() == std::io::ErrorKind::WouldBlock
                    || matches!(error.raw_os_error(), Some(32 | 33));
                if !contended {
                    return Err(error.to_string());
                }
                std::thread::sleep(INSTALL_LOCK_RETRY);
            }
            Err(error) => {
                return Err(format!("Verrou d'installation Sync indisponible: {error}"));
            }
        }
    }
}

fn unique_staging_path(directory: &Path, suffix: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = STAGING_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    directory.join(format!(
        "dofus-companion-sync.{}.{}.{}.staging.{suffix}",
        std::process::id(),
        nonce,
        sequence
    ))
}

fn write_staging(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    Ok(())
}

#[cfg(windows)]
fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
fn replace_file(
    destination: &Path,
    replacement: &Path,
    backup: Option<&Path>,
) -> Result<(), String> {
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let destination = wide_path(destination);
    let replacement = wide_path(replacement);
    let backup_wide = backup.map(wide_path);
    let backup_ptr = backup_wide
        .as_ref()
        .map_or(std::ptr::null(), |value| value.as_ptr());
    let result = unsafe {
        ReplaceFileW(
            destination.as_ptr(),
            replacement.as_ptr(),
            backup_ptr,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if result == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn move_file_write_through(source: &Path, destination: &Path) -> Result<(), String> {
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    let source = wide_path(source);
    let destination = wide_path(destination);
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(
    _destination: &Path,
    _replacement: &Path,
    _backup: Option<&Path>,
) -> Result<(), String> {
    Err("L'activation atomique du moteur Sync est actuellement Windows-only".to_string())
}

#[cfg(not(windows))]
fn move_file_write_through(_source: &Path, _destination: &Path) -> Result<(), String> {
    Err("L'activation atomique du moteur Sync est actuellement Windows-only".to_string())
}

fn activate_engine(paths: &InstallPaths, staging: &Path) -> Result<ActivationKind, String> {
    if paths.engine.exists() {
        if paths.previous.exists() {
            return Err(format!(
                "Backup Sync existant à examiner avant remplacement: {}",
                paths.previous.display()
            ));
        }
        replace_file(&paths.engine, staging, Some(&paths.previous))?;
        Ok(ActivationKind::Replacement)
    } else {
        move_file_write_through(staging, &paths.engine)?;
        Ok(ActivationKind::FirstInstall)
    }
}

fn recover_interrupted_activation_with<F>(
    paths: &InstallPaths,
    identity_runner: &F,
) -> Result<(), String>
where
    F: Fn(&Path) -> Result<EngineIdentity, String>,
{
    if !paths.previous.exists() {
        return Ok(());
    }
    if validate_existing_with(paths, identity_runner)?.is_some() {
        std::fs::remove_file(&paths.previous).map_err(|error| error.to_string())?;
        return Ok(());
    }
    if paths.engine.exists() {
        replace_file(&paths.engine, &paths.previous, None)
    } else {
        move_file_write_through(&paths.previous, &paths.engine)
    }
}

fn rollback_activation(paths: &InstallPaths, activation: ActivationKind) -> Result<(), String> {
    match activation {
        ActivationKind::Unchanged => {}
        ActivationKind::FirstInstall => {
            if paths.engine.exists() {
                std::fs::remove_file(&paths.engine).map_err(|error| error.to_string())?;
            }
        }
        ActivationKind::Replacement => {
            if !paths.previous.exists() {
                return Err("Rollback Sync impossible: backup .previous absent".to_string());
            }
            replace_file(&paths.engine, &paths.previous, None)?;
        }
    }
    Ok(())
}

fn write_marker_atomic(path: &Path, marker: &EngineMarkerV2) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Dossier marker Sync introuvable".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let staging = unique_staging_path(parent, "json");
    let bytes = serde_json::to_vec_pretty(marker).map_err(|error| error.to_string())?;
    write_staging(&staging, &bytes)?;
    let result = if path.exists() {
        replace_file(path, &staging, None)
    } else {
        move_file_write_through(&staging, path)
    };
    if result.is_err() && staging.exists() {
        let _ = std::fs::remove_file(&staging);
    }
    result
}

fn install_candidate_with<F>(
    paths: &InstallPaths,
    candidate: &Candidate,
    identity_runner: &F,
) -> Result<InstallReport, String>
where
    F: Fn(&Path) -> Result<EngineIdentity, String>,
{
    validate_bytes(&candidate.bytes, &candidate.manifest)?;
    std::fs::create_dir_all(&paths.install_root).map_err(|error| error.to_string())?;
    let _lock = acquire_install_lock(&paths.install_lock, INSTALL_LOCK_TIMEOUT)?;
    recover_interrupted_activation_with(paths, identity_runner)?;
    let candidate_version = validate_manifest(&candidate.manifest)?;
    if let Some(installed) = validate_existing_with(paths, identity_runner)? {
        if installed.version > candidate_version
            || (installed.version == candidate_version
                && installed
                    .marker
                    .sha256
                    .eq_ignore_ascii_case(&candidate.manifest.sha256))
        {
            return Ok(InstallReport {
                activation: ActivationKind::Unchanged,
                marker_written: false,
            });
        }
    }
    let staging = unique_staging_path(&paths.install_root, "exe");
    write_staging(&staging, &candidate.bytes)?;
    let install_result = (|| {
        validate_file(&staging, &candidate.manifest)?;
        let staging_identity = identity_runner(&staging)?;
        identity_matches_manifest(&staging_identity, &candidate.manifest)?;

        let activation = activate_engine(paths, &staging)?;
        let activated_identity = match identity_runner(&paths.engine) {
            Ok(identity) => identity,
            Err(error) => {
                let rollback = rollback_activation(paths, activation);
                return Err(match rollback {
                    Ok(()) => format!("Handshake Sync en échec, rollback effectué: {error}"),
                    Err(rollback_error) => format!(
                        "Handshake Sync en échec ({error}) et rollback en échec ({rollback_error})"
                    ),
                });
            }
        };
        if let Err(error) = identity_matches_manifest(&activated_identity, &candidate.manifest) {
            let rollback = rollback_activation(paths, activation);
            return Err(match rollback {
                Ok(()) => format!("Handshake Sync incompatible, rollback effectué: {error}"),
                Err(rollback_error) => format!(
                    "Handshake Sync incompatible ({error}) et rollback en échec ({rollback_error})"
                ),
            });
        }

        let marker = marker_from_manifest(&candidate.manifest, candidate.source);
        if let Err(error) = write_marker_atomic(&paths.marker, &marker) {
            let rollback = rollback_activation(paths, activation);
            return Err(match rollback {
                Ok(()) => format!("Marker Sync v2 non écrit, rollback effectué: {error}"),
                Err(rollback_error) => format!(
                    "Marker Sync v2 non écrit ({error}) et rollback en échec ({rollback_error})"
                ),
            });
        }

        if activation == ActivationKind::Replacement && paths.previous.exists() {
            let _ = std::fs::remove_file(&paths.previous);
        }
        Ok(InstallReport {
            activation,
            marker_written: true,
        })
    })();

    if staging.exists() {
        let _ = std::fs::remove_file(&staging);
    }
    install_result
}

fn install_candidate(paths: &InstallPaths, candidate: &Candidate) -> Result<InstallReport, String> {
    install_candidate_with(paths, candidate, &run_identity)
}

fn resolve_bundled_resource(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    [PathBuf::from(name), PathBuf::from("resources").join(name)]
        .into_iter()
        .filter_map(|relative| {
            app.path()
                .resolve(relative, tauri::path::BaseDirectory::Resource)
                .ok()
        })
        .find(|path| path.exists())
        .ok_or_else(|| format!("Ressource Sync embarquée introuvable: {name}"))
}

fn load_bundled_candidate(app: &tauri::AppHandle) -> Result<Candidate, String> {
    let engine_path = resolve_bundled_resource(app, SYNC_ENGINE_ASSET_NAME)?;
    let manifest_path = resolve_bundled_resource(app, SYNC_ENGINE_MANIFEST_NAME)?;
    let manifest =
        parse_manifest(&std::fs::read(manifest_path).map_err(|error| error.to_string())?)?;
    let bytes = std::fs::read(engine_path).map_err(|error| error.to_string())?;
    validate_bytes(&bytes, &manifest)?;
    Ok(Candidate {
        manifest,
        source: InstallSource::Bundled,
        bytes,
    })
}

async fn fetch_remote_descriptor(
    client: &reqwest::Client,
) -> Result<RemoteCandidateDescriptor, String> {
    let release_bytes = client
        .get(SYNC_ENGINE_RELEASE_API)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .bytes()
        .await
        .map_err(|error| error.to_string())?;
    let release: GitHubRelease =
        serde_json::from_slice(&release_bytes).map_err(|error| error.to_string())?;
    let manifest_asset = release
        .assets
        .iter()
        .find(|asset| asset.name == RELEASE_MANIFEST_ASSET_NAME)
        .ok_or_else(|| "manifest.json absent de la release Sync".to_string())?;
    let manifest_bytes = client
        .get(&manifest_asset.browser_download_url)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .bytes()
        .await
        .map_err(|error| error.to_string())?;
    let manifest = parse_manifest(&manifest_bytes)?;
    if release.tag_name != format!("v{}", manifest.engine_version) {
        return Err(format!(
            "Tag Sync {} différent du moteur {}",
            release.tag_name, manifest.engine_version
        ));
    }
    let binary_url = release
        .assets
        .iter()
        .find(|asset| asset.name == manifest.asset_name)
        .map(|asset| asset.browser_download_url.clone())
        .ok_or_else(|| format!("{} absent de la release Sync", manifest.asset_name))?;
    Ok(RemoteCandidateDescriptor {
        manifest,
        binary_url,
    })
}

async fn download_remote_candidate(
    client: &reqwest::Client,
    descriptor: RemoteCandidateDescriptor,
) -> Result<Candidate, String> {
    let bytes = client
        .get(&descriptor.binary_url)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .bytes()
        .await
        .map_err(|error| error.to_string())?
        .to_vec();
    validate_bytes(&bytes, &descriptor.manifest)?;
    Ok(Candidate {
        manifest: descriptor.manifest,
        source: InstallSource::Github,
        bytes,
    })
}

fn remote_is_useful(
    remote: &DistributionManifest,
    bundled: &DistributionManifest,
    existing: Option<&ValidatedInstallation>,
) -> Result<bool, String> {
    let remote_version = validate_manifest(remote)?;
    let bundled_version = validate_manifest(bundled)?;
    let best_local = existing
        .map(|installed| installed.version.clone())
        .unwrap_or(bundled_version);
    Ok(remote_version > best_local)
}

fn emit_engine_warning(app: &tauri::AppHandle, error: &str) {
    let _ = app.emit(
        "shared-sync-event",
        serde_json::json!({
            "kind": "message",
            "message": format!("Moteur commun GitHub indisponible, ressource vérifiée conservée ({error})")
        })
        .to_string(),
    );
}

pub(crate) async fn ensure_engine(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let paths = InstallPaths::production()?;
    let bundled = load_bundled_candidate(app)?;
    let existing_paths = paths.clone();
    let existing = tauri::async_runtime::spawn_blocking(move || validate_existing(&existing_paths))
        .await
        .map_err(|error| error.to_string())??;

    let client = reqwest::Client::builder()
        .user_agent("DofusCompanionApps/2.0")
        .build()
        .map_err(|error| error.to_string())?;
    let mut selected = bundled;
    match fetch_remote_descriptor(&client).await {
        Ok(descriptor) => {
            if remote_is_useful(&descriptor.manifest, &selected.manifest, existing.as_ref())? {
                match download_remote_candidate(&client, descriptor).await {
                    Ok(candidate) => selected = candidate,
                    Err(error) => emit_engine_warning(app, &error),
                }
            }
        }
        Err(error) => emit_engine_warning(app, &error),
    }

    let selected_version = validate_manifest(&selected.manifest)?;
    if let Some(installed) = &existing {
        if installed.version > selected_version
            || (installed.version == selected_version
                && installed
                    .marker
                    .sha256
                    .eq_ignore_ascii_case(&selected.manifest.sha256))
        {
            return Ok(paths.engine);
        }
    }

    let install_paths = paths.clone();
    tauri::async_runtime::spawn_blocking(move || install_candidate(&install_paths, &selected))
        .await
        .map_err(|error| error.to_string())??;
    Ok(paths.engine)
}

pub(crate) fn run_engine<F>(
    engine: PathBuf,
    app_name: String,
    force: bool,
    on_stdout: F,
) -> Result<(), String>
where
    F: Fn(String) + Send + Sync + 'static,
{
    let mut command = hidden_command(&engine);
    command.args(["sync", "--app", &app_name]);
    if force {
        command.arg("--force");
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Sortie moteur indisponible".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Erreur moteur indisponible".to_string())?;

    let on_stdout = Arc::new(on_stdout);
    let stdout_callback = Arc::clone(&on_stdout);
    let stdout_thread = std::thread::spawn(move || -> Result<(), String> {
        for line in std::io::BufReader::new(stdout).lines() {
            stdout_callback(line.map_err(|error| error.to_string())?);
        }
        Ok(())
    });
    let stderr_thread = std::thread::spawn(move || -> Result<String, String> {
        let mut diagnostic = String::new();
        std::io::BufReader::new(stderr)
            .read_to_string(&mut diagnostic)
            .map_err(|error| error.to_string())?;
        Ok(diagnostic)
    });

    let status = child.wait().map_err(|error| error.to_string())?;
    stdout_thread
        .join()
        .map_err(|_| "Thread stdout Sync interrompu".to_string())??;
    let diagnostic = stderr_thread
        .join()
        .map_err(|_| "Thread stderr Sync interrompu".to_string())??;
    if status.success() {
        if !diagnostic.trim().is_empty() {
            log::warn!("DofusCompanionSync stderr: {}", diagnostic.trim());
        }
        Ok(())
    } else if diagnostic.trim().is_empty() {
        Err(format!("DofusCompanionSync a quitté avec le code {status}"))
    } else {
        Err(diagnostic.trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;

    fn fixture_paths() -> (PathBuf, PathBuf) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        (
            root.join(SYNC_ENGINE_ASSET_NAME),
            root.join(SYNC_ENGINE_MANIFEST_NAME),
        )
    }

    fn fixture_candidate() -> Candidate {
        let (engine, manifest) = fixture_paths();
        let manifest = parse_manifest(&std::fs::read(manifest).unwrap()).unwrap();
        let bytes = std::fs::read(engine).unwrap();
        Candidate {
            manifest,
            source: InstallSource::Bundled,
            bytes,
        }
    }

    fn expected_identity() -> EngineIdentity {
        EngineIdentity {
            engine_version: "0.2.0".to_string(),
            protocol_version: 1,
            catalog_schema_version: 2,
            sync_manifest_schema_version: 5,
        }
    }

    fn temp_paths(temp: &tempfile::TempDir) -> InstallPaths {
        InstallPaths::new(temp.path().join("data"), temp.path().join("install"))
    }

    #[test]
    fn bundled_manifest_is_valid_and_exact() {
        let candidate = fixture_candidate();
        assert_eq!(candidate.manifest.engine_version, "0.2.0");
        assert_eq!(candidate.manifest.protocol_version, 1);
        assert_eq!(candidate.manifest.catalog_schema_version, 2);
        assert_eq!(candidate.manifest.sync_manifest_schema_version, 5);
        assert_eq!(candidate.manifest.size, 4_734_464);
        assert_eq!(
            candidate.manifest.sha256.to_ascii_uppercase(),
            "62A0B03C14B65CDEB1BF6D52481D36D950778531A75EAF832BC18FED53A2BA13"
        );
        validate_bytes(&candidate.bytes, &candidate.manifest).unwrap();
    }

    #[test]
    fn incorrect_sha_is_rejected() {
        let mut candidate = fixture_candidate();
        candidate.manifest.sha256 = "0".repeat(64);
        assert!(validate_bytes(&candidate.bytes, &candidate.manifest).is_err());
    }

    #[test]
    fn incorrect_size_is_rejected() {
        let mut candidate = fixture_candidate();
        candidate.manifest.size += 1;
        assert!(validate_bytes(&candidate.bytes, &candidate.manifest).is_err());
    }

    #[test]
    fn incorrect_target_is_rejected() {
        let mut manifest = fixture_candidate().manifest;
        manifest.target = "aarch64-pc-windows-msvc".to_string();
        assert!(validate_manifest(&manifest).is_err());
    }

    #[test]
    fn unsupported_protocol_is_rejected() {
        let mut manifest = fixture_candidate().manifest;
        manifest.protocol_version = 2;
        assert!(validate_manifest(&manifest).is_err());
    }

    #[test]
    fn unknown_distribution_manifest_version_is_rejected() {
        let mut manifest = fixture_candidate().manifest;
        manifest.manifest_version = 2;
        assert!(validate_manifest(&manifest).is_err());
    }

    #[test]
    fn semver_comparison_is_not_numeric_homebrew() {
        assert!(Version::parse("0.10.0").unwrap() > Version::parse("0.2.9").unwrap());
        assert!(Version::parse("1.0.0-beta.2").unwrap() < Version::parse("1.0.0").unwrap());
        assert!(Version::parse("not-a-version").is_err());
    }

    #[test]
    fn legacy_marker_is_never_trusted() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("engine-version.json");
        std::fs::write(&marker, br#"{"version":"0.1.0","source":"bundled"}"#).unwrap();
        assert_eq!(read_marker_state(&marker), MarkerState::Legacy);
    }

    #[test]
    fn valid_v2_marker_round_trips() {
        let temp = tempfile::tempdir().unwrap();
        let paths = temp_paths(&temp);
        let candidate = fixture_candidate();
        let marker = marker_from_manifest(&candidate.manifest, InstallSource::Bundled);
        write_marker_atomic(&paths.marker, &marker).unwrap();
        assert_eq!(read_marker_state(&paths.marker), MarkerState::Valid(marker));
    }

    #[test]
    fn marker_hash_different_from_engine_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let paths = temp_paths(&temp);
        std::fs::create_dir_all(&paths.install_root).unwrap();
        let candidate = fixture_candidate();
        std::fs::write(&paths.engine, &candidate.bytes).unwrap();
        let mut marker = marker_from_manifest(&candidate.manifest, InstallSource::Bundled);
        marker.sha256 = "0".repeat(64);
        std::fs::create_dir_all(paths.marker.parent().unwrap()).unwrap();
        std::fs::write(&paths.marker, serde_json::to_vec(&marker).unwrap()).unwrap();
        assert!(validate_existing_with(&paths, &|_| Ok(expected_identity()))
            .unwrap()
            .is_none());
    }

    #[test]
    fn canonical_staging_identity_is_valid() {
        let temp = tempfile::tempdir().unwrap();
        let candidate = fixture_candidate();
        let staging = temp.path().join("candidate.exe");
        write_staging(&staging, &candidate.bytes).unwrap();
        let identity = run_identity(&staging).unwrap();
        identity_matches_manifest(&identity, &candidate.manifest).unwrap();
    }

    #[test]
    fn initial_install_writes_marker_after_handshake() {
        let temp = tempfile::tempdir().unwrap();
        let paths = temp_paths(&temp);
        let candidate = fixture_candidate();
        let report = install_candidate(&paths, &candidate).unwrap();
        assert_eq!(report.activation, ActivationKind::FirstInstall);
        assert!(report.marker_written);
        assert!(paths.engine.exists());
        assert!(matches!(
            read_marker_state(&paths.marker),
            MarkerState::Valid(_)
        ));
    }

    #[test]
    fn replacement_uses_and_cleans_previous_backup_after_success() {
        let temp = tempfile::tempdir().unwrap();
        let paths = temp_paths(&temp);
        std::fs::create_dir_all(&paths.install_root).unwrap();
        std::fs::write(&paths.engine, b"legacy-engine").unwrap();
        let candidate = fixture_candidate();
        let report = install_candidate(&paths, &candidate).unwrap();
        assert_eq!(report.activation, ActivationKind::Replacement);
        assert!(!paths.previous.exists());
        validate_file(&paths.engine, &candidate.manifest).unwrap();
    }

    #[test]
    fn failed_final_handshake_rolls_back_and_does_not_write_marker() {
        let temp = tempfile::tempdir().unwrap();
        let paths = temp_paths(&temp);
        std::fs::create_dir_all(&paths.install_root).unwrap();
        let legacy = b"legacy-engine".to_vec();
        std::fs::write(&paths.engine, &legacy).unwrap();
        let candidate = fixture_candidate();
        let destination = paths.engine.clone();
        let result = install_candidate_with(&paths, &candidate, &|path| {
            if path == destination {
                Err("simulated final handshake failure".to_string())
            } else {
                Ok(expected_identity())
            }
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(&paths.engine).unwrap(), legacy);
        assert!(!paths.marker.exists());
    }

    #[test]
    fn failed_first_install_handshake_leaves_no_marker_or_engine() {
        let temp = tempfile::tempdir().unwrap();
        let paths = temp_paths(&temp);
        let candidate = fixture_candidate();
        let destination = paths.engine.clone();
        let result = install_candidate_with(&paths, &candidate, &|path| {
            if path == destination {
                Err("simulated final handshake failure".to_string())
            } else {
                Ok(expected_identity())
            }
        });
        assert!(result.is_err());
        assert!(!paths.engine.exists());
        assert!(!paths.marker.exists());
    }

    #[test]
    fn installer_never_deletes_another_operations_staging() {
        let temp = tempfile::tempdir().unwrap();
        let paths = temp_paths(&temp);
        std::fs::create_dir_all(&paths.install_root).unwrap();
        let foreign = paths
            .install_root
            .join("dofus-companion-sync.other-operation.staging.exe");
        std::fs::write(&foreign, b"foreign").unwrap();
        install_candidate(&paths, &fixture_candidate()).unwrap();
        assert_eq!(std::fs::read(foreign).unwrap(), b"foreign");
    }

    #[test]
    fn interrupted_replacement_is_recovered_before_retry() {
        let temp = tempfile::tempdir().unwrap();
        let paths = temp_paths(&temp);
        std::fs::create_dir_all(&paths.install_root).unwrap();
        let candidate = fixture_candidate();
        std::fs::write(&paths.engine, &candidate.bytes).unwrap();
        std::fs::write(&paths.previous, b"legacy-engine").unwrap();
        std::fs::create_dir_all(paths.marker.parent().unwrap()).unwrap();
        std::fs::write(&paths.marker, br#"{"version":"0.1.0","source":"bundled"}"#).unwrap();

        let report = install_candidate(&paths, &candidate).unwrap();
        assert_eq!(report.activation, ActivationKind::Replacement);
        validate_file(&paths.engine, &candidate.manifest).unwrap();
        assert!(!paths.previous.exists());
        assert!(matches!(
            read_marker_state(&paths.marker),
            MarkerState::Valid(_)
        ));
    }

    #[test]
    fn offline_selection_keeps_verified_bundled_candidate() {
        let bundled = fixture_candidate();
        assert!(!remote_is_useful(&bundled.manifest, &bundled.manifest, None).unwrap());
    }

    #[test]
    fn incompatible_remote_manifest_is_rejected_before_binary_download() {
        let bundled = fixture_candidate();
        let mut remote = bundled.manifest.clone();
        remote.protocol_version = 2;
        assert!(remote_is_useful(&remote, &bundled.manifest, None).is_err());
    }

    #[test]
    fn newer_compatible_existing_installation_is_not_downgraded() {
        let bundled = fixture_candidate();
        let mut marker = marker_from_manifest(&bundled.manifest, InstallSource::Github);
        marker.engine_version = "0.3.0".to_string();
        let existing = ValidatedInstallation {
            version: Version::parse("0.3.0").unwrap(),
            marker,
        };
        assert!(!remote_is_useful(&bundled.manifest, &bundled.manifest, Some(&existing)).unwrap());
    }

    #[test]
    fn install_lock_is_process_safe_and_reusable() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("engine-install.lock");
        let first = acquire_install_lock(&path, Duration::from_secs(1)).unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let child_path = path.clone();
        let child_barrier = Arc::clone(&barrier);
        let child = std::thread::spawn(move || {
            child_barrier.wait();
            acquire_install_lock(&child_path, Duration::from_millis(100)).is_err()
        });
        barrier.wait();
        assert!(child.join().unwrap());
        drop(first);
        assert!(acquire_install_lock(&path, Duration::from_secs(1)).is_ok());
    }

    #[test]
    fn concurrent_installations_have_one_activation_and_one_verified_noop() {
        let temp = tempfile::tempdir().unwrap();
        let paths = temp_paths(&temp);
        let candidate = fixture_candidate();
        let barrier = Arc::new(Barrier::new(3));
        let mut threads = Vec::new();
        for _ in 0..2 {
            let thread_paths = paths.clone();
            let thread_candidate = candidate.clone();
            let thread_barrier = Arc::clone(&barrier);
            threads.push(std::thread::spawn(move || {
                thread_barrier.wait();
                install_candidate(&thread_paths, &thread_candidate).unwrap()
            }));
        }
        barrier.wait();
        let reports: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(
            reports
                .iter()
                .filter(|report| report.activation == ActivationKind::FirstInstall)
                .count(),
            1
        );
        assert_eq!(
            reports
                .iter()
                .filter(|report| report.activation == ActivationKind::Unchanged)
                .count(),
            1
        );
        validate_file(&paths.engine, &candidate.manifest).unwrap();
        assert!(matches!(
            read_marker_state(&paths.marker),
            MarkerState::Valid(_)
        ));
    }

    #[test]
    fn test_installation_paths_are_fully_injected_under_temp() {
        let temp = tempfile::tempdir().unwrap();
        let paths = temp_paths(&temp);
        assert!(paths.install_root.starts_with(temp.path()));
        assert!(paths.engine.starts_with(temp.path()));
        assert!(paths.marker.starts_with(temp.path()));
        assert!(paths.install_lock.starts_with(temp.path()));
    }
}
