#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{io::{BufRead, BufReader}, process::Stdio, path::PathBuf};
use tauri::{AppHandle, Manager};

#[tauri::command]
async fn export_video(
    app: AppHandle,
    fps: u32,
    width: u32,
    height: u32,
    aspect: String,
    quality: String,
    include_audio: bool,
    frames_dir: String,
    output_path: String,
    pix_fmt: Option<String>,
) -> Result<(), String> {
    // Mapear calidad
    let (crf, vb, preset) = match quality.as_str() {
        "alta" => ("12", "20M", "slow"),
        "media" => ("18", "10M", "medium"),
        "baja" => ("23", "5M", "faster"),
        _ => ("18", "10M", "medium"),
    };

    let pix = pix_fmt.unwrap_or_else(|| "yuv420p".to_string());

    // Patrón de entrada de frames
    let mut input_pattern = PathBuf::from(&frames_dir);
    input_pattern.push("%04d.png");

    // Construir comando ffmpeg
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.arg("-y")
        .arg("-r").arg(fps.to_string())
        .arg("-f").arg("image2")
        .arg("-s").arg(format!("{}x{}", width, height))
        .arg("-i").arg(input_pattern.to_string_lossy().to_string());

    if include_audio {
        // Si hay audio.wav en frames_dir, usarlo
        let mut audio_path = PathBuf::from(&frames_dir);
        audio_path.push("audio.wav");
        cmd.arg("-i").arg(audio_path.to_string_lossy().to_string());
        cmd.arg("-c:a").arg("aac");
    }

    cmd.arg("-c:v").arg("libx264")
        .arg("-pix_fmt").arg(pix)
        .arg("-preset").arg(preset)
        .arg("-crf").arg(crf)
        .arg("-b:v").arg(vb)
        .arg("-movflags").arg("+faststart")
        .arg(&output_path)
        .stderr(Stdio::piped())
        .stdout(Stdio::null());

    let mut child = cmd.spawn().map_err(|e| format!("ffmpeg spawn: {e}"))?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let reader = BufReader::new(stderr);
    let window = app.get_webview_window("main").ok_or("no window")?;

    // Leer stderr y emitir progreso
    for line in reader.lines() {
        if let Ok(l) = line {
            // ffmpeg imprime "frame= ... time=00:00:05.12 ... fps= ..." etc.
            let _ = window.emit("export:log", &l);
            // Se puede parsear tiempo aproximado
            if l.contains("time=") {
                let _ = window.emit("export:progress", &l);
            }
        }
    }

    let status = child.wait().map_err(|e| format!("ffmpeg wait: {e}"))?;
    if !status.success() {
        return Err(format!("ffmpeg exit code: {:?}", status.code()));
    }

    // Limpieza de frames (best-effort)
    if let Err(e) = clean_frames_dir(frames_dir.clone()) {
        let _ = window.emit("export:log", format!("cleanup error: {e}"));
    }

    Ok(())
}

fn clean_frames_dir(dir: String) -> Result<(), String> {
    let p = PathBuf::from(dir);
    if !p.exists() { return Ok(()); }
    for entry in std::fs::read_dir(&p).map_err(|e| format!("read_dir: {e}"))? {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let path = entry.path();
        if path.is_file() {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![export_video])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
