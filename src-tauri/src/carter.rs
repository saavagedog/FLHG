use winapi::um::memoryapi::{VirtualAllocEx, WriteProcessMemory};
use winapi::um::processthreadsapi::{CreateRemoteThread, OpenProcess};
use winapi::um::winnt::{MEM_COMMIT, MEM_RESERVE, PAGE_READWRITE, PROCESS_ALL_ACCESS};
use winapi::um::libloaderapi::{GetModuleHandleA, GetProcAddress};
use std::time::{Duration};
use std::sync::atomic::{AtomicU32, Ordering};
use std::os::windows::process::CommandExt;
use tauri::{AppHandle};
use winapi::shared::minwindef::FALSE;
use winapi::um::handleapi::CloseHandle;
use winapi::um::processthreadsapi::{OpenThread, SuspendThread};
use winapi::um::tlhelp32::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use winapi::um::debugapi::IsDebuggerPresent;
// use std::env;
use tauri::Manager;
use winapi::um::winnt::HANDLE;
use winapi::um::winnt::THREAD_SUSPEND_RESUME;

use sysinfo::System;

static PLAYER_GAME_PID: AtomicU32 = AtomicU32::new(0);

pub fn is_player_client_running() -> bool {
    let pid = PLAYER_GAME_PID.load(Ordering::SeqCst);
    if pid == 0 {
        return false;
    }

    let mut system = System::new_all();
    system.refresh_all();
    system.processes().keys().any(|process_id| process_id.as_u32() == pid)
}

pub fn close_player_client() -> Result<(), String> {
    let pid = PLAYER_GAME_PID.load(Ordering::SeqCst);
    if pid == 0 {
        return Err("No player game launched by this launcher is running.".to_string());
    }

    let mut system = System::new_all();
    system.refresh_all();
    let process = system.processes().iter().find_map(|(process_id, process)| {
        (process_id.as_u32() == pid).then_some(process)
    });

    match process {
        Some(process) if process.kill() => {
            PLAYER_GAME_PID.store(0, Ordering::SeqCst);
            Ok(())
        }
        _ => {
            PLAYER_GAME_PID.store(0, Ordering::SeqCst);
            Err("The player game process is no longer running.".to_string())
        }
    }
}

fn release_version_from_branch(branch: &str) -> Option<String> {
    let (_, suffix) = branch.split_once("Release-")?;
    let version: String = suffix
        .chars()
        .take_while(|character| character.is_ascii_digit() || *character == '.')
        .collect();
    let mut parts = version.split('.');
    let major = parts.next()?;
    let minor = parts.next()?;
    if !major.is_empty()
        && !minor.is_empty()
        && major.chars().all(|character| character.is_ascii_digit())
        && minor.chars().all(|character| character.is_ascii_digit())
        && parts.next().is_none()
    {
        Some(version)
    } else {
        None
    }
}

pub fn detect_fortnite_version(game_root: &str) -> Result<String, String> {
    let root = std::path::Path::new(game_root);
    for relative_path in ["FortniteGame/Build/Build.version", "Engine/Build/Build.version"] {
        let manifest_path = root.join(relative_path);
        let contents = match std::fs::read_to_string(&manifest_path) {
            Ok(contents) => contents,
            Err(_) => continue,
        };
        let manifest: serde_json::Value = serde_json::from_str(&contents)
            .map_err(|_| format!("Could not read build metadata at {}.", manifest_path.display()))?;
        let Some(branch) = manifest.get("BranchName").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(version) = release_version_from_branch(branch) else {
            continue;
        };
        return Ok(version);
    }

    Err("Could not detect the Fortnite version from Build.version metadata.".to_string())
}

#[tauri::command]
pub fn get_fortnite_version(game_root: String) -> Result<String, String> {
    detect_fortnite_version(&game_root)
}

#[cfg(test)]
mod version_tests {
    use super::{detect_fortnite_version, release_version_from_branch};
    use std::path::PathBuf;

