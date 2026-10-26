#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, ContextMenu, Menu, MenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{
    App, AppHandle, Listener, LogicalSize, Manager, PhysicalPosition, WebviewUrl,
    WebviewWindowBuilder, Wry,
};
use tauri_runtime::ResizeDirection;

const PET_LABEL: &str = "pet";
const SETTINGS_LABEL: &str = "settings";
const SUBTITLE_LABEL: &str = "subtitle";
const CHAT_LABEL: &str = "chat";
const DEFAULT_STAGE: &str =
    "http://127.0.0.1:3080/plugins/dsh-dstuber/stage/index.html?bg=none";
const BASE_WIDTH: f64 = 380.0;
const BASE_HEIGHT: f64 = 500.0;
// The WebView2 client is ~28px taller than the requested logical height on
// Windows for this frameless window; 72 gives a 100px-visible input bar.
const CHAT_HEIGHT: f64 = 72.0;

fn context(step: &str, error: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, format!("{step}: {error}"))
}

fn data_directory() -> PathBuf {
    std::env::var("DSH_DSTUBER_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("dsh-dstuber-webview2"))
}

fn closed_flag() -> PathBuf {
    data_directory().join("closed")
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetSettings {
    scale: f64,
    reduced_motion: bool,
    always_on_top: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetSettingsInput {
    scale: Option<f64>,
    reduced_motion: Option<bool>,
    always_on_top: Option<bool>,
}

struct UiState(Mutex<PetSettings>);

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubtitleSettings {
    visible: bool,
    snap: bool,
    semi_transparent: bool,
    side: String,
    width: f64,
    height: f64,
    font_size: f64,
    background_opacity: f64,
    text: String,
}

impl Default for SubtitleSettings {
    fn default() -> Self {
        Self {
            visible: true,
            snap: true,
            semi_transparent: true,
            side: "auto".to_string(),
            width: 350.0,
            height: 100.0,
            font_size: 16.0,
            background_opacity: 0.72,
            text: String::new(),
        }
    }
}

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubtitleSettingsInput {
    visible: Option<bool>,
    snap: Option<bool>,
    semi_transparent: Option<bool>,
    side: Option<String>,
    width: Option<f64>,
    height: Option<f64>,
    font_size: Option<f64>,
    background_opacity: Option<f64>,
    text: Option<String>,
}

struct SubtitleState(Mutex<SubtitleSettings>);

struct SubtitleResizeState(AtomicU64);

struct SubtitleMenuState {
    menu: Menu<Wry>,
    visible: CheckMenuItem<Wry>,
    snap: CheckMenuItem<Wry>,
    background: CheckMenuItem<Wry>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatSettings {
    visible: bool,
    snap: bool,
    side: String,
    width: f64,
    always_on_top: bool,
    follow_subtitle: bool,
}

impl Default for ChatSettings {
    fn default() -> Self {
        Self {
            visible: true,
            snap: true,
            side: "auto".to_string(),
            width: 350.0,
            always_on_top: true,
            follow_subtitle: true,
        }
    }
}

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatSettingsInput {
    visible: Option<bool>,
    snap: Option<bool>,
    side: Option<String>,
    width: Option<f64>,
    always_on_top: Option<bool>,
    follow_subtitle: Option<bool>,
}

struct ChatState(Mutex<ChatSettings>);

struct ChatResizeState(AtomicU64);

struct ChatMenuState {
    menu: Menu<Wry>,
    visible: CheckMenuItem<Wry>,
    snap: CheckMenuItem<Wry>,
    follow: CheckMenuItem<Wry>,
    topmost: CheckMenuItem<Wry>,
}

#[allow(dead_code)]
struct TrayState(TrayIcon<Wry>);

fn tray_icon() -> Image<'static> {    // A tiny original icon: blue circle on transparent RGBA.
    let size = 32u32;
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    for y in 0..size {
        for x in 0..size {
            let dx = x as i32 - (size / 2) as i32;
            let dy = y as i32 - (size / 2) as i32;
            if dx * dx + dy * dy <= 14 * 14 {
                let index = ((y * size + x) * 4) as usize;
                rgba[index] = 0x7c;
                rgba[index + 1] = 0xc7;
                rgba[index + 2] = 0xff;
                rgba[index + 3] = 0xff;
            }
        }
    }
    Image::new_owned(rgba, size, size)
}

fn apply_scale(app: &AppHandle, state: &UiState, scale: f64) -> Result<(), String> {
    let scale = scale.clamp(0.6, 1.4);
    let pet = app
        .get_webview_window(PET_LABEL)
        .ok_or_else(|| "pet window is missing".to_string())?;
    pet.set_size(LogicalSize::new(BASE_WIDTH * scale, BASE_HEIGHT * scale))
        .map_err(|error| error.to_string())?;
    // Nudge the stage: the WebView resize event can lag one frame behind the
    // native window size, so ask it to re-fit explicitly as well.
    let _ = pet.eval("window.__pet && window.__pet.relayout()");

    // Keep the resized window inside the monitor's work area.
    if let Ok(Some(monitor)) = pet.current_monitor() {
        let work = monitor.work_area();
        if let (Ok(position), Ok(size)) = (pet.outer_position(), pet.outer_size()) {
            let max_x = (work.position.x + work.size.width as i32 - size.width as i32)
                .max(work.position.x);
            let max_y = (work.position.y + work.size.height as i32 - size.height as i32)
                .max(work.position.y);
            let x = position.x.clamp(work.position.x, max_x);
            let y = position.y.clamp(work.position.y, max_y);
            if x != position.x || y != position.y {
                let _ = pet.set_position(PhysicalPosition::new(x, y));
            }
        }
    }

    state.0.lock().unwrap().scale = scale;
    Ok(())
}

fn apply_reduced(
    app: &AppHandle,
    state: &UiState,
    reduced: bool,
) -> Result<(), String> {
    let pet = app
        .get_webview_window(PET_LABEL)
        .ok_or_else(|| "pet window is missing".to_string())?;
    let script = format!(
        "window.__pet && window.__pet.setReducedMotion({})",
        reduced
    );
    pet.eval(&script).map_err(|error| error.to_string())?;
    state.0.lock().unwrap().reduced_motion = reduced;
    Ok(())
}

fn apply_always_on_top(app: &AppHandle, state: &UiState, enabled: bool) -> Result<(), String> {
    let pet = app
        .get_webview_window(PET_LABEL)
        .ok_or_else(|| "pet window is missing".to_string())?;
    pet.set_always_on_top(enabled).map_err(|error| error.to_string())?;
    // The subtitle and chat windows float above the pet; they must follow the
    // same switch, otherwise "not on top" still leaves them above other apps.
    for label in [SUBTITLE_LABEL, CHAT_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.set_always_on_top(enabled);
        }
    }
    // Keep the chat window's own topmost flag in sync so reopening it does not
    // silently restore always-on-top.
    if let Some(chat_state) = app.try_state::<ChatState>() {
        chat_state.0.lock().unwrap().always_on_top = enabled;
    }
    state.0.lock().unwrap().always_on_top = enabled;
    Ok(())
}

fn show_pet(app: &AppHandle) -> Result<(), String> {
    let pet = app
        .get_webview_window(PET_LABEL)
        .ok_or_else(|| "pet window is missing".to_string())?;
    pet.show().map_err(|error| error.to_string())?;
    let _ = pet.set_focus();
    Ok(())
}

fn hide_pet(app: &AppHandle) -> Result<(), String> {
    let pet = app
        .get_webview_window(PET_LABEL)
        .ok_or_else(|| "pet window is missing".to_string())?;
    pet.hide().map_err(|error| error.to_string())
}

fn open_url(url: &str) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn open_webui() -> Result<(), String> {
    open_url("http://127.0.0.1:3080/")
}

fn quit_app(app: &AppHandle) {
    let _ = std::fs::write(closed_flag(), "1");
    app.exit(0);
}

fn show_settings(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        let was_visible = window.is_visible().unwrap_or(false);
        let _ = position_settings(app);
        if !was_visible {
            let _ = window.show();
        }
        let _ = window.set_focus();
        return Ok(());
    }

    let settings_data_dir = data_directory().join("settings");
    std::fs::create_dir_all(&settings_data_dir)
        .map_err(|error| context("create settings data directory", error).to_string())?;

    let window = WebviewWindowBuilder::new(
        app,
        SETTINGS_LABEL,
        WebviewUrl::App("settings.html".into()),
    )
    .title("DS Tuber 设置")
    .inner_size(440.0, 680.0)
    .min_inner_size(420.0, 540.0)
    .resizable(true)
    .decorations(true)
    .always_on_top(false)
    .skip_taskbar(false)
    .visible(false)
    .data_directory(settings_data_dir)
    .build()
    .map_err(|error| context("create settings window", error).to_string())?;

    // Build hidden, move beside the pet while still hidden, then reveal once.
    // Showing first and moving afterwards produces a top-left flash.
    let _ = position_settings(app);
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

/// Place the settings window next to the pet without covering it, choosing
/// the side with the most free work-area space.
fn position_settings(app: &AppHandle) -> Result<(), String> {
    let pet = app
        .get_webview_window(PET_LABEL)
        .ok_or_else(|| "pet window is missing".to_string())?;
    let settings = app
        .get_webview_window(SETTINGS_LABEL)
        .ok_or_else(|| "settings window is missing".to_string())?;

    let pet_pos = pet.outer_position().map_err(|error| error.to_string())?;
    let pet_size = pet.outer_size().map_err(|error| error.to_string())?;
    let raw = settings.outer_size().map_err(|error| error.to_string())?;

    let monitor = match pet.current_monitor().map_err(|error| error.to_string())? {
        Some(monitor) => monitor,
        None => pet
            .primary_monitor()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "no monitor for pet window".to_string())?,
    };
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let gap = (8.0 * scale).round() as i32;

    let wx = work.position.x;
    let wy = work.position.y;
    let ww = work.size.width as i32;
    let wh = work.size.height as i32;
    let px = pet_pos.x;
    let py = pet_pos.y;
    let pw = pet_size.width as i32;
    let ph = pet_size.height as i32;
    let nw = if raw.width == 0 {
        (460.0 * scale).round() as i32
    } else {
        raw.width as i32
    };
    let nh = if raw.height == 0 {
        (720.0 * scale).round() as i32
    } else {
        raw.height as i32
    };

    let free_left = px - wx;
    let free_right = wx + ww - (px + pw);
    let free_above = py - wy;
    let free_below = wy + wh - (py + ph);
    let candidates = [
        (free_left, nw, px - nw - gap, py),
        (free_right, nw, px + pw + gap, py),
        (free_above, nh, px, py - nh - gap),
        (free_below, nh, px, py + ph + gap),
    ];

    let mut chosen: Option<(i32, i32, i32)> = None;
    for (free, need, x, y) in candidates {
        if free < need + gap {
            continue;
        }
        if chosen.map_or(true, |(best, _, _)| free > best) {
            chosen = Some((free, x, y));
        }
    }
    let (x, y) = match chosen {
        Some((_, x, y)) => (x, y),
        None => {
            let mut fallback = (free_left, px - nw - gap, py);
            for candidate in [
                (free_right, px + pw + gap, py),
                (free_above, px, py - nh - gap),
                (free_below, px, py + ph + gap),
            ] {
                if candidate.0 > fallback.0 {
                    fallback = candidate;
                }
            }
            (fallback.1, fallback.2)
        }
    };

    let max_x = (wx + ww - nw).max(wx);
    let max_y = (wy + wh - nh).max(wy);
    settings
        .set_position(PhysicalPosition::new(
            x.clamp(wx, max_x),
            y.clamp(wy, max_y),
        ))
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn normalize_side(side: &str) -> String {
    match side {
        "top" | "bottom" | "left" | "right" => side.to_string(),
        _ => "auto".to_string(),
    }
}

fn resize_direction(value: &str) -> Option<ResizeDirection> {
    match value {
        "n" => Some(ResizeDirection::North),
        "ne" => Some(ResizeDirection::NorthEast),
        "e" => Some(ResizeDirection::East),
        "se" => Some(ResizeDirection::SouthEast),
        "s" => Some(ResizeDirection::South),
        "sw" => Some(ResizeDirection::SouthWest),
        "w" => Some(ResizeDirection::West),
        "nw" => Some(ResizeDirection::NorthWest),
        _ => None,
    }
}

/// Subtitle limits are derived from the pet's monitor work area:
/// width <= 4/5 screen, height <= 1/2 screen. Values are logical pixels.
fn subtitle_limits(app: &AppHandle) -> (f64, f64) {
    let pet = app.get_webview_window(PET_LABEL);
    let monitor = pet
        .as_ref()
        .and_then(|window| window.current_monitor().ok().flatten())
        .or_else(|| {
            pet.as_ref()
                .and_then(|window| window.primary_monitor().ok().flatten())
        });
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let work = monitor.work_area();
        let max_width = (work.size.width as f64 / scale * 0.8).max(240.0);
        let max_height = (work.size.height as f64 / scale * 0.5).max(60.0);
        (max_width.round(), max_height.round())
    } else {
        (1365.0, 533.0)
    }
}

fn build_subtitle_menu(
    app: &AppHandle,
    settings: &SubtitleSettings,
) -> tauri::Result<(Menu<Wry>, CheckMenuItem<Wry>, CheckMenuItem<Wry>, CheckMenuItem<Wry>)> {
    let visible = CheckMenuItem::with_id(
        app,
        "subtitle-visible",
        "显示字幕",
        true,
        settings.visible,
        None::<&str>,
    )?;
    let snap = CheckMenuItem::with_id(
        app,
        "subtitle-snap",
        "吸附桌宠",
        true,
        settings.snap,
        None::<&str>,
    )?;
    let background = CheckMenuItem::with_id(
        app,
        "subtitle-background",
        "半透明背景",
        true,
        settings.semi_transparent,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&visible, &snap, &background])?;
    Ok((menu, visible, snap, background))
}

