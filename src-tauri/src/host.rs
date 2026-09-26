use crate::carter;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const CREATE_NO_WINDOW: u32 = 0x08000000;
const CREATE_SUSPENDED: u32 = 0x00000004;
const ERBIUM_INJECTION_DELAY: Duration = Duration::from_secs(60);
const HOST_RESTART_DELAY: Duration = Duration::from_secs(10);

static HOST_RUNNING: AtomicBool = AtomicBool::new(false);
static HOST_STOP_REQUESTED: AtomicBool = AtomicBool::new(false);
static HOST_GAME_PID: AtomicU32 = AtomicU32::new(0);

fn emit_status(app: &AppHandle, message: &str) {
    let _ = app.emit_all("host-status", message.to_string());
}

fn emit_error(app: &AppHandle, message: &str) {
    let _ = app.emit_all("host-error", message.to_string());
}

fn spawn_suspended(executable: &Path, working_directory: &Path) -> Result<Option<Child>, String> {
    if !executable.is_file() {
        return Ok(None);
    }

    Command::new(executable)
        .current_dir(working_directory)
        .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED)
        .spawn()
        .map(Some)
        .map_err(|error| format!("Could not start {}: {error}", executable.display()))
}

fn stop_child(child: &mut Option<Child>) {
    if let Some(child) = child.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
    }
    *child = None;
}

fn stop_host_process(pid: u32) {
    if pid == 0 {
        return;
    }

    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

#[tauri::command]
pub fn is_erbium_host_running() -> bool {
    HOST_RUNNING.load(Ordering::SeqCst)
}

#[tauri::command]
pub fn stop_erbium_host() {
    HOST_STOP_REQUESTED.store(true, Ordering::SeqCst);
    stop_host_process(HOST_GAME_PID.load(Ordering::SeqCst));
}

#[tauri::command]
pub fn start_erbium_host(
    game_root: String,
    email: String,
    password: String,
    erbium_dll_path: String,
    app: AppHandle,
) -> Result<(), String> {
    let game_root = PathBuf::from(game_root);
    let erbium_dll = PathBuf::from(erbium_dll_path);
    let binaries = game_root.join("FortniteGame").join("Binaries").join("Win64");
    let game_executable = binaries.join("FortniteClient-Win64-Shipping.exe");

    if !game_executable.is_file() {
        return Err("The selected build is missing FortniteClient-Win64-Shipping.exe.".to_string());
    }
    let game_version = carter::detect_fortnite_version(&game_root.to_string_lossy())?;
    if game_version != "13.40" {
        return Err(format!("This Erbium build is configured for Fortnite 13.40, but the selected build is {game_version}."));
    }
    if !erbium_dll.is_file() {
        return Err("Select a built Erbium.dll file before starting the host.".to_string());
    }
    if email.trim().is_empty() || password.is_empty() {
        return Err("Sign in to the launcher before starting an Erbium host.".to_string());
    }
    if HOST_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("The Erbium host is already running.".to_string());
    }

    HOST_STOP_REQUESTED.store(false, Ordering::SeqCst);
    if let Err(error) = carter::sync_paks_from_folder(&game_root.to_string_lossy(), &app) {
        HOST_RUNNING.store(false, Ordering::SeqCst);
        return Err(error);
    }

    let worker_app = app.clone();
    thread::spawn(move || {
        if let Err(error) = run_host_supervisor(game_root, email, password, erbium_dll, worker_app.clone()) {
            emit_error(&worker_app, &error);
        }
        HOST_GAME_PID.store(0, Ordering::SeqCst);
        HOST_RUNNING.store(false, Ordering::SeqCst);
        if HOST_STOP_REQUESTED.swap(false, Ordering::SeqCst) {
            emit_status(&worker_app, "Host stopped.");
        }
    });

    emit_status(&app, "Preparing Erbium host...");
    Ok(())
}

