#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! Z Feedback: a native window around a local player page. Nothing leaves this PC.
use include_dir::{include_dir, Dir};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, OnceLock},
};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

static WEB: Dir = include_dir!("$CARGO_MANIFEST_DIR/../web");
const WEBHOOK: &str = env!("Z_WEBHOOK");
const VIDEO_EXT: [&str; 3] = ["mp4", "m4v", "webm"];
const CHUNK: usize = 4 * 1024 * 1024;

enum Media {
    File(PathBuf, usize),
    Memory(Vec<u8>),
}
struct Source {
    media: Option<Media>,
    name: String,
    mime: &'static str,
    project: Value,
}
static SOURCE: OnceLock<Source> = OnceLock::new();

fn video_ext(name: &str) -> Option<&'static str> {
    let e = name.rsplit('.').next()?.to_ascii_lowercase();
    VIDEO_EXT.iter().find(|x| **x == e).copied()
}
fn video_mime(ext: &str) -> &'static str {
    if ext == "webm" { "video/webm" } else { "video/mp4" }
}
fn stem(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    base.rsplit_once('.').map(|x| x.0).unwrap_or(base).to_string()
}
fn find_in_zip(path: &Path) -> Option<Source> {
    let mut z = zip::ZipArchive::new(fs::File::open(path).ok()?).ok()?;
    let names: Vec<String> = z.file_names().map(String::from).collect();
    let usable = |n: &&String| !n.starts_with("__MACOSX") && !n.ends_with('/');
    let video = names.iter().filter(usable).find(|n| video_ext(n).is_some())?;
    let mut data = vec![];
    z.by_name(video).ok()?.read_to_end(&mut data).ok()?;
    let mut project = Value::Null;
    if let Some(p) = names.iter().filter(usable).find(|n| n.rsplit('/').next() == Some("project.json")) {
        let mut text = String::new();
        if z.by_name(p).ok()?.read_to_string(&mut text).is_ok() {
            project = serde_json::from_str(&text).unwrap_or(Value::Null);
        }
    }
    Some(Source { name: stem(video), mime: video_mime(video_ext(video)?), media: Some(Media::Memory(data)), project })
}
/// Video next to the exe first, then inside any zip next to it.
fn locate() -> Source {
    let empty = Source { media: None, name: String::new(), mime: "video/mp4", project: Value::Null };
    let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) else { return empty };
    let mut files: Vec<PathBuf> = fs::read_dir(&dir).map(|d| d.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect()).unwrap_or_default();
    files.sort();
    let beside = fs::read_to_string(dir.join("project.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    for p in &files {
        let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
        if let Some(ext) = video_ext(&name) {
            let size = fs::metadata(p).map(|m| m.len() as usize).unwrap_or(0);
            return Source { name: stem(&name), mime: video_mime(ext), media: Some(Media::File(p.clone(), size)), project: beside };
        }
    }
    for p in files.iter().filter(|p| p.extension().map(|e| e.eq_ignore_ascii_case("zip")).unwrap_or(false)) {
        if let Some(s) = find_in_zip(p) {
            return s;
        }
    }
    empty
}

fn app_dir() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("ZFeedback")
}

fn output_dir() -> PathBuf {
    let home = PathBuf::from(std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into()));
    for c in [home.join("Desktop"), home.join("OneDrive").join("Desktop"), home.join("Documents")] {
        if c.is_dir() {
            return c;
        }
    }
    home
}

fn safe_name(s: &str) -> String {
    let c: String = s.chars().map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' }).take(40).collect();
    if c.trim_matches('_').is_empty() { "Client".into() } else { c }
}

fn mime(p: &str) -> &'static str {
    match p.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "png" => "image/png",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

fn head(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).expect("header")
}

fn send_json(rq: Request, v: Value, code: u16) {
    let r = Response::from_string(v.to_string()).with_status_code(code).with_header(head("Content-Type", "application/json")).with_header(head("Cache-Control", "no-store"));
    let _ = rq.respond(r);
}