fn position_subtitle(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<SubtitleState>();
    let settings = state.0.lock().unwrap().clone();
    if !settings.visible || !settings.snap {
        return Ok(());
    }

    let pet = app
        .get_webview_window(PET_LABEL)
        .ok_or_else(|| "pet window is missing".to_string())?;
    let subtitle = app
        .get_webview_window(SUBTITLE_LABEL)
        .ok_or_else(|| "subtitle window is missing".to_string())?;

    let pet_pos = pet.outer_position().map_err(|error| error.to_string())?;
    let pet_size = pet.outer_size().map_err(|error| error.to_string())?;
    let raw = subtitle.outer_size().map_err(|error| error.to_string())?;

    let monitor = match pet.current_monitor().map_err(|error| error.to_string())? {
        Some(monitor) => monitor,
        None => pet
            .primary_monitor()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "no monitor for pet window".to_string())?,
    };
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    // The pet model is fitted to 94% of the window; the remaining margin is
    // transparent. Move the subtitle into that margin so the visual gap to the
    // model is ~2px instead of 8px measured from the window edge.
    let visual_gap = (2.0 * scale).round() as i32;

    let wx = work.position.x;
    let wy = work.position.y;
    let ww = work.size.width as i32;
    let wh = work.size.height as i32;
    let px = pet_pos.x;
    let py = pet_pos.y;
    let pw = pet_size.width as i32;
    let ph = pet_size.height as i32;
    let model_display = ((pw.min(ph) as f64) * 0.94).round() as i32;
    let v_margin = ((ph - model_display) / 2).max(0);
    let h_margin = ((pw - model_display) / 2).max(0);
    let sw = if raw.width == 0 {
        (380.0 * scale).round() as i32
    } else {
        raw.width as i32
    };
    let sh = if raw.height == 0 {
        (120.0 * scale).round() as i32
    } else {
        raw.height as i32
    };

    let free_left = px - wx;
    let free_right = wx + ww - (px + pw);
    let free_above = py - wy;
    let free_below = wy + wh - (py + ph);
    let centered_x = px + pw / 2 - sw / 2;
    let centered_y = py + ph / 2 - sh / 2;
    let candidates = [
        ("bottom", free_below, sh, centered_x, py + ph - v_margin + visual_gap),
        ("top", free_above, sh, centered_x, py + v_margin - sh - visual_gap),
        ("right", free_right, sw, px + pw - h_margin + visual_gap, centered_y),
        ("left", free_left, sw, px + h_margin - sw - visual_gap, centered_y),
    ];

    let fits = |candidate: &(&str, i32, i32, i32, i32)| {
        candidate.1 >= candidate.2 + visual_gap
    };
    let chosen = if settings.side == "auto" {
        candidates
            .iter()
            .find(|candidate| fits(candidate))
            .or_else(|| candidates.iter().max_by_key(|candidate| candidate.1))
    } else {
        candidates
            .iter()
            .find(|candidate| candidate.0 == settings.side)
            .or_else(|| candidates.iter().max_by_key(|candidate| candidate.1))
    };
    let Some(&(_, _, _, x, y)) = chosen else {
        return Ok(());
    };

    let max_x = (wx + ww - sw).max(wx);
    let max_y = (wy + wh - sh).max(wy);
    subtitle
        .set_position(PhysicalPosition::new(
            x.clamp(wx, max_x),
            y.clamp(wy, max_y),
        ))
        .map_err(|error| error.to_string())?;
    reposition_chat_if_snapped(app);
    Ok(())
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn SetWindowPos(
        hwnd: isize,
        insert_after: isize,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> i32;
}

#[cfg(windows)]
fn window_z_handle(window: &tauri::WebviewWindow<Wry>) -> Option<isize> {
    window.hwnd().ok().map(|handle| handle.0 as isize)
}

/// The pet stays topmost, but the subtitle and chat overlays must sit above it.
/// Raise one overlay, put the other behind it, then put the pet behind both.
#[cfg(windows)]
fn arrange_overlay_z_order(app: &AppHandle) {
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const FLAGS: u32 = SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE;
    let Some(pet) = app.get_webview_window(PET_LABEL) else {
        return;
    };
    let Some(pet_handle) = window_z_handle(&pet) else {
        return;
    };
    let mut overlays = Vec::new();
    for label in [SUBTITLE_LABEL, CHAT_LABEL] {
        let Some(window) = app.get_webview_window(label) else {
            continue;
        };
        if !window.is_visible().unwrap_or(false) {
            continue;
        }
        if let Some(handle) = window_z_handle(&window) {
            overlays.push(handle);
        }
    }
    let Some(&first) = overlays.first() else {
        return;
    };
    unsafe {
        SetWindowPos(first, 0, 0, 0, 0, 0, FLAGS);
    }
    if let Some(&second) = overlays.get(1) {
        unsafe {
            SetWindowPos(second, first, 0, 0, 0, 0, FLAGS);
            SetWindowPos(pet_handle, second, 0, 0, 0, 0, FLAGS);
        }
    } else {
        unsafe {
            SetWindowPos(pet_handle, first, 0, 0, 0, 0, FLAGS);
        }
    }
}

#[cfg(not(windows))]
fn arrange_overlay_z_order(_app: &AppHandle) {}

fn apply_subtitle_window(app: &AppHandle, settings: &SubtitleSettings) -> Result<(), String> {
    if let Some(menu) = app.try_state::<SubtitleMenuState>() {
        let _ = menu.visible.set_checked(settings.visible);
        let _ = menu.snap.set_checked(settings.snap);
        let _ = menu.background.set_checked(settings.semi_transparent);
    }

    let window = match app.get_webview_window(SUBTITLE_LABEL) {
        Some(window) => window,
        None => {
            if !settings.visible {
                return Ok(());
            }
            let subtitle_data_dir = data_directory().join("subtitle");
            std::fs::create_dir_all(&subtitle_data_dir).map_err(|error| {
                context("create subtitle data directory", error).to_string()
            })?;
            let window = WebviewWindowBuilder::new(
                app,
                SUBTITLE_LABEL,
                WebviewUrl::App("subtitle.html".into()),
            )
            .title("DS Tuber 字幕")
            .inner_size(350.0, 100.0)
            .min_inner_size(240.0, 60.0)
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .resizable(true)
            .focused(false)
            .visible(false)
            .data_directory(subtitle_data_dir)
            .build()
            .map_err(|error| context("create subtitle window", error).to_string())?;

            // The user can resize from any edge/corner; persist the resulting
            // logical size back into the subtitle state. Repositioning is
            // intentionally deferred so it does not fight the native drag.
            let resize_window = window.clone();
            let resize_app = app.clone();
            window.on_window_event(move |event| {
                match event {
                    tauri::WindowEvent::Resized(size) => {
                    let scale = resize_window.scale_factor().unwrap_or(1.0);
                    let width = size.width as f64 / scale;
                    let height = size.height as f64 / scale;
                    let (max_width, max_height) = subtitle_limits(&resize_app);
                    let clamped_width = width.clamp(240.0, max_width);
                    let clamped_height = height.clamp(60.0, max_height);
                    let state = resize_app.state::<SubtitleState>();
                    let mut settings = state.0.lock().unwrap().clone();
                    if (settings.width - clamped_width).abs() > 0.5
                        || (settings.height - clamped_height).abs() > 0.5
                    {
                        settings.width = clamped_width;
                        settings.height = clamped_height;
                        *state.0.lock().unwrap() = settings;
                    }

                    // Debounce the re-snap: the native resize emits a stream of
                    // Resized events, and moving the window during that stream
                    // would fight the user's drag. Only the last event of a
                    // gesture (200ms quiet period) re-aligns to the pet.
                    let generation = resize_app
                        .state::<SubtitleResizeState>()
                        .0
                        .fetch_add(1, Ordering::SeqCst)
                        + 1;
                    let sync_app = resize_app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(200));
                        if sync_app
                            .state::<SubtitleResizeState>()
                            .0
                            .load(Ordering::SeqCst)
                            != generation
                        {
                            return;
                        }
                        let state = sync_app.state::<SubtitleState>();
                        let settings = state.0.lock().unwrap().clone();
                        if settings.visible && settings.snap {
                            let _ = position_subtitle(&sync_app);
                        }
                        if settings.visible {
                            reposition_chat_if_snapped(&sync_app);
                        }
                    });
                    }
                    tauri::WindowEvent::Moved(_) => {
                        // A free subtitle is the anchor for the input bar; follow
                        // it while the native drag moves the window.
                        let state = resize_app.state::<SubtitleState>();
                        let settings = state.0.lock().unwrap().clone();
                        if settings.visible && !settings.snap {
                            reposition_chat_if_snapped(&resize_app);
                        }
                    }
                    _ => {}
                }
            });
            window
        }
    };

    let (max_width, max_height) = subtitle_limits(app);
    let _ = window.set_min_size(Some(LogicalSize::new(240.0, 60.0)));
    let _ = window.set_max_size(Some(LogicalSize::new(max_width, max_height)));

    if !settings.visible {
        let _ = window.hide();
        return Ok(());
    }

    let width = settings.width.clamp(240.0, max_width);
    let height = settings.height.clamp(60.0, max_height);
    let _ = window.set_size(LogicalSize::new(width, height));
    let _ = position_subtitle(app);
    let _ = window.show();
    let payload = serde_json::json!({
        "visible": settings.visible,
        "snap": settings.snap,
        "semiTransparent": settings.semi_transparent,
        "side": settings.side,
        "fontSize": settings.font_size,
        "backgroundOpacity": settings.background_opacity,
        "text": settings.text,
    });
    let _ = window.eval(&format!(
        "window.__subtitle && window.__subtitle.apply({payload})"
    ));
    reposition_chat_if_snapped(app);
    arrange_overlay_z_order(app);
    Ok(())
}

