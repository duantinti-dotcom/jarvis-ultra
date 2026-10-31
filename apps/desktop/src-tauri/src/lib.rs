//! Shell nativo do JARVIS ULTRA.
//! Inicia o JARVIS Core (Node embarcado) como processo filho, lê a porta e o token
//! que ele publica, abre a interface servida pelo core em 127.0.0.1 e mantém um
//! ícone na bandeja com parada de emergência. Ao sair, encerra o core.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Deserialize, Clone)]
struct Ready {
    port: u16,
    token: String,
}

struct CoreProcess {
    child: Mutex<Option<Child>>,
    ready: Mutex<Option<Ready>>,
}

fn resource(app: &AppHandle, rel: &str) -> PathBuf {
    app.path().resource_dir().expect("resource dir").join(rel)
}

/// Localiza o node.exe embarcado ao lado do executável (externalBin do Tauri).
fn node_binary() -> PathBuf {
    let exe = std::env::current_exe().expect("current exe");
    let dir = exe.parent().expect("exe dir");
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let bundled = dir.join(name);
    if bundled.exists() { bundled } else { PathBuf::from(name) }
}

fn splash(app: &AppHandle, text: &str, error: bool) {
    if let Some(w) = app.get_webview_window("main") {
        let js = format!("window.__jarvisSplash && window.__jarvisSplash({}, {})", serde_json::to_string(text).unwrap(), error);
        let _ = w.eval(&js);
    }
}

fn start_core(app: AppHandle) {
    std::thread::spawn(move || {
        let core = resource(&app, "core/jarvis-core.mjs");
        let ui = resource(&app, "ui");
        let mut cmd = Command::new(node_binary());
        // --preserve-symlinks*: evita que o Node resolva o caminho real até a raiz do disco
        // na partida (falha com EISDIR em algumas instalações do Windows).
        cmd.arg("--disable-warning=ExperimentalWarning")
            .arg("--preserve-symlinks")
            .arg("--preserve-symlinks-main")
            .arg(&core)
            .current_dir(resource(&app, "core"))
            .env("JARVIS_EMIT_READY", "1")
            .env("JARVIS_UI_DIR", &ui)
            .env("JARVIS_QUIET", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                splash(&app, &format!("Não foi possível iniciar o JARVIS Core: {e}"), true);
                return;
            }
        };
        let stdout = child.stdout.take().expect("stdout");
        let mut stderr = child.stderr.take().expect("stderr");
        app.state::<CoreProcess>().child.lock().unwrap().replace(child);

        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(json) = line.strip_prefix("JARVIS_READY ") {
                if let Ok(ready) = serde_json::from_str::<Ready>(json) {
                    app.state::<CoreProcess>().ready.lock().unwrap().replace(ready.clone());
                    let app2 = app.clone();
                    let _ = app.run_on_main_thread(move || open_ui(&app2, &ready));
                }
            }
        }
        // stdout fechou: o core terminou.
        let mut err = String::new();
        let _ = stderr.read_to_string(&mut err);
        // Log completo para diagnóstico em %LOCALAPPDATA%\JarvisUltra\logs\core-crash.log
        let log_path = std::env::var("LOCALAPPDATA")
            .map(|d| PathBuf::from(d).join("JarvisUltra").join("logs"))
            .unwrap_or_else(|_| std::env::temp_dir());
        let _ = std::fs::create_dir_all(&log_path);
        let log_file = log_path.join("core-crash.log");
        let _ = std::fs::write(&log_file, &err);
        let tail: String = err.lines().rev().take(14).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        splash(&app, &format!("O JARVIS Core foi encerrado.\nLog completo: {}\n{tail}", log_file.display()), true);
    });
}

fn open_ui(app: &AppHandle, ready: &Ready) {
    let url = format!("http://127.0.0.1:{}/", ready.port);
    let init = format!(
        "window.__JARVIS__ = {{ coreUrl: {}, token: {} }};",
        serde_json::to_string(&format!("http://127.0.0.1:{}", ready.port)).unwrap(),
        serde_json::to_string(&ready.token).unwrap()
    );
    if let Some(old) = app.get_webview_window("main") {
        let _ = old.close();
    }
    let built = WebviewWindowBuilder::new(app, "app", WebviewUrl::External(url.parse().unwrap()))
        .title("JARVIS ULTRA")
        .inner_size(1360.0, 860.0)
        .min_inner_size(900.0, 600.0)
        .initialization_script(&init)
        .build();
    if let Err(e) = built {
        eprintln!("falha ao abrir a interface: {e}");
    }
}

/// Requisição HTTP mínima ao core local (sem dependências extras).
fn core_post(app: &AppHandle, path: &str) -> bool {
    let ready = app.state::<CoreProcess>().ready.lock().unwrap().clone();
    let Some(r) = ready else { return false };
    let Ok(mut s) = TcpStream::connect(("127.0.0.1", r.port)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        r.port, r.token
    );
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    matches!(s.read(&mut buf), Ok(n) if n > 12 && &buf[9..12] == b"200")
}

fn show_main(app: &AppHandle) {
    for label in ["app", "main"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
            return;
        }
    }
}

fn stop_core(app: &AppHandle) {
    if let Some(mut c) = app.state::<CoreProcess>().child.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .manage(CoreProcess { child: Mutex::new(None), ready: Mutex::new(None) })
        .setup(|app| {
            let handle = app.handle().clone();
            let open = MenuItem::with_id(app, "open", "Abrir JARVIS", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "Parada de emergência", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &stop, &PredefinedMenuItem::separator(app)?, &quit])?;
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("JARVIS ULTRA")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "open" => show_main(app),
                    "stop" => {
                        let ok = core_post(app, "/api/emergency/stop");
                        eprintln!("parada de emergência: {ok}");
                    }
                    "quit" => {
                        stop_core(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            start_core(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Fechar a janela mantém o JARVIS na bandeja (o ícone indica que ele segue ativo).
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "app" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o JARVIS ULTRA");

    app.run(|handle, event| {
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            stop_core(handle);
        }
    });
}