    fn make_game_root(version: &str) -> (PathBuf, PathBuf) {
        let temp_root = std::env::temp_dir().join(format!("fishky-version-test-{}", uuid::Uuid::new_v4()));
        let game_root = temp_root.join("Game");
        let build_dir = game_root.join("FortniteGame").join("Build");
        std::fs::create_dir_all(&build_dir).unwrap();
        std::fs::write(
            build_dir.join("Build.version"),
            format!(r#"{{"BranchName":"++Fortnite+Release-{version}-CL-123"}}"#),
        ).unwrap();
        (temp_root, game_root)
    }

    #[test]
    fn parses_fortnite_release_branch_version() {
        assert_eq!(release_version_from_branch("++Fortnite+Release-13.40-CL-13715509"), Some("13.40".to_string()));
    }

    #[test]
    fn keeps_distinct_release_versions_distinct() {
        assert_eq!(release_version_from_branch("++Fortnite+Release-13.4-CL-1"), Some("13.4".to_string()));
        assert_eq!(release_version_from_branch("++Fortnite+Release-13.400-CL-1"), Some("13.400".to_string()));
        assert_eq!(release_version_from_branch("++Fortnite+Release-14.00-CL-1"), Some("14.00".to_string()));
    }

    #[test]
    fn rejects_branch_without_release_version() {
        assert_eq!(release_version_from_branch("++Fortnite+Main-CL-1"), None);
    }

    #[test]
    fn detects_installed_release_version_without_restricting_it() {
        let (temp_root, game_root) = make_game_root("13.40");
        assert_eq!(detect_fortnite_version(&game_root.to_string_lossy()).unwrap(), "13.40");
        std::fs::remove_dir_all(temp_root).unwrap();

        let (temp_root, game_root) = make_game_root("13.41");
        assert_eq!(detect_fortnite_version(&game_root.to_string_lossy()).unwrap(), "13.41");
        std::fs::remove_dir_all(temp_root).unwrap();
    }
}

pub fn security_check() -> bool {
    unsafe {
        if IsDebuggerPresent() != 0 {
            return false;
        }
    }
    true
}

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};