fn apply_subtitle_patch(
    app: &AppHandle,
    input: SubtitleSettingsInput,
) -> Result<(), String> {
    let state = app.state::<SubtitleState>();
    let mut current = state.0.lock().unwrap().clone();
    if let Some(visible) = input.visible {
        current.visible = visible;
    }
    if let Some(snap) = input.snap {
        current.snap = snap;
    }
    if let Some(semi_transparent) = input.semi_transparent {
        current.semi_transparent = semi_transparent;
    }
    if let Some(side) = input.side {
        current.side = normalize_side(&side);
    }
    if let Some(width) = input.width {
        current.width = width;
    }
    if let Some(height) = input.height {
        current.height = height;
    }
    if let Some(font_size) = input.font_size {
        current.font_size = font_size.clamp(12.0, 32.0);
    }
    if let Some(opacity) = input.background_opacity {
        current.background_opacity = opacity.clamp(0.0, 1.0);
    }
    if let Some(text) = input.text {
        current.text = text;
    }
    let (max_width, max_height) = subtitle_limits(app);
    current.width = current.width.clamp(240.0, max_width);
    current.height = current.height.clamp(60.0, max_height);
    *state.0.lock().unwrap() = current.clone();
    apply_subtitle_window(app, &current)
}

fn show_subtitle_menu_impl(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(SUBTITLE_LABEL)
        .ok_or_else(|| "subtitle window is missing".to_string())?;
    let state = app.state::<SubtitleMenuState>();
    state
        .menu
        .popup(window.as_ref().window())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_subtitle_settings(state: tauri::State<'_, SubtitleState>) -> SubtitleSettings {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
fn apply_subtitle_settings(
    app: AppHandle,
    settings: SubtitleSettingsInput,
) -> Result<(), String> {
    apply_subtitle_patch(&app, settings)
}

#[tauri::command]
fn show_subtitle_menu(app: AppHandle) -> Result<(), String> {
    show_subtitle_menu_impl(&app)
}

#[tauri::command]
fn start_subtitle_drag(app: AppHandle) -> Result<(), String> {
    let state = app.state::<SubtitleState>();
    let mut current = state.0.lock().unwrap().clone();
    if current.snap {
        current.snap = false;
        *state.0.lock().unwrap() = current;
        if let Some(menu) = app.try_state::<SubtitleMenuState>() {
            let _ = menu.snap.set_checked(false);
        }
    }
    let window = app
        .get_webview_window(SUBTITLE_LABEL)
        .ok_or_else(|| "subtitle window is missing".to_string())?;
    window
        .start_dragging()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn start_subtitle_resize(app: AppHandle, direction: String) -> Result<(), String> {
    let window = app
        .get_webview_window(SUBTITLE_LABEL)
        .ok_or_else(|| "subtitle window is missing".to_string())?;
    let direction = resize_direction(&direction)
        .ok_or_else(|| format!("unknown resize direction: {direction}"))?;
    window
        .as_ref()
        .window()
        .start_resize_dragging(direction)
        .map_err(|error| error.to_string())
}

fn chat_page_url() -> Result<tauri::Url, String> {
    let stage = std::env::var("DSH_DSTUBER_STAGE_URL")
        .unwrap_or_else(|_| DEFAULT_STAGE.to_string());
    let mut url: tauri::Url = stage
        .parse()
        .map_err(|error| format!("parse stage URL: {error}"))?;
    let path = url.path().to_string();
    let chat_path = if path.ends_with("index.html") {
        format!("{}chat.html", &path[..path.len() - "index.html".len()])
    } else if path.ends_with('/') {
        format!("{path}chat.html")
    } else {
        format!("{path}/chat.html")
    };
    url.set_path(&chat_path);
    url.set_query(Some("v=7"));
    Ok(url)
}

fn chat_limits(app: &AppHandle) -> (f64, f64) {
    let pet = app.get_webview_window(PET_LABEL);
    let monitor = pet
        .as_ref()
        .and_then(|window| window.current_monitor().ok().flatten())
        .or_else(|| {
            pet.as_ref()
                .and_then(|window| window.primary_monitor().ok().flatten())
        });
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let work = monitor.work_area();
        let max_width = (work.size.width as f64 / scale * 0.8).max(360.0);
        let max_height = (work.size.height as f64 / scale * 0.75).max(420.0);
        (max_width.round(), max_height.round())
    } else {
        (1365.0, 800.0)
    }
}

fn build_chat_menu(
    app: &AppHandle,
    settings: &ChatSettings,
) -> tauri::Result<(
    Menu<Wry>,
    CheckMenuItem<Wry>,
    CheckMenuItem<Wry>,
    CheckMenuItem<Wry>,
    CheckMenuItem<Wry>,
)> {
    let visible = CheckMenuItem::with_id(
        app,
        "chat-visible",
        "显示输入条",
        true,
        settings.visible,
        None::<&str>,
    )?;
    let snap = CheckMenuItem::with_id(
        app,
        "chat-snap",
        "自动吸附",
        true,
        settings.snap,
        None::<&str>,
    )?;
    let follow = CheckMenuItem::with_id(
        app,
        "chat-follow",
        "字幕未吸附时跟随",
        true,
        settings.follow_subtitle,
        None::<&str>,
    )?;
    let topmost = CheckMenuItem::with_id(
        app,
        "chat-topmost",
        "置顶",
        true,
        settings.always_on_top,
        None::<&str>,
    )?;
    let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
    let settings_item =
        MenuItem::with_id(app, "chat-settings", "人格与对话设置…", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&visible, &snap, &follow, &topmost, &separator, &settings_item],
    )?;
    Ok((menu, visible, snap, follow, topmost))
}

fn center_chat_bottom(app: &AppHandle) -> Result<(), String> {
    let chat = app
        .get_webview_window(CHAT_LABEL)
        .ok_or_else(|| "chat window is missing".to_string())?;
    let raw = chat.outer_size().map_err(|error| error.to_string())?;
    let monitor = match chat.current_monitor().map_err(|error| error.to_string())? {
        Some(monitor) => monitor,
        None => chat
            .primary_monitor()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "no monitor for chat window".to_string())?,
    };
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let margin = (24.0 * scale).round() as i32;
    let cw = if raw.width == 0 {
        (350.0 * scale).round() as i32
    } else {
        raw.width as i32
    };
    let ch = if raw.height == 0 {
        (CHAT_HEIGHT * scale).round() as i32
    } else {
        raw.height as i32
    };
    let x = work.position.x + (work.size.width as i32 - cw) / 2;
    let y = work.position.y + work.size.height as i32 - ch - margin;
    let max_x = (work.position.x + work.size.width as i32 - cw)
        .max(work.position.x);
    let max_y = (work.position.y + work.size.height as i32 - ch)
        .max(work.position.y);
    chat.set_position(PhysicalPosition::new(
        x.clamp(work.position.x, max_x),
        y.clamp(work.position.y, max_y),
    ))
    .map_err(|error| error.to_string())
}

fn rects_intersect(a: (i32, i32, i32, i32), b: (i32, i32, i32, i32)) -> bool {
    a.0 < b.0 + b.2 && b.0 < a.0 + a.2 && a.1 < b.1 + b.3 && b.1 < a.1 + a.3
}

fn reposition_chat_if_snapped(app: &AppHandle) {
    if let Some(state) = app.try_state::<ChatState>() {
        let settings = state.0.lock().unwrap().clone();
        if settings.visible && settings.snap {
            let _ = position_chat(app);
        }
    }
}

fn subtitle_window_rect(app: &AppHandle) -> Option<(i32, i32, i32, i32)> {
    let window = app.get_webview_window(SUBTITLE_LABEL)?;
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some((pos.x, pos.y, size.width as i32, size.height as i32))
}

fn position_chat_to_subtitle(
    app: &AppHandle,
    subtitle_rect: (i32, i32, i32, i32),
    settings: &ChatSettings,
) -> Result<(), String> {
    let chat = app
        .get_webview_window(CHAT_LABEL)
        .ok_or_else(|| "chat window is missing".to_string())?;
    let raw = chat.outer_size().map_err(|error| error.to_string())?;
    let monitor = match chat.current_monitor().map_err(|error| error.to_string())? {
        Some(monitor) => monitor,
        None => chat
            .primary_monitor()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "no monitor for chat window".to_string())?,
    };
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let gap = (2.0 * scale).round() as i32;

    let wx = work.position.x;
    let wy = work.position.y;
    let ww = work.size.width as i32;
    let wh = work.size.height as i32;
    let cw = if raw.width == 0 {
        (350.0 * scale).round() as i32
    } else {
        raw.width as i32
    };
    let ch = if raw.height == 0 {
        (CHAT_HEIGHT * scale).round() as i32
    } else {
        raw.height as i32
    };
    let sub = subtitle_rect;

    let pet_model = app.get_webview_window(PET_LABEL).and_then(|pet| {
        let pos = pet.outer_position().ok()?;
        let size = pet.outer_size().ok()?;
        let pw = size.width as i32;
        let ph = size.height as i32;
        let display = ((pw.min(ph) as f64) * 0.94).round() as i32;
        let h_margin = ((pw - display) / 2).max(0);
        let v_margin = ((ph - display) / 2).max(0);
        Some((
            pos.x + h_margin,
            pos.y + v_margin,
            display,
            display,
        ))
    });

    let max_x = (wx + ww - cw).max(wx);
    let max_y = (wy + wh - ch).max(wy);
    let order: [&str; 4] = if settings.side == "auto" {
        ["bottom", "top", "right", "left"]
    } else {
        match settings.side.as_str() {
            "top" => ["top", "bottom", "right", "left"],
            "right" => ["right", "bottom", "top", "left"],
            "left" => ["left", "bottom", "top", "right"],
            _ => ["bottom", "top", "right", "left"],
        }
    };

    let candidate = |side: &str| -> (i32, i32, i32, i32) {
        let (mut x, mut y) = match side {
            "top" => (sub.0 + sub.2 / 2 - cw / 2, sub.1 - ch - gap),
            "right" => (sub.0 + sub.2 + gap, sub.1 + sub.3 / 2 - ch / 2),
            "left" => (sub.0 - cw - gap, sub.1 + sub.3 / 2 - ch / 2),
            _ => (sub.0 + sub.2 / 2 - cw / 2, sub.1 + sub.3 + gap),
        };
        x = x.clamp(wx, max_x);
        y = y.clamp(wy, max_y);
        (x, y, cw, ch)
    };

    let fits = |rect: (i32, i32, i32, i32)| {
        let no_subtitle = !rects_intersect(rect, sub);
        let no_pet = pet_model
            .map(|pet| !rects_intersect(rect, pet))
            .unwrap_or(true);
        no_subtitle && no_pet
    };

    let chosen = order
        .iter()
        .map(|side| candidate(side))
        .find(|rect| fits(*rect))
        .or_else(|| order.first().map(|side| candidate(side)));

    let Some((x, y, _, _)) = chosen else {
        return Ok(());
    };
    chat.set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