fn run_host_supervisor(
    game_root: PathBuf,
    email: String,
    password: String,
    erbium_dll: PathBuf,
    app: AppHandle,
) -> Result<(), String> {
    let binaries = game_root.join("FortniteGame").join("Binaries").join("Win64");
    let game_executable = binaries.join("FortniteClient-Win64-Shipping.exe");
    let eac_executable = binaries.join("FortniteClient-Win64-Shipping_EAC.exe");
    let launcher_executable = binaries.join("FortniteLauncher.exe");

    loop {
        if HOST_STOP_REQUESTED.load(Ordering::SeqCst) {
            return Ok(());
        }

        emit_status(&app, "Starting Fortnite host...");
        let mut eac_process = spawn_suspended(&eac_executable, &binaries)?;
        let mut launcher_process = spawn_suspended(&launcher_executable, &binaries)?;
        carter::kill_epic();

        let launch_result = Command::new(&game_executable)
            .current_dir(&binaries)
            .args([
                "-epicapp=Fortnite",
                "-epicenv=Prod",
                "-epiclocale=en-us",
                "-epicportal",
                "-nouac",
                "-skippatchcheck",
                "-nobe",
                "-fromfl=eac",
                "-fltoken=3db3ba5dcbd2e16703f3978d",
                "-caldera=eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50X2lkIjoiYmU5ZGE1YzJmYmVhNDQwN2IyZjQwZWJhYWQ4NTlhZDQiLCJnZW5lcmF0ZWQiOjE2Mzg3MTcyNzgsImNhbGRlcmFHdWlkIjoiMzgxMGI4NjMtMmE2NS00NDU3LTliNTgtNGRhYjNiNDgyYTg2IiwiYWNQcm92aWRlciI6IkVhc3lBbnRpQ2hlYXQiLCJub3RlcyI6IiIsImZhbGxiYWNrIjpmYWxzZX0.VAWQB67RTxhiWOxx7DBjnzDnXyyEnX7OljJm-j2d88G_WgwQ9wrE6lwMEHZHjBd1ISJdUO1UVUqkfLdU5nofBQ",
                "-AUTH_TYPE=epic",
                "-log",
                "-nosplash",
                "-nosound",
            ])
            .arg(format!("-AUTH_LOGIN={email}"))
            .arg(format!("-AUTH_PASSWORD={password}"))
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();

        let mut game_process = match launch_result {
            Ok(process) => process,
            Err(error) => {
                stop_child(&mut launcher_process);
                stop_child(&mut eac_process);
                return Err(format!("Could not start Fortnite host: {error}"));
            }
        };
        let pid = game_process.id();
        HOST_GAME_PID.store(pid, Ordering::SeqCst);
        emit_status(&app, "Waiting for Fortnite to load before injecting Erbium...");

        let started_at = Instant::now();
        let mut injected = false;
        let exit_status: ExitStatus;

        loop {
            if HOST_STOP_REQUESTED.load(Ordering::SeqCst) {
                stop_host_process(pid);
                let _ = game_process.wait();
                HOST_GAME_PID.store(0, Ordering::SeqCst);
                stop_child(&mut launcher_process);
                stop_child(&mut eac_process);
                return Ok(());
            }

            match game_process.try_wait() {
                Ok(Some(status)) => {
                    exit_status = status;
                    break;
                }
                Ok(None) => {}
                Err(error) => {
                    stop_host_process(pid);
                    let _ = game_process.wait();
                    HOST_GAME_PID.store(0, Ordering::SeqCst);
                    stop_child(&mut launcher_process);
                    stop_child(&mut eac_process);
                    return Err(format!("Could not monitor Fortnite host: {error}"));
                }
            }

            if !injected && started_at.elapsed() >= ERBIUM_INJECTION_DELAY {
                if let Err(error) = carter::inject_dll(pid, &erbium_dll.to_string_lossy()) {
                    stop_host_process(pid);
                    let _ = game_process.wait();
                    HOST_GAME_PID.store(0, Ordering::SeqCst);
                    stop_child(&mut launcher_process);
                    stop_child(&mut eac_process);
                    return Err(format!("Could not inject Erbium.dll: {error}"));
                }
                injected = true;
                emit_status(&app, "Erbium injected. Host is running.");
            }

            thread::sleep(Duration::from_millis(500));
        }

        HOST_GAME_PID.store(0, Ordering::SeqCst);
        stop_child(&mut launcher_process);
        stop_child(&mut eac_process);

        if HOST_STOP_REQUESTED.load(Ordering::SeqCst) {
            return Ok(());
        }
        if !injected {
            return Err("Fortnite exited before Erbium could be injected. Check the Fortnite build and login.".to_string());
        }
        if !exit_status.success() {
            return Err(format!("Fortnite host exited with status {exit_status}; automatic restart stopped."));
        }

        emit_status(&app, "Match ended. Restarting the Erbium host in 10 seconds...");
        let restart_at = Instant::now() + HOST_RESTART_DELAY;
        while Instant::now() < restart_at {
            if HOST_STOP_REQUESTED.load(Ordering::SeqCst) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(250));
        }
    }
}