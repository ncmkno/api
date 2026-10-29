// No console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::utils::config::WindowEffectsConfig;
use tauri::window::{Effect, EffectsBuilder};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

const WIDGET: &str = "widget";
const RADIUS: f64 = 22.0;

/// Liquid Glass on macOS 26+, the HUD material on older macOS, Acrylic on Windows; Linux has no
/// native material, so there the transparent window shows the page as-is.
fn glass() -> WindowEffectsConfig {
    EffectsBuilder::new()
        .effects([Effect::LiquidGlassRegular, Effect::HudWindow, Effect::Acrylic])
        .radius(RADIUS)
        .interactive(true)
        .build()
}

/// The API's loopback port; USAGE_MONITOR_PORT overrides it the same way it does for the server.
fn dashboard_url() -> String {
    let port = std::env::var("USAGE_MONITOR_PORT").unwrap_or_else(|_| "7842".into());
    format!("http://127.0.0.1:{port}/")
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        // Only where the card was dragged to: its size is fixed, and it is shown at every start.
        .plugin(tauri_plugin_window_state::Builder::new().with_state_flags(StateFlags::POSITION).build())
        .setup(|app| {
            // A floating card, not an app: no Dock icon on macOS.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let url = format!("{}#/widget", dashboard_url()).parse().expect("valid dashboard URL");
            WebviewWindowBuilder::new(app, WIDGET, WebviewUrl::External(url))
                .title("Usage Monitor")
                .inner_size(300.0, 136.0)
                .resizable(false)
                .decorations(false)
                .transparent(true)
                .effects(glass())
                .shadow(true)
                .always_on_top(true)
                .visible_on_all_workspaces(true)
                .skip_taskbar(true)
                .build()?;

            let toggle = MenuItem::with_id(app, "toggle", "Show / hide", true, None::<&str>)?;
            let reload = MenuItem::with_id(app, "reload", "Reload", true, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "Open dashboard", true, None::<&str>)?;
            let login = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart = CheckMenuItem::with_id(app, "autostart", "Start at login", true, login, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle, &reload, &open, &autostart, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("bundle icon").clone())
                .tooltip("Usage Monitor")
                .menu(&menu)
                .on_menu_event(move |app, event| {
                    let window = app.get_webview_window(WIDGET);
                    match event.id.as_ref() {
                        "toggle" => {
                            if let Some(w) = window {
                                let _ = if w.is_visible().unwrap_or(true) { w.hide() } else { w.show() };
                            }
                        }
                        // The page keeps polling, but a server restart can leave it on an error page.
                        "reload" => {
                            if let Some(w) = window {
                                let _ = w.eval("location.reload()");
                            }
                        }
                        "open" => {
                            let _ = app.opener().open_url(dashboard_url(), None::<&str>);
                        }
                        "autostart" => {
                            let launcher = app.autolaunch();
                            let on = launcher.is_enabled().unwrap_or(false);
                            let _ = if on { launcher.disable() } else { launcher.enable() };
                            let _ = autostart.set_checked(launcher.is_enabled().unwrap_or(false));
                        }
                        // Exiting skips the window-close hook that would otherwise save the position.
                        "quit" => {
                            let _ = app.save_window_state(StateFlags::POSITION);
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Usage Monitor");
}
