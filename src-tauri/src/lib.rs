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
    .invoke_handler(tauri::generate_handler![http_get, open_external_url, read_clipboard])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