fn position_chat(app: &AppHandle) -> Result<(), String> {
    let settings = app.state::<ChatState>().0.lock().unwrap().clone();
    if !settings.snap {
        return Ok(());
    }

    let chat = app
        .get_webview_window(CHAT_LABEL)
        .ok_or_else(|| "chat window is missing".to_string())?;

    let (subtitle_visible, subtitle_snapped) = app
        .try_state::<SubtitleState>()
        .map(|state| {
            let settings = state.0.lock().unwrap().clone();
            (settings.visible, settings.snap)
        })
        .unwrap_or((false, false));
    let subtitle_rect = if subtitle_visible {
        subtitle_window_rect(app)
    } else {
        None
    };
    if let Some(rect) = subtitle_rect {
        if !subtitle_snapped && settings.follow_subtitle {
            // A free subtitle becomes the anchor: follow it wherever it goes.
            return position_chat_to_subtitle(app, rect, &settings);
        }
    }

    let pet = app
        .get_webview_window(PET_LABEL)
        .ok_or_else(|| "pet window is missing".to_string())?;
    let raw = chat.outer_size().map_err(|error| error.to_string())?;
    let pet_pos = pet.outer_position().map_err(|error| error.to_string())?;
    let pet_size = pet.outer_size().map_err(|error| error.to_string())?;

    let monitor = match pet.current_monitor().map_err(|error| error.to_string())? {
        Some(monitor) => monitor,
        None => pet
            .primary_monitor()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "no monitor for pet window".to_string())?,
    };
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let gap = (2.0 * scale).round() as i32;

    let wx = work.position.x;
    let wy = work.position.y;
    let ww = work.size.width as i32;
    let wh = work.size.height as i32;
    let px = pet_pos.x;
    let py = pet_pos.y;
    let pw = pet_size.width as i32;
    let ph = pet_size.height as i32;
    let cw = if raw.width == 0 {
        (350.0 * scale).round() as i32
    } else {
        raw.width as i32
    };
    let ch = if raw.height == 0 {
        (CHAT_HEIGHT * scale).round() as i32
    } else {
        raw.height as i32
    };
    let model_display = ((pw.min(ph) as f64) * 0.94).round() as i32;
    let v_margin = ((ph - model_display) / 2).max(0);
    let h_margin = ((pw - model_display) / 2).max(0);
    let model_rect = (
        px + h_margin,
        py + v_margin,
        model_display,
        model_display,
    );

    // Classify the subtitle side. The pet renders at 94% of its square window;
    // use the visible model rectangle, not the transparent window bounds.
    let subtitle_side = match subtitle_rect {
        Some(sub) => {
            if sub.1 + sub.3 <= model_rect.1 {
                "top"
            } else if sub.1 >= model_rect.1 + model_rect.3 {
                "bottom"
            } else if sub.0 + sub.2 <= model_rect.0 {
                "left"
            } else if sub.0 >= model_rect.0 + model_rect.2 {
                "right"
            } else {
                "center"
            }
        }
        None => "none",
    };

    let auto_order: [&str; 4] = match subtitle_side {
        // Subtitle above: prefer the free side below the pet, then stack the
        // input bar above the subtitle if the bottom is too tight.
        "top" => ["bottom", "top", "right", "left"],
        // A subtitle below the pet is the same-side case: put the input bar
        // below the subtitle first (as the user requested), then fall back to
        // the opposite side if the screen has no room below it.
        "bottom" => ["bottom", "top", "right", "left"],
        // A subtitle on the left prefers the right side, and vice versa.
        "left" => ["right", "left", "bottom", "top"],
        "right" => ["left", "right", "bottom", "top"],
        _ => ["bottom", "top", "right", "left"],
    };

    let mut order: Vec<&str> = Vec::new();
    if settings.side == "auto" {
        order.extend(auto_order);
    } else {
        order.push(settings.side.as_str());
        for side in auto_order {
            if side != settings.side {
                order.push(side);
            }
        }
    }

    let max_x = (wx + ww - cw).max(wx);
    let max_y = (wy + wh - ch).max(wy);
    let centered_x = px + pw / 2 - cw / 2;
    let centered_y = py + ph / 2 - ch / 2;

    let candidate = |side: &str| -> (i32, i32, i32, i32) {
        let (mut x, mut y) = match side {
            "bottom" => (centered_x, py + ph - v_margin + gap),
            "top" => (centered_x, py + v_margin - ch - gap),
            "right" => (px + pw - h_margin + gap, centered_y),
            "left" => (px + h_margin - cw - gap, centered_y),
            _ => (centered_x, py + ph - v_margin + gap),
        };

        // If the initial rectangle hits the subtitle, move outward past it.
        if let Some(sub) = subtitle_rect {
            let rect = (x, y, cw, ch);
            if rects_intersect(rect, sub) {
                match side {
                    "bottom" => y = sub.1 + sub.3 + gap,
                    "top" => y = sub.1 - ch - gap,
                    "right" => x = sub.0 + sub.2 + gap,
                    "left" => x = sub.0 - cw - gap,
                    _ => {}
                }
            }
        }

        let x = x.clamp(wx, max_x);
        let y = y.clamp(wy, max_y);
        (x, y, cw, ch)
    };

    let fits = |rect: (i32, i32, i32, i32)| {
        let no_subtitle = subtitle_rect
            .map(|sub| !rects_intersect(rect, sub))
            .unwrap_or(true);
        let no_pet = !rects_intersect(rect, model_rect);
        no_subtitle && no_pet
    };

    let chosen = order
        .iter()
        .map(|side| candidate(side))
        .find(|rect| fits(*rect))
        .or_else(|| order.first().map(|side| candidate(side)));

    let Some((x, y, _, _)) = chosen else {
        return Ok(());
    };
    chat.set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

fn apply_chat_window(app: &AppHandle, settings: &ChatSettings) -> Result<(), String> {
    if let Some(menu) = app.try_state::<ChatMenuState>() {
        let _ = menu.visible.set_checked(settings.visible);
        let _ = menu.snap.set_checked(settings.snap);
        let _ = menu.follow.set_checked(settings.follow_subtitle);
        let _ = menu.topmost.set_checked(settings.always_on_top);
    }

    let (window, created) = match app.get_webview_window(CHAT_LABEL) {
        Some(window) => (window, false),
        None => {
            if !settings.visible {
                return Ok(());
            }
            let chat_data_dir = data_directory().join("chat");
            std::fs::create_dir_all(&chat_data_dir).map_err(|error| {
                context("create chat data directory", error).to_string()
            })?;
            let url = chat_page_url()?;
            let window = WebviewWindowBuilder::new(app, CHAT_LABEL, WebviewUrl::External(url))
                .title("DS Tuber 对话输入")
                .inner_size(350.0, CHAT_HEIGHT)
                .min_inner_size(300.0, CHAT_HEIGHT)
                .transparent(true)
                .decorations(false)
                .shadow(true)
                .resizable(true)
                .skip_taskbar(true)
                .focused(false)
                .visible(false)
                .always_on_top(settings.always_on_top)
                .data_directory(chat_data_dir)
                .build()
                .map_err(|error| context("create chat window", error).to_string())?;

            // Width resize: re-center after the gesture settles. Height is
            // locked by min/max constraints to keep this an input bar.
            let resize_window = window.clone();
            let resize_app = app.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Resized(size) = event {
                    let scale = resize_window.scale_factor().unwrap_or(1.0);
                    let width = size.width as f64 / scale;
                    let (max_width, _) = chat_limits(&resize_app);
                    let clamped_width = width.clamp(300.0, max_width);
                    let state = resize_app.state::<ChatState>();
                    let mut current = state.0.lock().unwrap().clone();
                    if (current.width - clamped_width).abs() > 0.5 {
                        current.width = clamped_width;
                        *state.0.lock().unwrap() = current;
                    }

                    let generation = resize_app
                        .state::<ChatResizeState>()
                        .0
                        .fetch_add(1, Ordering::SeqCst)
                        + 1;
                    let sync_app = resize_app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(180));
                        if sync_app
                            .state::<ChatResizeState>()
                            .0
                            .load(Ordering::SeqCst)
                            != generation
                        {
                            return;
                        }
                        let state = sync_app.state::<ChatState>();
                        let current = state.0.lock().unwrap().clone();
                        if current.visible && current.snap {
                            let _ = position_chat(&sync_app);
                        }
                    });
                }
            });
            (window, true)
        }
    };

    let (max_width, _) = chat_limits(app);
    let _ = window.set_min_size(Some(LogicalSize::new(300.0, CHAT_HEIGHT)));
    let _ = window.set_max_size(Some(LogicalSize::new(max_width, CHAT_HEIGHT)));
    let _ = window.set_always_on_top(settings.always_on_top);

    if !settings.visible {
        let _ = window.hide();
        return Ok(());
    }

    let width = settings.width.clamp(300.0, max_width);
    let _ = window.set_size(LogicalSize::new(width, CHAT_HEIGHT));
    if settings.snap {
        let _ = position_chat(app);
    } else if created {
        let _ = center_chat_bottom(app);
    }
    let _ = window.show();
    let _ = window.set_focus();
    arrange_overlay_z_order(app);
    Ok(())
}

