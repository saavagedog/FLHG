#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::env;
use std::fs::create_dir_all;
use tauri::{AppHandle, Manager, Window};
mod carter;
mod host;
use dotenvy::dotenv;

#[tauri::command]
fn close_launcher(app: tauri::AppHandle) {
    host::stop_erbium_host();
    app.exit(0);
}

#[tauri::command]
fn window_minimize(window: Window) {
    window.minimize().unwrap();
}

#[tauri::command]
async fn firstlaunch(
    path: String,
    app: AppHandle,
    email: String,
    password: String,
    eor: bool,
    stretch_resolution_enabled: bool,
    resolution_width: u32,
    resolution_height: u32,
) -> Result<bool, String> {
    if let Ok(version) = carter::detect_fortnite_version(&path) {
        println!("Detected Fortnite {version} build at {path}");
    }
    if !carter::security_check() {
        return Err("Security violation: Debugger detected. Please close UUU or x64dbg.".to_string());
    }

    carter::kill();
    carter::kill_epic();

    let dll_url = env::var("VITE_REDIRECT_LINK").unwrap_or_default();
    let inject_dlls = env::var("VITE_INJECT_DLLS_LINKS").unwrap_or_default();

    if dll_url.trim().is_empty() && inject_dlls.trim().is_empty() {
        println!("Launcher startup: no valid DLL replacement or injection URL configured, skipping DLL patch step.");
    }

    carter::launch_fn(
        &path,
        dll_url,
        inject_dlls,
        app,
        email,
        password,
        eor,
        stretch_resolution_enabled,
        resolution_width,
        resolution_height,
    ).await
}

#[tauri::command]
fn is_fortnite_client_running() -> bool {
    carter::is_player_client_running()
}

#[tauri::command]
fn close_fortnite_client() -> Result<(), String> {
    carter::close_player_client()
}

#[tauri::command]
fn window_close(window: Window) {
    window.close().unwrap();
}

#[tokio::main]
async fn main() {
    let env_content = include_str!("../../.env");
    for line in env_content.lines() {
        if line.starts_with('#') || line.trim().is_empty() { continue; }
        if let Some((key, value)) = line.split_once('=') {
            let clean_value = value.trim().trim_matches('"');
            std::env::set_var(key.trim(), clean_value);
        }
    }
    dotenv().ok();

    carter::start_discord_rpc();
    
    let app_name = env::var("VITE_LAUNCHER_NAME").unwrap_or_else(|_| "Project Fishk".to_string());
    let path = format!("C:\\Program Files\\{}", app_name);

    if let Err(e) = create_dir_all(&path) {
        eprintln!("Error creating directory: {}", e);
    }

    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_window("main").unwrap();
            window.on_window_event(|event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    carter::kill(); 
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window_minimize,
            window_close,
            firstlaunch,
            is_fortnite_client_running,
            close_fortnite_client,
            close_launcher,
            carter::get_fortnite_version,
            carter::sync_paks_cmd,
            carter::open_pak_drop_folder_cmd,
            carter::set_bubble_builds_cmd,
            carter::download_build_cmd
            ,host::start_erbium_host,
            host::stop_erbium_host,
            host::is_erbium_host_running
        ])
        .run(tauri::generate_context!())
        .expect("Error starting the app");
}