fn byte_range(rq: &Request, n: usize) -> Option<(usize, usize, bool)> {
    if n == 0 {
        return None;
    }
    let range = rq.headers().iter().find(|h| h.field.equiv("Range")).map(|h| h.value.as_str().to_string());
    let (mut a, mut b, mut partial) = (0usize, n - 1, false);
    if let Some(r) = range.as_deref().and_then(|r| r.strip_prefix("bytes=")) {
        if let Some((x, y)) = r.split_once('-') {
            if let Ok(v) = x.parse::<usize>() {
                a = v;
            }
            if let Ok(v) = y.parse::<usize>() {
                b = v.min(n - 1);
            }
            partial = true;
        }
    }
    (a <= b).then_some((a, b, partial))
}

fn serve_file(rq: Request, path: &str) {
    let p = if path.is_empty() { "index.html" } else { path };
    let Some(f) = WEB.get_file(p) else {
        let _ = rq.respond(Response::from_string("not found").with_status_code(404));
        return;
    };
    let r = Response::from_data(f.contents().to_vec()).with_header(head("Content-Type", mime(p))).with_header(head("Cache-Control", "no-store"));
    let _ = rq.respond(r);
}

fn serve_video(rq: Request) {
    let src = SOURCE.get().expect("source");
    let n = match &src.media {
        Some(Media::File(_, s)) => *s,
        Some(Media::Memory(d)) => d.len(),
        None => 0,
    };
    let Some((a, mut b, partial)) = byte_range(&rq, n) else {
        let _ = rq.respond(Response::from_string("").with_status_code(416).with_header(head("Content-Range", &format!("bytes */{n}"))));
        return;
    };
    if partial {
        b = b.min(a + CHUNK - 1);
    }
    let data = match &src.media {
        Some(Media::Memory(d)) => Some(d[a..=b].to_vec()),
        Some(Media::File(p, _)) => (|| {
            let mut f = fs::File::open(p).ok()?;
            f.seek(SeekFrom::Start(a as u64)).ok()?;
            let mut v = vec![0u8; b - a + 1];
            f.read_exact(&mut v).ok()?;
            Some(v)
        })(),
        None => None,
    };
    let Some(data) = data else {
        let _ = rq.respond(Response::from_string("read error").with_status_code(500));
        return;
    };
    let mut r = Response::from_data(data).with_header(head("Content-Type", src.mime)).with_header(head("Accept-Ranges", "bytes")).with_header(head("Cache-Control", "no-store"));
    if partial {
        r = r.with_status_code(StatusCode(206)).with_header(head("Content-Range", &format!("bytes {a}-{b}/{n}")));
    }
    let _ = rq.respond(r);
}

fn stamp() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (z, rem) = (secs.div_euclid(86400) + 719468, secs.rem_euclid(86400));
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}_{:02}{:02}", rem / 3600, rem % 3600 / 60)
}

fn cut(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    s.chars().take(n.saturating_sub(1)).chain(std::iter::once('…')).collect()
}