fn apply_chat_patch(app: &AppHandle, input: ChatSettingsInput) -> Result<(), String> {
    let state = app.state::<ChatState>();
    let mut current = state.0.lock().unwrap().clone();
    if let Some(visible) = input.visible {
        current.visible = visible;
    }
    if let Some(snap) = input.snap {
        current.snap = snap;
    }
    if let Some(side) = input.side {
        current.side = normalize_side(&side);
    }
    if let Some(follow_subtitle) = input.follow_subtitle {
        current.follow_subtitle = follow_subtitle;
    }
    if let Some(width) = input.width {
        current.width = width;
    }
    if let Some(topmost) = input.always_on_top {
        current.always_on_top = topmost;
    }
    let (max_width, _) = chat_limits(app);
    current.width = current.width.clamp(300.0, max_width);
    *state.0.lock().unwrap() = current.clone();
    apply_chat_window(app, &current)
}

fn show_chat(app: &AppHandle) -> Result<(), String> {
    apply_chat_patch(
        app,
        ChatSettingsInput {
            visible: Some(true),
            ..Default::default()
        },
    )
}

fn hide_chat(app: &AppHandle) -> Result<(), String> {
    apply_chat_patch(
        app,
        ChatSettingsInput {
            visible: Some(false),
            ..Default::default()
        },
    )
}

fn show_chat_menu_impl(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(CHAT_LABEL)
        .ok_or_else(|| "chat window is missing".to_string())?;
    let state = app.state::<ChatMenuState>();
    state
        .menu
        .popup(window.as_ref().window())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_chat_settings(state: tauri::State<'_, ChatState>) -> ChatSettings {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
fn apply_chat_settings(app: AppHandle, settings: ChatSettingsInput) -> Result<(), String> {
    apply_chat_patch(&app, settings)
}

#[tauri::command]
fn open_chat_window(app: AppHandle) -> Result<(), String> {
    show_chat(&app)
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PersonaInfo {
    name: String,
    is_default: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BehaviorInfo {
    activity: String,
}

fn persona_directory() -> PathBuf {
    data_directory().join("persona")
}

fn default_persona_path() -> PathBuf {
    data_directory()
        .parent()
        .map(|parent| parent.join("personas").join("人设原文.md"))
        .unwrap_or_else(|| PathBuf::from("personas").join("人设原文.md"))
}

fn persona_state() -> PersonaInfo {
    let current = persona_directory().join("current.md");
    if current.exists() {
        let meta = persona_directory().join("current.json");
        let name = std::fs::read_to_string(&meta)
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|value| value.get("name").and_then(|item| item.as_str()).map(str::to_owned))
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "自定义人格.md".to_string());
        PersonaInfo {
            name,
            is_default: false,
        }
    } else {
        PersonaInfo {
            name: "人设原文.md".to_string(),
            is_default: true,
        }
    }
}

fn behavior_path() -> PathBuf {
    data_directory().join("behavior.json")
}

fn behavior_state() -> BehaviorInfo {
    let activity = std::fs::read_to_string(behavior_path())
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.get("activity").and_then(|item| item.as_str()).map(str::to_owned))
        .filter(|value| matches!(value.as_str(), "quiet" | "normal" | "active"))
        .unwrap_or_else(|| "normal".to_string());
    BehaviorInfo { activity }
}

#[tauri::command]
fn get_persona() -> PersonaInfo {
    persona_state()
}

#[tauri::command]
fn save_persona(name: String, content: String) -> Result<PersonaInfo, String> {
    let name = name.trim();
    if name.is_empty() || !name.to_ascii_lowercase().ends_with(".md") {
        return Err("人格文件必须是 .md".to_string());
    }
    if content.len() > 200 * 1024 {
        return Err("人格文件不能超过 200KB".to_string());
    }
    if content.trim().is_empty() {
        return Err("人格文件内容为空".to_string());
    }
    let dir = persona_directory();
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    std::fs::write(dir.join("current.md"), content).map_err(|error| error.to_string())?;
    std::fs::write(
        dir.join("current.json"),
        serde_json::json!({ "name": name }).to_string(),
    )
    .map_err(|error| error.to_string())?;
    Ok(PersonaInfo {
        name: name.to_string(),
        is_default: false,
    })
}

#[tauri::command]
fn reset_persona() -> Result<PersonaInfo, String> {
    let dir = persona_directory();
    let _ = std::fs::remove_file(dir.join("current.md"));
    let _ = std::fs::remove_file(dir.join("current.json"));
    if !default_persona_path().exists() {
        return Err("默认人设文件缺失".to_string());
    }
    Ok(PersonaInfo {
        name: "人设原文.md".to_string(),
        is_default: true,
    })
}

#[tauri::command]
fn get_behavior() -> BehaviorInfo {
    behavior_state()
}

#[tauri::command]
fn set_activity(activity: String) -> Result<BehaviorInfo, String> {
    let activity = match activity.as_str() {
        "quiet" | "normal" | "active" => activity,
        _ => return Err("活跃程度必须是 quiet/normal/active".to_string()),
    };
    let path = behavior_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(
        &path,
        serde_json::json!({ "activity": activity }).to_string(),
    )
    .map_err(|error| error.to_string())?;
    Ok(BehaviorInfo { activity })
}

const DEFAULT_LIVE2D_NAME: &str = "DS鲸鱼娘（桌面Q版）";

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Live2dModelInfo {
    kind: String,
    name: String,
    id: Option<String>,
    dir: Option<String>,
    default_name: String,
    active: bool,
}

const BUILTIN_MODELS: &[(&str, &str)] = &[
    ("ds-q", "DS鲸鱼娘（桌面Q版）"),
    ("ds-full", "DS鲸鱼娘"),
];

#[derive(Clone)]
enum ActiveLive2d {
    Builtin(String),
    Custom(String),
}

#[derive(serde::Deserialize)]
struct ActiveLive2dFile {
    kind: String,
    #[serde(default)]
    id: Option<String>,
}

fn live2d_user_root() -> Result<PathBuf, String> {
    Ok(data_directory().join("live2d"))
}

fn live2d_active_path() -> Result<PathBuf, String> {
    Ok(live2d_user_root()?.join("active.json"))
}

fn valid_model_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn builtin_live2d_name(id: &str) -> Option<&'static str> {
    BUILTIN_MODELS
        .iter()
        .find(|(model_id, _)| *model_id == id)
        .map(|(_, name)| *name)
}

fn builtin_live2d_info(id: &str, active: bool) -> Live2dModelInfo {
    let id = builtin_live2d_name(id)
        .map(str::to_owned)
        .map(|_| id.to_string())
        .unwrap_or_else(|| "ds-q".to_string());
    let name = builtin_live2d_name(&id)
        .unwrap_or(DEFAULT_LIVE2D_NAME)
        .to_string();
    Live2dModelInfo {
        kind: "builtin".to_string(),
        name,
        id: Some(id),
        dir: None,
        default_name: DEFAULT_LIVE2D_NAME.to_string(),
        active,
    }
}

fn read_active_live2d() -> ActiveLive2d {
    let Some(path) = live2d_active_path().ok() else {
        return ActiveLive2d::Builtin("ds-q".to_string());
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return ActiveLive2d::Builtin("ds-q".to_string());
    };
    let Ok(value) = serde_json::from_str::<ActiveLive2dFile>(&text) else {
        return ActiveLive2d::Builtin("ds-q".to_string());
    };
    match value.kind.as_str() {
        "custom" => {
            let id = value.id.unwrap_or_default();
            if valid_model_id(&id) {
                ActiveLive2d::Custom(id)
            } else {
                ActiveLive2d::Builtin("ds-q".to_string())
            }
        }
        "builtin" => {
            let id = value.id.unwrap_or_default();
            if builtin_live2d_name(&id).is_some() {
                ActiveLive2d::Builtin(id)
            } else {
                ActiveLive2d::Builtin("ds-q".to_string())
            }
        }
        _ => ActiveLive2d::Builtin("ds-q".to_string()),
    }
}

fn write_active_live2d(selection: &ActiveLive2d) -> Result<(), String> {
    let root = live2d_user_root()?;
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("创建模型目录 {} 失败: {error}", root.display()))?;
    let payload = match selection {
        ActiveLive2d::Builtin(id) => serde_json::json!({ "kind": "builtin", "id": id }),
        ActiveLive2d::Custom(id) => serde_json::json!({ "kind": "custom", "id": id }),
    };
    std::fs::write(root.join("active.json"), payload.to_string())
        .map_err(|error| format!("写入 active.json 失败: {error}"))
}

fn custom_model_dir(id: &str) -> Result<PathBuf, String> {
    Ok(live2d_user_root()?.join("custom").join(id))
}

fn custom_model_name(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("meta.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value
        .get("name")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

fn current_live2d_info() -> Live2dModelInfo {
    match read_active_live2d() {
        ActiveLive2d::Builtin(id) => builtin_live2d_info(&id, true),
        ActiveLive2d::Custom(id) => {
            if let Ok(dir) = custom_model_dir(&id) {
                let name = custom_model_name(&dir).unwrap_or_else(|| id.clone());
                return Live2dModelInfo {
                    kind: "custom".to_string(),
                    name,
                    id: Some(id),
                    dir: Some(dir.to_string_lossy().to_string()),
                    default_name: DEFAULT_LIVE2D_NAME.to_string(),
                    active: true,
                };
            }
            builtin_live2d_info("ds-q", true)
        }
    }
}

#[tauri::command]
fn list_live2d_models() -> Vec<Live2dModelInfo> {
    let active = read_active_live2d();
    let active_key = match &active {
        ActiveLive2d::Builtin(id) => format!("builtin:{id}"),
        ActiveLive2d::Custom(id) => format!("custom:{id}"),
    };
    let mut models = BUILTIN_MODELS
        .iter()
        .map(|(id, _)| {
            builtin_live2d_info(id, active_key == format!("builtin:{id}"))
        })
        .collect::<Vec<_>>();
    let root = match live2d_user_root() {
        Ok(root) => root,
        Err(_) => return models,
    };
    let custom = root.join("custom");
    let Ok(entries) = std::fs::read_dir(&custom) else {
        return models;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || !path.join("model3.json").is_file() {
            continue;
        }
        let Some(id) = path
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| valid_model_id(value))
        else {
            continue;
        };
        if builtin_live2d_name(id).is_some() {
            continue;
        }
        let id = id.to_string();
        let name = custom_model_name(&path).unwrap_or_else(|| id.clone());
        models.push(Live2dModelInfo {
            kind: "custom".to_string(),
            name,
            id: Some(id.clone()),
            dir: Some(path.to_string_lossy().to_string()),
            default_name: DEFAULT_LIVE2D_NAME.to_string(),
            active: active_key == format!("custom:{id}"),
        });
    }
    models
}

#[tauri::command]
fn select_live2d_model(
    app: AppHandle,
    kind: Option<String>,
    id: Option<String>,
) -> Result<Live2dModelInfo, String> {
    let selection = match kind.as_deref() {
        Some("builtin") => {
            let id = id.filter(|value| builtin_live2d_name(value).is_some())
                .ok_or_else(|| "内置模型 id 不存在".to_string())?;
            ActiveLive2d::Builtin(id)
        }
        Some("default") => ActiveLive2d::Builtin("ds-q".to_string()),
        Some("custom") | None => match id.filter(|value| !value.is_empty()) {
            Some(id) => {
                if !valid_model_id(&id) {
                    return Err("模型 id 不合法".to_string());
                }
                let dir = custom_model_dir(&id)?;
                if !dir.join("model3.json").is_file() {
                    return Err("模型文件不存在，请重新导入".to_string());
                }
                ActiveLive2d::Custom(id)
            }
            None => ActiveLive2d::Builtin("ds-q".to_string()),
        },
        Some(_) => return Err("未知模型类型".to_string()),
    };
    write_active_live2d(&selection)?;
    reload_pet_model(&app);
    Ok(current_live2d_info())
}

#[tauri::command]
fn delete_live2d_model(app: AppHandle, id: String) -> Result<Live2dModelInfo, String> {
    if !valid_model_id(&id) {
        return Err("模型 id 不合法".to_string());
    }
    let root = live2d_user_root()?;
    let dir = root.join("custom").join(&id);
    if !dir.is_dir() {
        return Err("模型不存在或已被删除".to_string());
    }
    let was_active = matches!(
        read_active_live2d(),
        ActiveLive2d::Custom(active) if active == id
    );
    std::fs::remove_dir_all(&dir)
        .map_err(|error| format!("删除模型目录 {} 失败: {error}", dir.display()))?;
    if was_active {
        write_active_live2d(&ActiveLive2d::Builtin("ds-q".to_string()))?;
        reload_pet_model(&app);
    }
    Ok(current_live2d_info())
}

fn reload_pet_model(app: &AppHandle) {
    if let Some(pet) = app.get_webview_window(PET_LABEL) {
        let _ = pet.eval("window.location.reload()");
    }
}

fn source_asset(base: &Path, reference: &str) -> Result<PathBuf, String> {
    if reference.trim().is_empty() {
        return Err("模型引用为空".to_string());
    }
    let path = Path::new(reference);
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(format!("模型引用了不安全路径: {reference}"));
    }
    let resolved = base.join(path);
    if !resolved.is_file() {
        return Err(format!("模型文件缺失: {}", resolved.display()));
    }
    Ok(resolved)
}