pub fn start_discord_rpc() {
    let app_id = std::env::var("VITE_DISCORD_CLIENT_ID").unwrap_or_default();
    let launcher_name = std::env::var("VITE_LAUNCHER_NAME").unwrap_or_else(|_| "Project Fishk".to_string());
    let discord_link = std::env::var("VITE_DISCORD_LINK").unwrap_or_default();

    tokio::spawn(async move {
        if app_id.is_empty() {
            println!("RPC Error: No Client ID found in environment.");
            return;
        }

        let mut client = DiscordIpcClient::new(&app_id).expect("Failed to create RPC client");
        
        loop {
            if client.connect().is_ok() {
                println!("Discord RPC Connected!");
                loop {
                    let details = format!("Playing {}", launcher_name);
                    let payload = activity::Activity::new()
                        .state("In Launcher")
                        .details(&details)
                        .assets(activity::Assets::new()
                            .large_image("logo")
                            .large_text(&launcher_name))
                        .buttons(vec![activity::Button::new("Join Discord", &discord_link)]);

                    if client.set_activity(payload).is_err() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    });
}

const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn kill() {
    let mut system = System::new_all();
    system.refresh_all();

    let processes = vec![
        "EpicGamesLauncher.exe",
        "FortniteLauncher.exe",
        "FortniteClient-Win64-Shipping_EAC.exe",
        "FortniteClient-Win64-Shipping_BE.exe",
        "FortniteClient-Win64-Shipping.exe",
        "EasyAntiCheat_EOS.exe",
        "EpicWebHelper.exe",
    ];

    for process in processes.iter() {
        let cmd = std::process::Command::new("cmd")
            .creation_flags(CREATE_NO_WINDOW)
            .args(&["/C", "taskkill", "/F", "/IM", process])
            .spawn();

        if cmd.is_err() {
            return;
        }
    }

    std::thread::sleep(std::time::Duration::from_millis(10));
}

pub fn kill_epic() {
    let cmd = std::process::Command::new("cmd")
        .creation_flags(CREATE_NO_WINDOW)
        .args(&["/C", "taskkill /F /IM", "EpicGamesLauncher.exe"])
        .spawn();

    if cmd.is_err() {
        return;
    }

    std::thread::sleep(std::time::Duration::from_millis(10));
}

pub async fn download(url: &str, filename: &str, path: &str, window: &tauri::Window) -> Result<(), String> {
    let trimmed_url = url.trim();
    if trimmed_url.is_empty() {
        return Err("Download URL is empty. Configure a valid DLL URL before launching.".to_string());
    }

    let safe_filename = if filename.trim().is_empty() {
        trimmed_url.rsplit('/').next().unwrap_or("download.bin")
    } else {
        filename
    };

    println!("Downloading {} from: {}", safe_filename, trimmed_url);

    let full_url = if trimmed_url.ends_with('/') {
        format!("{}{}", trimmed_url, safe_filename)
    } else {
        trimmed_url.to_string()
    };

    let response = reqwest::get(&full_url)
        .await
        .map_err(|e| format!("Network error while fetching {}: {}", safe_filename, e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed for {}: {}", safe_filename, response.status()));
    }

    let _ = window.emit("update-status", format!("Downloading: {}", safe_filename));

    let parent = std::path::Path::new(path).parent().unwrap_or_else(|| std::path::Path::new("."));
    if !parent.exists() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create parent directory {}: {}", parent.display(), e))?;
    }

    let content = response.bytes().await.map_err(|e| format!("Failed to read response for {}: {}", safe_filename, e))?;
    std::fs::write(path, content).map_err(|e| format!("File Error while writing {}: {}", path, e))?;
    
    Ok(())
}

fn get_pak_drop_folder() -> Result<std::path::PathBuf, String> {
    let documents = dirs::document_dir().ok_or("Could not locate your Documents folder")?;
    let folder = documents.join("Project Fishk").join("Paks");
    std::fs::create_dir_all(&folder).map_err(|error| format!("Could not create PAK folder: {error}"))?;
    Ok(folder)
}

fn copy_paks_from_folder(game_root: &str, source_folder: &std::path::Path) -> Result<usize, String> {
    let paks_path = std::path::Path::new(game_root)
        .join("FortniteGame")
        .join("Content")
        .join("Paks");
    std::fs::create_dir_all(&paks_path).map_err(|error| format!("Could not access the game's Paks folder: {error}"))?;

    let entries = std::fs::read_dir(source_folder)
        .map_err(|error| format!("Could not read PAK folder {}: {error}", source_folder.display()))?;
    let mut copied = 0;

    for entry in entries {
        let entry = entry.map_err(|error| format!("Could not read a file in the PAK folder: {error}"))?;
        if !entry.file_type().map_err(|error| error.to_string())?.is_file() {
            continue;
        }

        let source = entry.path();
        let extension = source.extension().and_then(std::ffi::OsStr::to_str).unwrap_or("");
        if !extension.eq_ignore_ascii_case("pak") && !extension.eq_ignore_ascii_case("sig") {
            continue;
        }

        let filename = entry.file_name();
        let target = paks_path.join(filename);
        if target.exists() {
            continue;
        }

        std::fs::copy(&source, &target).map_err(|error| {
            format!("Could not copy {} into the game Paks folder: {error}", source.display())
        })?;
        copied += 1;
    }

    Ok(copied)
}

pub fn sync_paks_from_folder(game_root: &str) -> Result<usize, String> {
    let source_folder = get_pak_drop_folder()?;
    copy_paks_from_folder(game_root, &source_folder)
}

#[tauri::command]
pub fn open_pak_drop_folder_cmd() -> Result<String, String> {
    let folder = get_pak_drop_folder()?;
    std::process::Command::new("explorer.exe")
        .arg(&folder)
        .spawn()
        .map_err(|error| format!("Could not open PAK folder: {error}"))?;
    Ok(folder.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn sync_paks_cmd(game_root: String) -> Result<usize, String> {
    sync_paks_from_folder(&game_root)
}

const BUBBLE_PAK_URL: &str = "https://github.com/saavagedog/PAKS/raw/refs/heads/main/pakchunkBubble-WindowsClient_P.pak";
const BUBBLE_SIG_URL: &str = "https://github.com/saavagedog/SIG/raw/refs/heads/main/pakchunkBubble-WindowsClient_P.sig";

fn remove_bubble_build_files(game_root: &std::path::Path) -> Result<(), String> {
    let paks_path = game_root.join("FortniteGame").join("Content").join("Paks");
    for filename in ["pakchunkBubble-WindowsClient_P.pak", "pakchunkBubble-WindowsClient_P.sig"] {
        match std::fs::remove_file(paks_path.join(filename)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Could not remove {}: {}", filename, error)),
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn set_bubble_builds_cmd(game_roots: Vec<String>, enabled: bool, app: AppHandle) -> Result<(), String> {
    use tauri::Manager;

    if game_roots.is_empty() {
        return Err("Add a Fortnite build before changing Bubble Builds.".to_string());
    }

    for game_root in game_roots {
        let root = std::path::PathBuf::from(game_root);
        if !enabled {
            remove_bubble_build_files(&root)?;
            continue;
        }

        let paks_path = root.join("FortniteGame").join("Content").join("Paks");
        std::fs::create_dir_all(&paks_path).map_err(|error| error.to_string())?;
        let window = app.get_window("main").ok_or("Main window not found")?;

        for (url, filename) in [
            (BUBBLE_SIG_URL, "pakchunkBubble-WindowsClient_P.sig"),
            (BUBBLE_PAK_URL, "pakchunkBubble-WindowsClient_P.pak"),
        ] {
            let target_path = paks_path.join(filename);
            if target_path.exists() {
                continue;
            }
            let target = target_path.to_str().ok_or("Invalid Bubble Builds destination path")?;
            download(url, filename, target, &window).await?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod bubble_build_tests {
    use super::remove_bubble_build_files;

    #[test]
    fn removes_only_bubble_files_and_ignores_missing_files() {
        let root = std::env::temp_dir().join(format!("fishky-bubble-test-{}", uuid::Uuid::new_v4()));
        let paks = root.join("FortniteGame").join("Content").join("Paks");
        std::fs::create_dir_all(&paks).unwrap();
        let bubble_pak = paks.join("pakchunkBubble-WindowsClient_P.pak");
        let bubble_sig = paks.join("pakchunkBubble-WindowsClient_P.sig");
        let other_pak = paks.join("pakchunkOther-WindowsClient.pak");
        std::fs::write(&bubble_pak, b"pak").unwrap();
        std::fs::write(&bubble_sig, b"sig").unwrap();
        std::fs::write(&other_pak, b"other").unwrap();

        remove_bubble_build_files(&root).unwrap();
        remove_bubble_build_files(&root).unwrap();

        assert!(!bubble_pak.exists());
        assert!(!bubble_sig.exists());
        assert!(other_pak.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}

pub fn suspend_process(pid: u32) -> (u32, bool) {
    unsafe {
        let mut has_err = false;
        let mut count: u32 = 0;

        let te: &mut THREADENTRY32 = &mut std::mem::zeroed();
        (*te).dwSize = std::mem::size_of::<THREADENTRY32>() as u32;

        let snapshot: HANDLE = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);

        if Thread32First(snapshot, te) == 1 {
            loop {
                if pid == (*te).th32OwnerProcessID {
                    let tid = (*te).th32ThreadID;

                    let thread: HANDLE = OpenThread(THREAD_SUSPEND_RESUME, FALSE, tid);
                    has_err |= SuspendThread(thread) as i32 == -1i32;

                    CloseHandle(thread);
                    count += 1;
                }

                if Thread32Next(snapshot, te) == 0 {
                    break;
                }
            }
        }

        CloseHandle(snapshot);

        (count, has_err)
    }
}

pub fn is_process_suspended(pid: u32) -> bool {
    unsafe {
        let mut is_suspended = true;

        let te: &mut THREADENTRY32 = &mut std::mem::zeroed();
        (*te).dwSize = std::mem::size_of::<THREADENTRY32>() as u32;

        let snapshot: HANDLE = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);

        if Thread32First(snapshot, te) == 1 {
            loop {
                if pid == (*te).th32OwnerProcessID {
                    let tid = (*te).th32ThreadID;

                    let thread: HANDLE = OpenThread(THREAD_SUSPEND_RESUME, FALSE, tid);
                    let suspend_count = SuspendThread(thread) as i32;

                    if suspend_count == -1i32 {
                        is_suspended = false;
                    } else {
                        is_suspended &= suspend_count > 0;
                    }

                    CloseHandle(thread);
                }

                if Thread32Next(snapshot, te) == 0 {
                    break;
                }
            }
        }

        CloseHandle(snapshot);

        is_suspended
    }
}

pub async fn launch_real_launcher(root: &str) -> Result<bool, String> {
    println!("Launching real launcher at path: {}", root);

    let base = std::path::PathBuf::from(root);
    let mut resource_path = base.clone();
    resource_path.push("FortniteGame\\Binaries\\Win64\\FortniteLauncher.exe");

    println!("Launcher path: {:?}", resource_path);

    let mut cwd = std::path::PathBuf::from(root);
    cwd.push("FortniteGame\\Binaries\\Win64");

    println!("Current directory for launcher: {:?}", cwd);

    kill_epic();
    println!("Killed Epic process.");

    let cmd = std::process::Command::new(resource_path.clone())
        .creation_flags(CREATE_NO_WINDOW | 0x00000004)
        .current_dir(cwd)
        .spawn();

    if cmd.is_err() {
        println!("Failed to launch '{}'", resource_path.to_str().unwrap());
        return Err(format!(
            "Failed to launch '{}'",
            resource_path.to_str().unwrap()
        ));
    }

    let pid = cmd.unwrap().id();
    println!("Launched process with PID: {}", pid);

    while !is_process_suspended(pid.clone()) {
        let (_, _) = suspend_process(pid.clone());
        println!("Suspended process with PID: {}", pid);
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    kill_epic();
    Ok(true)
}

#[tauri::command]
pub async fn dll_replace(path: &str, url: String, _app: tauri::AppHandle) -> Result<bool, String> {
    use tauri::Manager;

    let trimmed_url = url.trim();
    if trimmed_url.is_empty() {
        println!("DLL replacement skipped: no valid redirect URL configured.");
        return Ok(true);
    }
    
    let path_buf = std::path::PathBuf::from(path);
    let mut nvidia_path = path_buf.clone();
    nvidia_path.push("Engine\\Binaries\\ThirdParty\\NVIDIA\\NVaftermath\\Win64\\GFSDK_Aftermath_Lib.x64.dll");

    if nvidia_path.exists() {
        let _ = std::fs::remove_file(&nvidia_path);
    }

    let window = _app.get_window("main").ok_or("Main window not found")?;
    let target_str = nvidia_path.to_str().unwrap();

    if let Err(err) = download(trimmed_url, "GFSDK_Aftermath_Lib.x64.dll", target_str, &window).await {
        eprintln!("DLL replacement failed: {}", err);
        return Ok(false);
    }

    Ok(true)
}

pub fn inject_dll(pid: u32, dll_path: &str) -> Result<(), String> {
    unsafe {
        let handle = OpenProcess(PROCESS_ALL_ACCESS, FALSE, pid);
        if handle.is_null() { return Err("Failed to open process".into()); }

        let path_null = format!("{}\0", dll_path);
        let bytes = path_null.as_bytes();
        
        let mem = VirtualAllocEx(handle, std::ptr::null_mut(), bytes.len(), MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        WriteProcessMemory(handle, mem, bytes.as_ptr() as *const _, bytes.len(), std::ptr::null_mut());

        let k32 = GetModuleHandleA("kernel32.dll\0".as_ptr() as *const i8);
        let load_lib = GetProcAddress(k32, "LoadLibraryA\0".as_ptr() as *const i8);

        CreateRemoteThread(handle, std::ptr::null_mut(), 0, Some(std::mem::transmute(load_lib)), mem, 0, std::ptr::null_mut());
        
        CloseHandle(handle);
        Ok(())
    }

}

pub async fn launch_fn(
    path: &str,
    redirect_url: String, 
    inject_urls: String,
    app: AppHandle,
    email: String,
    password: String,
    eor: bool,
    stretch_resolution_enabled: bool,
    resolution_width: u32,
    resolution_height: u32,
) -> Result<bool, String> {
    sync_paks_from_folder(path)?;

    if let Err(e) = dll_replace(path, redirect_url, app.clone()).await {
        return Err(format!("Could not replace DLL: {}", e));
    }

    let base = std::path::PathBuf::from(path);

    let mut fort_ac_path = base.clone();
    fort_ac_path.push("FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping_EAC.exe");
    if !fort_ac_path.exists() {
        return Err("FortniteClient-Win64-Shipping_EAC.exe not found".to_string());
    }

    let mut fort_ac_cwd = base.clone();
    fort_ac_cwd.push("FortniteGame\\Binaries\\Win64");
    let _ = std::process::Command::new(fort_ac_path)
        .creation_flags(CREATE_NO_WINDOW | 0x00000004)
        .current_dir(fort_ac_cwd)
        .spawn();

    let _ = launch_real_launcher(base.to_str().unwrap()).await?;

    let mut fort_binary = base.clone();
    fort_binary.push("FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe");
    
    let auth_email = format!("-AUTH_LOGIN={}", email);
    let auth_password = format!("-AUTH_PASSWORD={}", password);

    let mut fort_args = vec![
        "-epicapp=Fortnite".to_string(),
        "-epicenv=Prod".to_string(),
        "-epiclocale=en-us".to_string(),
        "-epicportal".to_string(),
        "-nouac".to_string(),
        "-skippatchcheck".to_string(),
        "-nobe".to_string(),
        "-fromfl=eac".to_string(),
        "-fltoken=3db3ba5dcbd2e16703f3978d".to_string(),
        "-caldera=eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50X2lkIjoiYmU5ZGE1YzJmYmVhNDQwN2IyZjQwZWJhYWQ4NTlhZDQiLCJnZW5lcmF0ZWQiOjE2Mzg3MTcyNzgsImNhbGRlcmFHdWlkIjoiMzgxMGI4NjMtMmE2NS00NDU3LTliNTgtNGRhYjNiNDgyYTg2IiwiYWNQcm92aWRlciI6IkVhc3lBbnRpQ2hlYXQiLCJub3RlcyI6IiIsImZhbGxiYWNrIjpmYWxzZX0.VAWQB67RTxhiWOxx7DBjnzDnXyyEnX7OljJm-j2d88G_WgwQ9wrE6lwMEHZHjBd1ISJdUO1UVUqkfLdU5nofBQ".to_string(),
        "-AUTH_TYPE=epic".to_string(),
    ];

    if eor {
        fort_args.push("-eor".to_string());
    }
    if stretch_resolution_enabled {
        if !(640..=7680).contains(&resolution_width) || !(480..=4320).contains(&resolution_height) {
            return Err("Stretch resolution must be between 640x480 and 7680x4320.".to_string());
        }
        fort_args.push(format!("-ResX={resolution_width}"));
        fort_args.push(format!("-ResY={resolution_height}"));
        fort_args.push("-Fullscreen".to_string());
    }
    fort_args.push(auth_email);
    fort_args.push(auth_password);

    let fort_cmd = std::process::Command::new(&fort_binary)
        .creation_flags(CREATE_NO_WINDOW)
        .args(&fort_args) 
        .spawn()
        .map_err(|e| format!("Failed to spawn Fortnite: {}", e))?;

    let pid = fort_cmd.id();
    PLAYER_GAME_PID.store(pid, Ordering::SeqCst);

    tokio::time::sleep(Duration::from_secs(60)).await;

    if !inject_urls.is_empty() {
        let window = app.get_window("main").ok_or("No window")?;
        tokio::time::sleep(Duration::from_secs(10)).await;

        for url in inject_urls.split(',') {
            let url = url.trim();
            if url.is_empty() { continue; }
            
            let filename = url.split('/').last().unwrap_or("inject.dll");
            let temp_path = std::env::temp_dir().join(filename);
            let temp_path_str = temp_path.to_str().ok_or("Invalid temp path")?;

            download(url, filename, temp_path_str, &window).await?;
            
            let _ = inject_dll(pid, temp_path_str);
        }
    }

    println!("Fortnite launched and DLLs injected successfully.");
    Ok(true)

    
}

    #[tauri::command]
    pub async fn download_build_cmd(destination: String, app: tauri::AppHandle) -> Result<String, String> {
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;
        use std::time::Instant;
        use tauri::Manager;

        let window = app.get_window("main").ok_or("Main window not found")?;
        let url = std::env::var("FORTFORGE_BUILD_DOWNLOAD_URL")
            .map_err(|_| "Build download is not configured. Add FORTFORGE_BUILD_DOWNLOAD_URL to .env.".to_string())?;
        let destination = std::path::PathBuf::from(destination);
        if !destination.is_dir() {
            return Err("Choose an existing destination folder.".to_string());
        }

        let install_dir = destination.join(format!("FortForge Build {}", &uuid::Uuid::new_v4().to_string()[..8]));
        let archive_path = std::env::temp_dir().join(format!("fortforge-build-{}.zip", uuid::Uuid::new_v4()));
        let _ = window.emit("build-download-start", true);
        let _ = window.emit("update-status", "Connecting to build host...");

        let download_result: Result<(), String> = async {
            let response = reqwest::Client::new()
                .get(&url)
                .send()
                .await
                .map_err(|error| format!("Could not connect to the build host: {error}"))?;
            if !response.status().is_success() {
                return Err(format!("Build download failed: HTTP {}", response.status()));
            }

            let total_bytes = response.content_length();
            let mut stream = response.bytes_stream();
            let mut archive = tokio::fs::File::create(&archive_path)
                .await
                .map_err(|error| format!("Could not create temporary archive: {error}"))?;
            let started = Instant::now();
            let mut downloaded_bytes = 0_u64;
            let mut last_event = Instant::now();
            let _ = window.emit("update-status", "Downloading build...");

            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|error| format!("Download interrupted: {error}"))?;
                archive.write_all(&chunk).await.map_err(|error| format!("Could not write downloaded data: {error}"))?;
                downloaded_bytes += chunk.len() as u64;

                if last_event.elapsed().as_millis() >= 250 {
                    let elapsed = started.elapsed().as_secs_f64().max(0.001);
                    let bytes_per_second = (downloaded_bytes as f64 / elapsed) as u64;
                    let percent = total_bytes
                        .filter(|total| *total > 0)
                        .map(|total| ((downloaded_bytes.saturating_mul(100) / total).min(100)) as u8)
                        .unwrap_or(0);
                    let eta_seconds = total_bytes.and_then(|total| {
                        (bytes_per_second > 0).then_some(total.saturating_sub(downloaded_bytes) / bytes_per_second)
                    });
                    let _ = window.emit("build-download-progress", serde_json::json!({
                        "percent": percent,
                        "downloadedBytes": downloaded_bytes,
                        "totalBytes": total_bytes,
                        "bytesPerSecond": bytes_per_second,
                        "etaSeconds": eta_seconds,
                    }));
                    last_event = Instant::now();
                }
            }

            archive.flush().await.map_err(|error| format!("Could not finish downloaded archive: {error}"))?;
            if downloaded_bytes == 0 {
                return Err("The build host returned an empty file.".to_string());
            }
            Ok(())
        }.await;

        if let Err(error) = download_result {
            let _ = std::fs::remove_file(&archive_path);
            let _ = window.emit("build-download-error", &error);
            return Err(error);
        }

        let _ = window.emit("update-status", "Extracting build archive...");
        let _ = window.emit("build-download-progress", serde_json::json!({
            "percent": 100,
            "downloadedBytes": 0,
            "totalBytes": null,
            "bytesPerSecond": 0,
            "etaSeconds": null,
        }));
        let archive_for_extract = archive_path.clone();
        let install_for_extract = install_dir.clone();
        let extraction_task_result = tokio::task::spawn_blocking(move || -> Result<std::path::PathBuf, String> {
            std::fs::create_dir_all(&install_for_extract).map_err(|error| format!("Could not create build folder: {error}"))?;
            let file = std::fs::File::open(&archive_for_extract).map_err(|error| format!("Could not open downloaded archive: {error}"))?;
            let mut zip = zip::ZipArchive::new(file).map_err(|error| format!("Downloaded file is not a valid ZIP archive: {error}"))?;
            zip.extract(&install_for_extract).map_err(|error| format!("Could not extract build archive: {error}"))?;

            if install_for_extract.join("Engine").is_dir() {
                return Ok(install_for_extract);
            }

            let entries = std::fs::read_dir(&install_for_extract).map_err(|error| error.to_string())?;
            for entry in entries.flatten() {
                if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) && entry.path().join("Engine").is_dir() {
                    return Ok(entry.path());
                }
            }
            Err("The archive extracted, but no Fortnite Engine folder was found.".to_string())
        }).await;
        let _ = std::fs::remove_file(&archive_path);
        let extraction_result = extraction_task_result.map_err(|error| format!("Build extraction task failed: {error}"))?;

        match extraction_result {
            Ok(build_path) => {
                let path = build_path.to_string_lossy().to_string();
                let _ = window.emit("build-download-complete", &path);
                Ok(path)
            }
            Err(error) => {
                let _ = std::fs::remove_dir_all(&install_dir);
                let _ = window.emit("build-download-error", &error);
                Err(error)
            }
        }
    }

    #[cfg(test)]
    mod pak_folder_tests {
        use super::copy_paks_from_folder;

        #[test]
        fn copies_only_pak_and_sig_files_without_overwriting_existing_files() {
            let root = std::env::temp_dir().join(format!("fishky-pak-folder-test-{}", uuid::Uuid::new_v4()));
            let drop_folder = root.join("drop");
            let game_root = root.join("game");
            let target_folder = game_root.join("FortniteGame").join("Content").join("Paks");
            std::fs::create_dir_all(&drop_folder).unwrap();
            std::fs::create_dir_all(&target_folder).unwrap();
            std::fs::write(drop_folder.join("custom.pak"), b"pak-data").unwrap();
            std::fs::write(drop_folder.join("custom.sig"), b"sig-data").unwrap();
            std::fs::write(drop_folder.join("readme.txt"), b"ignore").unwrap();
            std::fs::write(target_folder.join("existing.pak"), b"original").unwrap();
            std::fs::write(drop_folder.join("existing.pak"), b"replacement").unwrap();

            let copied = copy_paks_from_folder(game_root.to_str().unwrap(), &drop_folder).unwrap();

            assert_eq!(copied, 2);
            assert_eq!(std::fs::read(target_folder.join("custom.pak")).unwrap(), b"pak-data");
            assert_eq!(std::fs::read(target_folder.join("custom.sig")).unwrap(), b"sig-data");
            assert_eq!(std::fs::read(target_folder.join("existing.pak")).unwrap(), b"original");
            assert!(!target_folder.join("readme.txt").exists());
            std::fs::remove_dir_all(root).unwrap();
        }
    }