/// Posts the summary and the report to the webhook. Errors are short codes, never the URL.
fn send_webhook(v: &Value, html: &str) -> Result<(), &'static str> {
    if WEBHOOK.is_empty() {
        return Err("not_configured");
    }
    if html.len() > 9_500_000 {
        return Err("too_large");
    }
    let s = |k: &str| v[k].as_str().unwrap_or("");
    let n = |k: &str| v[k].as_u64().unwrap_or(0);
    let mut list = String::new();
    for x in v["notes"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        let line = format!("**{}** {}\n", cut(x["where"].as_str().unwrap_or(""), 70), cut(x["text"].as_str().unwrap_or(""), 180));
        if list.chars().count() + line.chars().count() > 3600 {
            list.push_str("…see the attached file for the rest\n");
            break;
        }
        list.push_str(&line);
    }
    let file = format!("ZFeedback_{}_{}.html", safe_name(s("name")), stamp());
    let summary = if s("summary").is_empty() { "-".to_string() } else { cut(s("summary"), 1000) };
    let payload = json!({
        "username": "Z Feedback",
        "allowed_mentions": {"parse": []},
        "embeds": [{
            "title": cut(&format!("{} {}: {}", s("title"), s("version"), s("decision")), 240),
            "color": n("color"),
            "description": if list.is_empty() { "No notes.".to_string() } else { list },
            "fields": [
                {"name": "From", "value": cut(s("name"), 200), "inline": true},
                {"name": "Scenes", "value": format!("{} approved, {} to change, {} open", n("approved"), n("changes"), n("open")), "inline": true},
                {"name": "Notes", "value": format!("{} total, {} must fix", n("noteCount"), n("mustCount")), "inline": true},
                {"name": "Summary", "value": summary, "inline": false},
            ],
        }],
        "attachments": [{"id": 0, "filename": file}],
    });
    let mut seed = [0u8; 12];
    let _ = getrandom::getrandom(&mut seed);
    let boundary = format!("zfeedback{}", seed.iter().map(|b| format!("{b:02x}")).collect::<String>());
    let mut body: Vec<u8> = Vec::with_capacity(html.len() + 4096);
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"payload_json\"\r\nContent-Type: application/json\r\n\r\n{payload}\r\n").as_bytes());
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"files[0]\"; filename=\"{file}\"\r\nContent-Type: text/html; charset=utf-8\r\n\r\n").as_bytes());
    body.extend_from_slice(html.as_bytes());
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let tls = native_tls::TlsConnector::new().map_err(|_| "network")?;
    let agent = ureq::AgentBuilder::new().tls_connector(Arc::new(tls)).timeout(std::time::Duration::from_secs(45)).build();
    let ctype = format!("multipart/form-data; boundary={boundary}");
    for attempt in 0..3 {
        match agent.post(WEBHOOK).set("Content-Type", &ctype).set("User-Agent", "ZFeedback/1.0").send_bytes(&body) {
            Ok(_) => return Ok(()),
            Err(ureq::Error::Status(429, r)) if attempt < 2 => {
                let wait: f64 = r.into_string().ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|j| j["retry_after"].as_f64()).unwrap_or(1.0);
                std::thread::sleep(std::time::Duration::from_secs_f64(wait.clamp(0.2, 6.0)));
            }
            Err(ureq::Error::Status(c, _)) if c >= 500 && attempt < 2 => std::thread::sleep(std::time::Duration::from_secs(1)),
            Err(ureq::Error::Status(_, _)) => return Err("rejected"),
            Err(_) if attempt < 2 => std::thread::sleep(std::time::Duration::from_secs(1)),
            Err(_) => return Err("network"),
        }
    }
    Err("network")
}

fn handle(mut rq: Request, token: &str) {
    let full = rq.url().to_string();
    let url = full.split('?').next().unwrap_or("/").to_string();
    let path = url.trim_start_matches('/').to_string();
    if path == "media/video" {
        if full.ends_with(&format!("?t={token}")) {
            return serve_video(rq);
        }
        let _ = rq.respond(Response::from_string("forbidden").with_status_code(403));
        return;
    }
    if !path.starts_with("api/") {
        return serve_file(rq, &path);
    }
    let ok = rq.headers().iter().any(|h| h.field.equiv("X-Review-Token") && h.value.as_str() == token);
    if !ok {
        return send_json(rq, json!({"error": "forbidden"}), 403);
    }
    let state_file = app_dir().join("state.json");
    let mut body = String::new();
    if *rq.method() == Method::Post {
        let _ = rq.as_reader().read_to_string(&mut body);
    }
    match path.as_str() {
        "api/project" => {
            let src = SOURCE.get().expect("source");
            send_json(rq, json!({"found": src.media.is_some(), "name": src.name, "project": src.project}), 200);
        }
        "api/state" if *rq.method() == Method::Get => {
            let v = fs::read_to_string(&state_file).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or(Value::Null);
            send_json(rq, v, 200);
        }
        "api/state" => {
            let tmp = state_file.with_extension("tmp");
            let r = fs::write(&tmp, &body).and_then(|_| fs::rename(&tmp, &state_file));
            send_json(rq, json!({"ok": r.is_ok()}), if r.is_ok() { 200 } else { 500 });
        }
        "api/export" => {
            let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let name = safe_name(v["name"].as_str().unwrap_or(""));
            let out = output_dir().join(format!("ZFeedback_{name}_{}.html", stamp()));
            match fs::write(&out, v["html"].as_str().unwrap_or("")) {
                Ok(_) => send_json(rq, json!({"path": out.to_string_lossy()}), 200),
                Err(e) => send_json(rq, json!({"error": e.to_string()}), 500),
            }
        }
        "api/send" => {
            let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let html = v["html"].as_str().unwrap_or("").to_string();
            let sent = app_dir().join("sent");
            let _ = fs::create_dir_all(&sent);
            let _ = fs::write(sent.join(format!("ZFeedback_{}_{}.html", safe_name(v["name"].as_str().unwrap_or("")), stamp())), &html);
            match send_webhook(&v, &html) {
                Ok(_) => send_json(rq, json!({"ok": true}), 200),
                Err(e) => send_json(rq, json!({"error": e}), 200),
            }
        }
        "api/reveal" => {
            let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let p = PathBuf::from(v["path"].as_str().unwrap_or(""));
            let known = p.parent() == Some(output_dir().as_path()) && p.file_name().map(|f| f.to_string_lossy().starts_with("ZFeedback_")).unwrap_or(false);
            if known {
                let mut arg = std::ffi::OsString::from("/select,");
                arg.push(p.as_os_str());
                let _ = Command::new("explorer").arg(arg).spawn();
            }
            send_json(rq, json!({"ok": known}), 200);
        }
        _ => send_json(rq, json!({"error": "unknown"}), 404),
    }
}