fn validate_live2d_source(source_file: &Path) -> Result<(), String> {
    if !source_file.is_file() {
        return Err(format!(
            "无法读取所选文件（{}）；请选择解压后的 model3.json",
            source_file.display()
        ));
    }
    let text = std::fs::read_to_string(source_file).map_err(|error| error.to_string())?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("model3.json 解析失败: {error}"))?;
    let base = source_file
        .parent()
        .ok_or_else(|| "无法读取模型所在目录".to_string())?;
    let refs = value
        .get("FileReferences")
        .ok_or_else(|| "model3.json 缺少 FileReferences".to_string())?;
    let moc = refs
        .get("Moc")
        .and_then(|item| item.as_str())
        .ok_or_else(|| "model3.json 缺少 FileReferences.Moc".to_string())?;
    source_asset(base, moc)?;
    let textures = refs
        .get("Textures")
        .and_then(|item| item.as_array())
        .ok_or_else(|| "model3.json 缺少 Textures".to_string())?;
    if textures.is_empty() {
        return Err("模型没有贴图".to_string());
    }
    for texture in textures {
        let value = texture
            .as_str()
            .ok_or_else(|| "Textures 必须是字符串数组".to_string())?;
        source_asset(base, value)?;
    }
    Ok(())
}

fn copy_model_tree(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.starts_with(source) {
        return Err("不能把模型复制到它自己的目录里".to_string());
    }
    let mut files = 0usize;
    let mut bytes = 0u64;

    fn walk(
        source: &Path,
        destination: &Path,
        files: &mut usize,
        bytes: &mut u64,
    ) -> Result<(), String> {
        std::fs::create_dir_all(destination).map_err(|error| error.to_string())?;
        for entry in std::fs::read_dir(source).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            if file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if file_type.is_dir() {
                if matches!(name_str.as_ref(), ".git" | "node_modules" | "target") {
                    continue;
                }
                walk(
                    &entry.path(),
                    &destination.join(&name),
                    files,
                    bytes,
                )?;
            } else if file_type.is_file() {
                *files += 1;
                if *files > 5000 {
                    return Err("模型文件数量超过 5000".to_string());
                }
                let len = entry
                    .metadata()
                    .map_err(|error| error.to_string())?
                    .len();
                *bytes += len;
                if *bytes > 400 * 1024 * 1024 {
                    return Err("模型超过 400MB".to_string());
                }
                std::fs::copy(entry.path(), destination.join(&name))
                    .map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    walk(source, destination, &mut files, &mut bytes)
}

fn slugify_model_name(name: &str) -> String {
    let mut slug = String::new();
    for character in name.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
        } else if matches!(character, ' ' | '-' | '_') && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "model".to_string()
    } else {
        slug.chars().take(40).collect()
    }
}

fn model_id_for(source: &Path) -> String {
    let slug = slugify_model_name(
        source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("model"),
    );
    let mut hasher = DefaultHasher::new();
    source.to_string_lossy().hash(&mut hasher);
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .hash(&mut hasher);
    format!("{slug}-{:08x}", hasher.finish() as u32)
}

fn import_selected_live2d(app: &AppHandle, source_file: &Path) -> Result<Live2dModelInfo, String> {
    validate_live2d_source(source_file)?;
    let source_dir = source_file
        .parent()
        .ok_or_else(|| "无法读取模型所在目录".to_string())?;
    let name = source_dir
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Live2D 模型")
        .to_string();
    let root = live2d_user_root()?.join("custom");
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;

    let mut id = model_id_for(source_dir);
    let mut destination = root.join(&id);
    let mut counter = 2;
    while destination.exists() {
        id = format!("{}-{counter}", model_id_for(source_dir));
        destination = root.join(&id);
        counter += 1;
    }

    let operation = (|| -> Result<(), String> {
        copy_model_tree(source_dir, &destination)
            .map_err(|error| format!("复制模型到 {} 失败: {error}", destination.display()))?;
        let destination_model = destination.join("model3.json");
        if source_file
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| value != "model3.json")
            .unwrap_or(true)
        {
            std::fs::copy(source_file, &destination_model)
                .map_err(|error| format!("写入 model3.json 失败: {error}"))?;
        }
        // Force the Host to regenerate the runtime files from this source.
        let _ = std::fs::remove_file(destination.join("model3.augmented.json"));
        let _ = std::fs::remove_file(destination.join("manifest.json"));
        let meta = serde_json::json!({
            "name": name,
            "source": source_dir.to_string_lossy(),
            "originalFile": source_file.file_name().map(|value| value.to_string_lossy().to_string()),
            "importedAt": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
        });
        std::fs::write(destination.join("meta.json"), meta.to_string())
            .map_err(|error| format!("写入模型元数据失败: {error}"))?;
        write_active_live2d(&ActiveLive2d::Custom(id.clone()))
    })();

    if let Err(error) = operation {
        let _ = std::fs::remove_dir_all(&destination);
        return Err(error);
    }

    reload_pet_model(app);
    Ok(current_live2d_info())
}

#[tauri::command]
fn get_live2d_model() -> Live2dModelInfo {
    current_live2d_info()
}

/// Origin of the DSH Host that serves the plugin API. The settings page calls
/// the model-adapter endpoints cross-origin from the Tauri webview.
#[tauri::command]
fn get_host_origin() -> Option<String> {
    let url = std::env::var("DSH_DSTUBER_STAGE_URL").ok()?;
    let scheme_end = url.find("://")?;
    let rest = &url[scheme_end + 3..];
    let host_end = rest
        .find(|c| c == '/' || c == '?' || c == '#')
        .unwrap_or(rest.len());
    if host_end == 0 {
        return None;
    }
    Some(format!("{}://{}", &url[..scheme_end], &rest[..host_end]))
}

fn is_archive(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("zip") | Some("7z")
    )
}

fn find_archive_ancestor(path: &Path) -> Option<(PathBuf, PathBuf)> {
    let mut current = path.to_path_buf();
    loop {
        let parent = current.parent()?;
        if parent.is_file() && is_archive(parent) {
            let relative = path.strip_prefix(parent).ok()?.to_path_buf();
            return Some((parent.to_path_buf(), relative));
        }
        current = parent.to_path_buf();
    }
}

fn extract_model_archive(archive: &Path) -> Result<PathBuf, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let target = std::env::temp_dir().join(format!("dsh-dstuber-model-{stamp}"));
    std::fs::create_dir_all(&target).map_err(|error| error.to_string())?;
    let output = std::process::Command::new("tar")
        .arg("-xf")
        .arg(archive)
        .arg("-C")
        .arg(&target)
        .output()
        .map_err(|error| format!("解压压缩包失败: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let _ = std::fs::remove_dir_all(&target);
        return Err(if detail.is_empty() {
            "解压压缩包失败，请先手动解压后选择 model3.json".to_string()
        } else {
            format!("解压压缩包失败: {detail}")
        });
    }
    Ok(target)
}

fn collect_model_files(root: &Path, output: &mut Vec<PathBuf>, depth: usize) -> Result<(), String> {
    if depth > 6 || output.len() > 20 {
        return Ok(());
    }
    for entry in std::fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_model_files(&entry.path(), output, depth + 1)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let name = entry
            .file_name()
            .to_string_lossy()
            .to_ascii_lowercase();
        if name == "model3.augmented.json" {
            continue;
        }
        if name == "model3.json" || name.ends_with(".model3.json") {
            output.push(entry.path());
        }
    }
    Ok(())
}

fn find_model_file(root: &Path, preferred: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(preferred) = preferred {
        let candidate = root.join(preferred);
        if candidate.is_file()
            && candidate
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.eq_ignore_ascii_case("json"))
                .unwrap_or(false)
        {
            return Ok(candidate);
        }
    }
    let mut models = Vec::new();
    collect_model_files(root, &mut models, 0)?;
    models.sort();
    match models.len() {
        0 => Err("压缩包里没有找到 model3.json".to_string()),
        1 => Ok(models.remove(0)),
        _ => Err("压缩包里找到多个 model3.json，请解压后选择具体模型".to_string()),
    }
}

fn prepare_model_source(selected: &Path) -> Result<(PathBuf, Option<PathBuf>), String> {
    if selected.is_file() {
        if is_archive(selected) {
            let temp = extract_model_archive(selected)?;
            let model = find_model_file(&temp, None)?;
            return Ok((model, Some(temp)));
        }
        if selected
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("json"))
            .unwrap_or(false)
        {
            return Ok((selected.to_path_buf(), None));
        }
        return Err("请选择 model3.json，或 .zip/.7z 模型压缩包".to_string());
    }

    if selected.is_dir() {
        return Ok((find_model_file(selected, None)?, None));
    }

    // A Windows archive shell extension can hand back a virtual path such as
    // C:\model.7z\folder\model3.json. Find the real archive ancestor, extract,
    // and resolve the same relative file inside it.
    if let Some((archive, relative)) = find_archive_ancestor(selected) {
        let temp = extract_model_archive(&archive)?;
        match find_model_file(&temp, Some(&relative)) {
            Ok(model) => return Ok((model, Some(temp))),
            Err(error) => {
                let _ = std::fs::remove_dir_all(&temp);
                return Err(error);
            }
        }
    }

    Err("选择的是压缩包内部文件；请直接选择解压后的 model3.json，或选择 .zip/.7z 压缩包本身".to_string())
}

