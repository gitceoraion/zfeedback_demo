use std::{env, fs};

fn from_dotenv() -> String {
    let text = fs::read_to_string("../.env").unwrap_or_default();
    text.lines()
        .filter_map(|l| l.trim().strip_prefix("Z_WEBHOOK_URL="))
        .map(|v| v.trim().trim_matches('"').to_string())
        .next()
        .unwrap_or_default()
}

fn main() {
    println!("cargo:rerun-if-changed=../web");
    println!("cargo:rerun-if-changed=../icon.ico");
    println!("cargo:rerun-if-changed=../.env");
    println!("cargo:rerun-if-env-changed=Z_WEBHOOK_URL");
    let url = env::var("Z_WEBHOOK_URL").unwrap_or_else(|_| from_dotenv());
    println!("cargo:rustc-env=Z_WEBHOOK={}", url.trim());
    let mut r = winresource::WindowsResource::new();
    r.set_icon("../icon.ico");
    r.compile().expect("icon resource");
}