fn main() {
    use tao::{
        dpi::LogicalSize,
        event::{Event, WindowEvent},
        event_loop::{ControlFlow, EventLoopBuilder},
        platform::windows::{IconExtWindows, WindowBuilderExtWindows},
        window::{Fullscreen, Icon, ResizeDirection, WindowBuilder},
    };
    use wry::{WebContext, WebViewBuilder};

    let _ = fs::create_dir_all(app_dir());
    let _ = SOURCE.set(locate());
    let mut bytes = [0u8; 16];
    let _ = getrandom::getrandom(&mut bytes);
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let srv = Arc::new(Server::http("127.0.0.1:0").expect("local server"));
    let port = srv.server_addr().to_ip().expect("port").port();
    for _ in 0..6 {
        let (s, t) = (srv.clone(), token.clone());
        std::thread::spawn(move || {
            for rq in s.incoming_requests() {
                handle(rq, &t);
            }
        });
    }

    let el = EventLoopBuilder::<String>::with_user_event().build();
    let window = WindowBuilder::new()
        .with_title("Z Feedback")
        .with_decorations(false)
        .with_undecorated_shadow(true)
        .with_inner_size(LogicalSize::new(1440.0, 900.0))
        .with_min_inner_size(LogicalSize::new(1060.0, 660.0))
        .with_window_icon(Icon::from_resource(1, None).ok())
        .build(&el)
        .expect("window");
    let proxy = el.create_proxy();
    let local = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    let mut ctx = WebContext::new(Some(PathBuf::from(local).join("ZFeedback").join("webview2")));
    let view = WebViewBuilder::with_web_context(&mut ctx)
        .with_url(format!("http://127.0.0.1:{port}/?t={token}"))
        .with_background_color((12, 12, 14, 255))
        .with_ipc_handler(move |r| {
            let _ = proxy.send_event(r.body().clone());
        })
        .build(&window)
        .expect("webview");
    el.run(move |ev, _, flow| {
        *flow = ControlFlow::Wait;
        match ev {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => *flow = ControlFlow::Exit,
            Event::WindowEvent { event: WindowEvent::Resized(_), .. } => {
                let _ = view.evaluate_script(&format!("document.body.classList.toggle('maxed',{})", window.is_maximized()));
            }
            Event::UserEvent(m) => match m.as_str() {
                "min" => window.set_minimized(true),
                "max" => window.set_maximized(!window.is_maximized()),
                "close" => *flow = ControlFlow::Exit,
                "drag" => {
                    let _ = window.drag_window();
                }
                "fs:on" => window.set_fullscreen(Some(Fullscreen::Borderless(None))),
                "fs:off" => window.set_fullscreen(None),
                other => {
                    let dir = match other {
                        "resize:n" => Some(ResizeDirection::North),
                        "resize:s" => Some(ResizeDirection::South),
                        "resize:e" => Some(ResizeDirection::East),
                        "resize:w" => Some(ResizeDirection::West),
                        "resize:ne" => Some(ResizeDirection::NorthEast),
                        "resize:nw" => Some(ResizeDirection::NorthWest),
                        "resize:se" => Some(ResizeDirection::SouthEast),
                        "resize:sw" => Some(ResizeDirection::SouthWest),
                        _ => None,
                    };
                    if let Some(d) = dir {
                        let _ = window.drag_resize_window(d);
                    }
                }
            },
            _ => {}
        }
    });
}