fn pick_live2d_file() -> Result<Option<PathBuf>, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let result_file = std::env::temp_dir().join(format!("dsh-dstuber-model-pick-{stamp}.txt"));
    let _ = std::fs::remove_file(&result_file);
    let script = r#"Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '选择 Live2D 模型（model3.json 或 zip/7z 压缩包）'
$dialog.Filter = 'Live2D 模型 (*.json;*.zip;*.7z)|*.json;*.zip;*.7z|所有文件 (*.*)|*.*'
$dialog.Multiselect = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  $out = $env:DSH_DSTUBER_MODEL_PICK
  [IO.File]::WriteAllText($out, $dialog.FileName, [Text.UTF8Encoding]::new($false))
}"#;
    let mut command = std::process::Command::new("powershell.exe");
    command
        .env("DSH_DSTUBER_MODEL_PICK", &result_file)
        .args([
            "-NoProfile",
            "-STA",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let _ = std::fs::remove_file(&result_file);
        return Err(if message.is_empty() {
            "文件选择器启动失败".to_string()
        } else {
            message
        });
    }
    let path = std::fs::read_to_string(&result_file)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let _ = std::fs::remove_file(&result_file);
    Ok(path.map(PathBuf::from))
}

#[tauri::command]
async fn import_live2d_model(app: AppHandle) -> Result<Option<Live2dModelInfo>, String> {
    let picked = tauri::async_runtime::spawn_blocking(pick_live2d_file)
        .await
        .map_err(|error| format!("打开文件选择器失败: {error}"))??;
    let Some(source) = picked else {
        return Ok(None);
    };
    let (model, temp) = tauri::async_runtime::spawn_blocking(move || {
        prepare_model_source(&source)
    })
    .await
    .map_err(|error| format!("准备模型失败: {error}"))??;
    let result = tauri::async_runtime::spawn_blocking(move || {
        import_selected_live2d(&app, &model)
    })
    .await
    .map_err(|error| format!("导入任务失败: {error}"))?;
    if let Some(temp) = temp {
        let _ = std::fs::remove_dir_all(temp);
    }
    Ok(Some(result?))
}

#[tauri::command]
fn reset_live2d_model(app: AppHandle) -> Result<Live2dModelInfo, String> {
    write_active_live2d(&ActiveLive2d::Builtin("ds-q".to_string()))?;
    reload_pet_model(&app);
    Ok(current_live2d_info())
}

fn build_tray(app: &App) -> tauri::Result<TrayIcon<Wry>> {
    let show = MenuItem::with_id(app, "tray-show", "显示桌宠", true, None::<&str>)?;
    let chat = MenuItem::with_id(app, "tray-chat", "对话输入", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "tray-settings", "设置", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &chat, &settings, &quit])?;
    TrayIconBuilder::<Wry>::new()
        .icon(tray_icon())
        .menu(&menu)
        .tooltip("DS Tuber")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => {
                let _ = show_pet(app);
            }
            "tray-chat" => {
                let _ = show_chat(app);
            }
            "tray-settings" => {
                let _ = show_settings(app);
            }
            "tray-quit" => quit_app(app),
            _ => {}
        })
        .build(app)
}

#[tauri::command]
fn get_pet_settings(state: tauri::State<'_, UiState>) -> PetSettings {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
fn apply_pet_settings(
    app: AppHandle,
    state: tauri::State<'_, UiState>,
    settings: PetSettingsInput,
) -> Result<(), String> {
    if let Some(scale) = settings.scale {
        apply_scale(&app, state.inner(), scale)?;
    }
    if let Some(reduced) = settings.reduced_motion {
        apply_reduced(&app, state.inner(), reduced)?;
    }
    if let Some(always_on_top) = settings.always_on_top {
        apply_always_on_top(&app, state.inner(), always_on_top)?;
    }
    Ok(())
}

#[tauri::command]
fn hide_pet_command(app: AppHandle) -> Result<(), String> {
    hide_pet(&app)
}

#[tauri::command]
fn show_pet_command(app: AppHandle) -> Result<(), String> {
    show_pet(&app)
}

#[tauri::command]
fn open_webui_command() -> Result<(), String> {
    open_webui()
}

#[tauri::command]
fn settings_ui_ready() -> Result<(), String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    std::fs::write(data_directory().join("settings-ui-ready"), stamp.to_string())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_pet_autostart() -> bool {
    let path = data_directory().join("autostart.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return true;
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|value| value.get("enabled").and_then(|enabled| enabled.as_bool()))
        .unwrap_or(true)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceSettingsView {
    enabled: bool,
    read_murmurs: String,
    provider: String,
    volume: f64,
    edge_voice: String,
    edge_rate: f64,
    edge_pitch: f64,
    ffmpeg_path: String,
    gpt_sovits_url: String,
    gpt_weights: String,
    sovits_weights: String,
    reference_audio: String,
    prompt_text: String,
    prompt_lang: String,
    gpt_sovits_speed: f64,
    gpt_sovits_streaming: f64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoiceSettingsInput {
    enabled: bool,
    read_murmurs: String,
    provider: String,
    volume: f64,
    edge_voice: String,
    edge_rate: f64,
    edge_pitch: f64,
    ffmpeg_path: String,
    gpt_sovits_url: String,
    gpt_weights: String,
    sovits_weights: String,
    reference_audio: String,
    prompt_text: String,
    prompt_lang: String,
    gpt_sovits_speed: f64,
    gpt_sovits_streaming: f64,
}

fn voice_settings_path() -> PathBuf {
    data_directory().join("voice.json")
}

fn voice_settings_value() -> serde_json::Value {
    std::fs::read_to_string(voice_settings_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn voice_string(value: &serde_json::Value, key: &str, fallback: &str) -> String {
    value
        .get(key)
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn voice_number(value: &serde_json::Value, key: &str, fallback: f64) -> f64 {
    value
        .get(key)
        .and_then(|item| item.as_f64())
        .filter(|item| item.is_finite())
        .unwrap_or(fallback)
}

fn voice_settings_view(value: &serde_json::Value) -> VoiceSettingsView {
    let read_murmurs = voice_string(value, "readMurmurs", "important");
    let provider = voice_string(value, "provider", "edge");
    VoiceSettingsView {
        enabled: value.get("enabled").and_then(|item| item.as_bool()).unwrap_or(true),
        read_murmurs: if matches!(read_murmurs.as_str(), "off" | "important" | "all") {
            read_murmurs
        } else {
            "important".to_string()
        },
        provider: if provider == "gpt-sovits" {
            "gpt-sovits".to_string()
        } else {
            "edge".to_string()
        },
        volume: voice_number(value, "volume", 0.8).clamp(0.0, 1.0),
        edge_voice: voice_string(value, "edgeVoice", "zh-CN-XiaoyiNeural"),
        edge_rate: voice_number(value, "edgeRate", 0.0).clamp(-50.0, 50.0),
        edge_pitch: voice_number(value, "edgePitch", 0.0).clamp(-100.0, 100.0),
        ffmpeg_path: voice_string(value, "ffmpegPath", ""),
        gpt_sovits_url: voice_string(value, "gptSovitsUrl", "http://127.0.0.1:9880"),
        gpt_weights: voice_string(value, "gptWeights", ""),
        sovits_weights: voice_string(value, "sovitsWeights", ""),
        reference_audio: voice_string(value, "referenceAudio", ""),
        prompt_text: voice_string(value, "promptText", ""),
        prompt_lang: voice_string(value, "promptLang", "zh"),
        gpt_sovits_speed: voice_number(value, "gptSovitsSpeed", 1.0).clamp(0.5, 2.0),
        gpt_sovits_streaming: voice_number(value, "gptSovitsStreaming", 3.0).clamp(0.0, 3.0),
    }
}

#[tauri::command]
fn get_voice_settings() -> VoiceSettingsView {
    voice_settings_view(&voice_settings_value())
}#[cfg(windows)]
#[link(name = "winmm")]
extern "system" {
    fn PlaySoundW(sound: *const u16, module: isize, flags: u32) -> i32;
}

#[tauri::command]
fn play_tts(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let root = std::fs::canonicalize(data_directory().join("tts"))
            .map_err(|error| format!("TTS 目录不可用: {error}"))?;
        let target = std::fs::canonicalize(&path)
            .map_err(|error| format!("TTS 音频不存在: {error}"))?;
        if !target.starts_with(&root) {
            return Err("TTS 音频路径不合法".to_string());
        }
        let wide: Vec<u16> = target
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let ok = unsafe { PlaySoundW(wide.as_ptr(), 0, 0x0002_0003) };
        if ok == 0 {
            return Err("系统音频播放失败".to_string());
        }
    }
    let _ = path;
    Ok(())
}

#[tauri::command]
fn stop_tts() {
    #[cfg(windows)]
    unsafe {
        PlaySoundW(std::ptr::null(), 0, 0);
    }
}

#[tauri::command]
fn save_voice_settings(input: VoiceSettingsInput) -> Result<VoiceSettingsView, String> {
    let read_murmurs = if matches!(input.read_murmurs.as_str(), "off" | "important" | "all") {
        input.read_murmurs
    } else {
        "important".to_string()
    };
    let provider = if input.provider == "gpt-sovits" {
        "gpt-sovits"
    } else {
        "edge"
    };
    let payload = serde_json::json!({
        "enabled": input.enabled,
        "readMurmurs": read_murmurs,
        "provider": provider,
        "volume": input.volume.clamp(0.0, 1.0),
        "edgeVoice": input.edge_voice.trim().chars().take(120).collect::<String>(),
        "edgeRate": input.edge_rate.clamp(-50.0, 50.0),
        "edgePitch": input.edge_pitch.clamp(-100.0, 100.0),
        "ffmpegPath": input.ffmpeg_path.trim().chars().take(500).collect::<String>(),
        "gptSovitsUrl": input.gpt_sovits_url.trim().chars().take(500).collect::<String>(),
        "gptWeights": input.gpt_weights.trim().chars().take(1000).collect::<String>(),
        "sovitsWeights": input.sovits_weights.trim().chars().take(1000).collect::<String>(),
        "referenceAudio": input.reference_audio.trim().chars().take(1000).collect::<String>(),
        "promptText": input.prompt_text.trim().chars().take(2000).collect::<String>(),
        "promptLang": input.prompt_lang.trim().chars().take(20).collect::<String>(),
        "gptSovitsSpeed": input.gpt_sovits_speed.clamp(0.5, 2.0),
        "gptSovitsStreaming": input.gpt_sovits_streaming.clamp(0.0, 3.0),
    });
    let path = voice_settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建语音设置目录失败: {error}"))?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(&payload).unwrap_or_default())
        .map_err(|error| format!("写入 voice.json 失败: {error}"))?;
    Ok(voice_settings_view(&payload))
}

#[tauri::command]
fn set_pet_autostart(enabled: bool) -> Result<bool, String> {
    let dir = data_directory();
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("创建数据目录 {} 失败: {error}", dir.display()))?;
    let payload = serde_json::json!({ "enabled": enabled });
    std::fs::write(dir.join("autostart.json"), payload.to_string())
        .map_err(|error| format!("写入 autostart.json 失败: {error}"))?;
    Ok(enabled)
}

#[tauri::command]
fn quit_app_command(app: AppHandle) {
    quit_app(&app);
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_pet_settings,
            apply_pet_settings,
            hide_pet_command,
            show_pet_command,
            open_webui_command,
            settings_ui_ready,
            get_pet_autostart,
            set_pet_autostart,
            get_voice_settings,
            save_voice_settings,
            play_tts,
            stop_tts,
            quit_app_command,
            get_subtitle_settings,
            apply_subtitle_settings,
            show_subtitle_menu,
            start_subtitle_drag,
            start_subtitle_resize,
            get_chat_settings,
            apply_chat_settings,
            open_chat_window,
            get_persona,
            save_persona,
            reset_persona,
            get_behavior,
            set_activity,
            get_live2d_model,
            get_host_origin,
            import_live2d_model,
            reset_live2d_model,
            list_live2d_models,
            select_live2d_model,
            delete_live2d_model
        ])
        .setup(|app| {
            let stage = std::env::var("DSH_DSTUBER_STAGE_URL")
                .unwrap_or_else(|_| DEFAULT_STAGE.to_string());
            let mut url: tauri::Url = stage
                .parse()
                .map_err(|error| context("parse stage URL", error))?;
            if let Some(query) = url.query().map(str::to_owned) {
                let kept: Vec<&str> = query
                    .split('&')
                    .filter(|pair| {
                        !pair.starts_with("hud=") && !pair.starts_with("selftest=")
                    })
                    .collect();
                if kept.is_empty() {
                    url.set_query(None);
                } else {
                    url.set_query(Some(&kept.join("&")));
                }
            }

            let data_dir = data_directory();
            std::fs::create_dir_all(&data_dir)
                .map_err(|error| context("create pet data directory", error))?;

            let pet = WebviewWindowBuilder::new(app, PET_LABEL, WebviewUrl::External(url))
                .title("DS Tuber")
                .inner_size(BASE_WIDTH, BASE_HEIGHT)
                .min_inner_size(240.0, 300.0)
                .transparent(true)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .shadow(false)
                .resizable(false)
                .focused(false)
                .data_directory(data_dir)
                .build()
                .map_err(|error| context("create pet window", error))?;

            if let Some(monitor) = pet
                .current_monitor()
                .map_err(|error| context("read current monitor", error))?
            {
                let scale = monitor.scale_factor();
                let size = monitor.size();
                let origin = monitor.position();
                let outer_w = (BASE_WIDTH * scale).round() as i32;
                let outer_h = (BASE_HEIGHT * scale).round() as i32;
                let margin_x = (24.0 * scale).round() as i32;
                let margin_y = (48.0 * scale).round() as i32;
                let x = origin.x + size.width as i32 - outer_w - margin_x;
                let y = origin.y + size.height as i32 - outer_h - margin_y;
                pet.set_position(PhysicalPosition::new(
                    x.max(origin.x),
                    y.max(origin.y),
                ))
                .map_err(|error| context("position pet window", error))?;
            }

            app.manage(UiState(Mutex::new(PetSettings {
                scale: 1.0,
                reduced_motion: false,
                always_on_top: true,
            })));

            let subtitle_defaults = SubtitleSettings::default();
            app.manage(SubtitleState(Mutex::new(subtitle_defaults.clone())));
            app.manage(SubtitleResizeState(AtomicU64::new(0)));
            let (subtitle_menu, subtitle_visible, subtitle_snap, subtitle_background) =
                build_subtitle_menu(app.handle(), &subtitle_defaults)?;
            app.manage(SubtitleMenuState {
                menu: subtitle_menu,
                visible: subtitle_visible,
                snap: subtitle_snap,
                background: subtitle_background,
            });

            let chat_defaults = ChatSettings::default();
            app.manage(ChatState(Mutex::new(chat_defaults.clone())));
            app.manage(ChatResizeState(AtomicU64::new(0)));
            let (chat_menu, chat_visible, chat_snap, chat_follow, chat_topmost) =
                build_chat_menu(app.handle(), &chat_defaults)?;
            app.manage(ChatMenuState {
                menu: chat_menu,
                visible: chat_visible,
                snap: chat_snap,
                follow: chat_follow,
                topmost: chat_topmost,
            });

            let subtitle_menu_handle = app.handle().clone();
            subtitle_menu_handle.on_menu_event(move |app, event| {
                match event.id().as_ref() {
                    "subtitle-visible" => {
                        let visible =
                            app.state::<SubtitleState>().0.lock().unwrap().visible;
                        let _ = apply_subtitle_patch(
                            app,
                            SubtitleSettingsInput {
                                visible: Some(!visible),
                                ..Default::default()
                            },
                        );
                    }
                    "subtitle-snap" => {
                        let snap = app.state::<SubtitleState>().0.lock().unwrap().snap;
                        let _ = apply_subtitle_patch(
                            app,
                            SubtitleSettingsInput {
                                snap: Some(!snap),
                                ..Default::default()
                            },
                        );
                    }
                    "subtitle-background" => {
                        let semi =
                            app.state::<SubtitleState>().0.lock().unwrap().semi_transparent;
                        let _ = apply_subtitle_patch(
                            app,
                            SubtitleSettingsInput {
                                semi_transparent: Some(!semi),
                                ..Default::default()
                            },
                        );
                    }
                    "chat-visible" => {
                        let visible = app.state::<ChatState>().0.lock().unwrap().visible;
                        let _ = apply_chat_patch(
                            app,
                            ChatSettingsInput {
                                visible: Some(!visible),
                                ..Default::default()
                            },
                        );
                    }
                    "chat-snap" => {
                        let snap = app.state::<ChatState>().0.lock().unwrap().snap;
                        let _ = apply_chat_patch(
                            app,
                            ChatSettingsInput {
                                snap: Some(!snap),
                                ..Default::default()
                            },
                        );
                    }
                    "chat-follow" => {
                        let follow = app
                            .state::<ChatState>()
                            .0
                            .lock()
                            .unwrap()
                            .follow_subtitle;
                        let _ = apply_chat_patch(
                            app,
                            ChatSettingsInput {
                                follow_subtitle: Some(!follow),
                                ..Default::default()
                            },
                        );
                    }
                    "chat-topmost" => {
                        let topmost =
                            app.state::<ChatState>().0.lock().unwrap().always_on_top;
                        let _ = apply_chat_patch(
                            app,
                            ChatSettingsInput {
                                always_on_top: Some(!topmost),
                                ..Default::default()
                            },
                        );
                    }
                    "chat-settings" => {
                        let _ = show_settings(app);
                    }
                    _ => {}
                }
            });

            let subtitle_move_handle = app.handle().clone();
            pet.on_window_event(move |event| {
                if matches!(
                    event,
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
                ) {
                    if let Some(state) = subtitle_move_handle.try_state::<SubtitleState>() {
                        let settings = state.0.lock().unwrap().clone();
                        if settings.visible && settings.snap {
                            let _ = position_subtitle(&subtitle_move_handle);
                        }
                    }
                    if let Some(state) = subtitle_move_handle.try_state::<ChatState>() {
                        let settings = state.0.lock().unwrap().clone();
                        if settings.visible && settings.snap {
                            let _ = position_chat(&subtitle_move_handle);
                        }
                    }
                }
                if let tauri::WindowEvent::Focused(true) = event {
                    let handle = subtitle_move_handle.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(80));
                        arrange_overlay_z_order(&handle);
                    });
                }
            });

            apply_subtitle_window(app.handle(), &subtitle_defaults)?;
            apply_chat_window(app.handle(), &chat_defaults)?;

            match build_tray(app) {
                Ok(tray) => {
                    app.manage(TrayState(tray));
                }
                Err(error) => eprintln!("[dsh-dstuber] tray unavailable: {error}"),
            }

            let settings_handle = app.handle().clone();
            app.handle().listen("dsh-dstuber:open-settings", move |_event| {
                let _ = show_settings(&settings_handle);
            });
            let drag_handle = app.handle().clone();
            app.handle().listen("dsh-dstuber:start-drag", move |_event| {
                if let Some(pet) = drag_handle.get_webview_window(PET_LABEL) {
                    let _ = pet.start_dragging();
                }
            });

            let chat_menu_handle = app.handle().clone();
            app.handle().listen("dsh-dstuber:chat-menu", move |_event| {
                let _ = show_chat_menu_impl(&chat_menu_handle);
            });
            let chat_drag_handle = app.handle().clone();
            app.handle().listen("dsh-dstuber:chat-drag", move |_event| {
                if let Some(state) = chat_drag_handle.try_state::<ChatState>() {
                    let mut current = state.0.lock().unwrap().clone();
                    if current.snap {
                        current.snap = false;
                        *state.0.lock().unwrap() = current;
                        if let Some(menu) = chat_drag_handle.try_state::<ChatMenuState>() {
                            let _ = menu.snap.set_checked(false);
                        }
                    }
                }
                if let Some(chat) = chat_drag_handle.get_webview_window(CHAT_LABEL) {
                    let _ = chat.start_dragging();
                }
            });
            let chat_resize_handle = app.handle().clone();
            app.handle().listen("dsh-dstuber:chat-resize", move |event| {
                let direction = serde_json::from_str::<String>(event.payload()).unwrap_or_default();
                if let Some(direction) = resize_direction(&direction) {
                    if let Some(chat) = chat_resize_handle.get_webview_window(CHAT_LABEL) {
                        let _ = chat.as_ref().window().start_resize_dragging(direction);
                    }
                }
            });
            let chat_hide_handle = app.handle().clone();
            app.handle().listen("dsh-dstuber:chat-hide", move |_event| {
                let _ = hide_chat(&chat_hide_handle);
            });

            let subtitle_text_handle = app.handle().clone();
            app.handle().listen("dsh-dstuber:subtitle-text", move |event| {
                let text = serde_json::from_str::<serde_json::Value>(event.payload())
                    .ok()
                    .and_then(|value| value.get("text").and_then(|item| item.as_str()).map(str::to_owned))
                    .unwrap_or_default();
                if text.trim().is_empty() {
                    return;
                }
                if let Some(state) = subtitle_text_handle.try_state::<SubtitleState>() {
                    let mut current = state.0.lock().unwrap().clone();
                    current.text = text.clone();
                    *state.0.lock().unwrap() = current.clone();
                }
                if let Some(window) = subtitle_text_handle.get_webview_window(SUBTITLE_LABEL) {
                    let quoted = serde_json::to_string(&text).unwrap_or_else(|_| "\"\"".to_string());
                    let _ = window.eval(&format!(
                        "window.__subtitle && window.__subtitle.setText({quoted})"
                    ));
                    if let Some(state) = subtitle_text_handle.try_state::<SubtitleState>() {
                        if state.0.lock().unwrap().visible {
                            let _ = window.show();
                        }
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running dsh-dstuber shell");
}
