//! Saves a copy of a page shown in a child webview (the Songsterr page), for
//! viewing offline: the whole page, not just what is on screen. Each platform's
//! webview captures it its own way:
//! - Windows (WebView2): the DevTools protocol makes the viewport as tall as the
//!   page, then captures it in strips of PNG (one huge image would hit Chromium's
//!   texture limits);
//! - macOS (WKWebView): `createPDF`, the whole page as one PDF;
//! - Linux (WebKitGTK): a full-document snapshot, as one PNG.
//!
//! Before capturing, a script expands the page's inner scroll areas and scrolls
//! through it, so content drawn only when on screen is drawn; afterwards it puts
//! the page back as it was. The copy is for the user's own offline use.
// Android has no embedded pages to capture: only the desktop builds use this.
#![cfg_attr(not(desktop), allow(dead_code))]

use tauri::{AppHandle, Runtime};

/// What a part of a saved page holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PartKind {
    Png = 0,
    /// macOS only (WKWebView's createPDF).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Pdf = 1,
}

/// The binary answer of `snapshot_webview`: "GFSN", a version byte, the number of
/// parts (u32 LE), then each part as kind (u8), length (u32 LE) and bytes. The UI
/// reads it in `offline.ts` (`parseSnapshot`).
pub fn encode_parts(parts: &[(PartKind, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::with_capacity(9 + parts.iter().map(|(_, b)| 5 + b.len()).sum::<usize>());
    out.extend_from_slice(b"GFSN");
    out.push(1);
    out.extend_from_slice(&(parts.len() as u32).to_le_bytes());
    for (kind, bytes) in parts {
        out.push(*kind as u8);
        out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(bytes);
    }
    out
}

/// Expands the page's scroll areas, scrolls through it so lazily drawn parts are
/// drawn, and returns `{ width, height }` (CSS px) of the whole page. What it
/// changes is kept in `window.__gfSnapshot` for RESTORE_JS.
pub const PREP_JS: &str = r#"(async () => {
  const st = (window.__gfSnapshot = { scroll: [scrollX, scrollY], changed: [] });
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (el.clientHeight > 150 && el.scrollHeight > el.clientHeight + 50 && /(auto|scroll)/.test(cs.overflowY)) {
      st.changed.push([el, el.getAttribute("style")]);
      el.style.setProperty("overflow", "visible", "important");
      el.style.setProperty("height", "auto", "important");
      el.style.setProperty("max-height", "none", "important");
    }
  }
  const height = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  for (let y = 0; y < height(); y += Math.max(200, innerHeight * 0.8)) {
    scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 60));
  }
  scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 250));
  return { width: document.documentElement.clientWidth, height: height() };
})()"#;

/// Puts back what PREP_JS changed: inline styles and the scroll position.
pub const RESTORE_JS: &str = r#"(() => {
  const st = window.__gfSnapshot;
  if (!st) return;
  for (const [el, style] of st.changed) {
    if (style == null) el.removeAttribute("style");
    else el.setAttribute("style", style);
  }
  scrollTo(st.scroll[0], st.scroll[1]);
  delete window.__gfSnapshot;
})()"#;

/// Strips' height on Windows, in CSS px: well under Chromium's texture limits.
pub const STRIP: f64 = 4096.0;
/// The page is never captured taller than this (CSS px), so a page that keeps
/// growing can't make an endless capture.
pub const MAX_HEIGHT: f64 = 120_000.0;

/// The strips (top, height) that cover a page `height` CSS px tall.
pub fn strips(height: f64) -> Vec<(f64, f64)> {
    let h = height.clamp(1.0, MAX_HEIGHT).ceil();
    let mut out = Vec::new();
    let mut y = 0.0;
    while y < h {
        out.push((y, STRIP.min(h - y)));
        y += STRIP;
    }
    out
}

/// Captures the child webview `label` (the Songsterr page) as a saved page.
#[tauri::command]
pub async fn snapshot_webview<R: Runtime>(app: AppHandle<R>, label: String) -> Result<tauri::ipc::Response, String> {
    if !label.starts_with("embed-") {
        return Err("only the embedded page can be saved".into());
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("Saving pages works in the desktop app only".into())
    }
    #[cfg(desktop)]
    capture_page(app, label).await
}

#[cfg(desktop)]
async fn capture_page<R: Runtime>(app: AppHandle<R>, label: String) -> Result<tauri::ipc::Response, String> {
    use tauri::Manager;
    let webview = app.get_webview(&label).ok_or("The page isn't open any more")?;
    let parts = imp::capture(&webview).await;
    // Whatever happened, give the page back its layout and scroll.
    let _ = webview.eval(RESTORE_JS);
    let parts = parts?;
    if parts.is_empty() {
        return Err("The page came out empty".into());
    }
    Ok(tauri::ipc::Response::new(encode_parts(&parts)))
}

/// Waits without holding an async worker thread.
#[cfg(desktop)]
async fn pause(ms: u64) {
    let _ =
        tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms))).await;
}

/// Waits for a value a webview callback sends, without blocking the async runtime.
#[cfg(desktop)]
async fn receive<T: Send + 'static>(rx: std::sync::mpsc::Receiver<Result<T, String>>, secs: u64) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(secs)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "The page took too long to answer".to_string())?
}

#[cfg(target_os = "windows")]
mod imp {
    use base64::Engine;
    use serde_json::{json, Value};
    use tauri::{Runtime, Webview};
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::HSTRING;

    use super::{pause, receive, strips, PartKind, PREP_JS};

    /// One DevTools protocol call on the webview; its JSON answer.
    async fn cdp<R: Runtime>(webview: &Webview<R>, method: &'static str, params: Value) -> Result<Value, String> {
        let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
        let params = params.to_string();
        webview
            .with_webview(move |pw| {
                let tx2 = tx.clone();
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |res, json| {
                    let _ = tx2.send(res.map(|_| json).map_err(|e| e.to_string()));
                    Ok(())
                }));
                // SAFETY: called on the webview's thread (with_webview), with a live controller.
                let sent = unsafe {
                    pw.controller().CoreWebView2().and_then(|core| {
                        core.CallDevToolsProtocolMethod(&HSTRING::from(method), &HSTRING::from(params), &handler)
                    })
                };
                if let Err(e) = sent {
                    let _ = tx.send(Err(e.to_string()));
                }
            })
            .map_err(|e| e.to_string())?;
        let answer = receive(rx, 60).await.map_err(|e| format!("{method}: {e}"))?;
        serde_json::from_str(&answer).map_err(|e| format!("{method}: {e}"))
    }

    pub async fn capture<R: Runtime>(webview: &Webview<R>) -> Result<Vec<(PartKind, Vec<u8>)>, String> {
        let prep = cdp(
            webview,
            "Runtime.evaluate",
            json!({ "expression": PREP_JS, "awaitPromise": true, "returnByValue": true }),
        )
        .await?;
        let size = &prep["result"]["value"];
        let width = size["width"].as_f64().filter(|w| *w > 0.0).ok_or("The page has no size")?;
        let height = size["height"].as_f64().filter(|h| *h > 0.0).ok_or("The page has no size")?;
        // A viewport as tall as the page: everything is "on screen", so it is all drawn.
        let tall = strips(height).last().map(|(y, h)| y + h).unwrap_or(height);
        cdp(
            webview,
            "Emulation.setDeviceMetricsOverride",
            json!({ "width": width.round(), "height": tall, "deviceScaleFactor": 0, "mobile": false }),
        )
        .await?;
        pause(1200).await;
        let mut parts = Vec::new();
        let mut result = Ok(());
        for (y, h) in strips(height) {
            let shot = cdp(
                webview,
                "Page.captureScreenshot",
                json!({ "format": "png", "clip": { "x": 0, "y": y, "width": width.round(), "height": h, "scale": 1 } }),
            )
            .await;
            match shot.and_then(|v| {
                let data = v["data"].as_str().ok_or("no image in the answer")?.to_string();
                base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())
            }) {
                Ok(png) => parts.push((PartKind::Png, png)),
                Err(e) => {
                    result = Err(e);
                    break;
                }
            }
        }
        let _ = cdp(webview, "Emulation.clearDeviceMetricsOverride", json!({})).await;
        result.map(|()| parts)
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use block2::RcBlock;
    use objc2_foundation::{NSData, NSError};
    use objc2_web_kit::WKWebView;
    use tauri::{Runtime, Webview};

    use super::{pause, receive, PartKind, PREP_JS};

    pub async fn capture<R: Runtime>(webview: &Webview<R>) -> Result<Vec<(PartKind, Vec<u8>)>, String> {
        webview.eval(PREP_JS).map_err(|e| e.to_string())?;
        // PREP_JS scrolls through the page; give it time to finish.
        pause(3000).await;
        let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<u8>, String>>();
        webview
            .with_webview(move |pw| {
                // SAFETY: on macOS `inner()` is the WKWebView, used on its (main) thread.
                let view: &WKWebView = unsafe { &*(pw.inner() as *const WKWebView) };
                let block = RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
                    // SAFETY: WebKit passes valid (or null) pointers for the call's duration.
                    let answer = match (unsafe { data.as_ref() }, unsafe { error.as_ref() }) {
                        (Some(data), _) => Ok(data.to_vec()),
                        (None, Some(error)) => Err(error.localizedDescription().to_string()),
                        (None, None) => Err("WebKit made no PDF".to_string()),
                    };
                    let _ = tx.send(answer);
                });
                // SAFETY: no configuration means the whole page; the block lives until called.
                unsafe { view.createPDFWithConfiguration_completionHandler(None, &block) };
            })
            .map_err(|e| e.to_string())?;
        Ok(vec![(PartKind::Pdf, receive(rx, 60).await?)])
    }
}

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
mod imp {
    use tauri::{Runtime, Webview};
    use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

    use super::{pause, receive, PartKind, PREP_JS};

    pub async fn capture<R: Runtime>(webview: &Webview<R>) -> Result<Vec<(PartKind, Vec<u8>)>, String> {
        webview.eval(PREP_JS).map_err(|e| e.to_string())?;
        // PREP_JS scrolls through the page; give it time to finish.
        pause(3000).await;
        let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<u8>, String>>();
        webview
            .with_webview(move |pw| {
                pw.inner().snapshot(
                    SnapshotRegion::FullDocument,
                    SnapshotOptions::NONE,
                    None::<&webkit2gtk::gio::Cancellable>,
                    move |res| {
                        let png = res.map_err(|e| e.to_string()).and_then(|surface| {
                            let image =
                                cairo::ImageSurface::try_from(surface).map_err(|_| "not an image".to_string())?;
                            let mut out = Vec::new();
                            image.write_to_png(&mut out).map_err(|e| e.to_string())?;
                            Ok(out)
                        });
                        let _ = tx.send(png);
                    },
                );
            })
            .map_err(|e| e.to_string())?;
        Ok(vec![(PartKind::Png, receive(rx, 60).await?)])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_parts_for_the_ui() {
        let out = encode_parts(&[(PartKind::Png, vec![1, 2, 3]), (PartKind::Pdf, vec![9])]);
        assert_eq!(&out[..4], b"GFSN");
        assert_eq!(out[4], 1);
        assert_eq!(u32::from_le_bytes(out[5..9].try_into().unwrap()), 2);
        assert_eq!(out[9], 0);
        assert_eq!(u32::from_le_bytes(out[10..14].try_into().unwrap()), 3);
        assert_eq!(&out[14..17], &[1, 2, 3]);
        assert_eq!(out[17], 1);
        assert_eq!(u32::from_le_bytes(out[18..22].try_into().unwrap()), 1);
        assert_eq!(out[22], 9);
        assert_eq!(out.len(), 23);
    }

    #[test]
    fn strips_cover_the_page() {
        assert_eq!(strips(1000.0), vec![(0.0, 1000.0)]);
        assert_eq!(strips(9000.5), vec![(0.0, 4096.0), (4096.0, 4096.0), (8192.0, 809.0)]);
        assert_eq!(strips(0.0), vec![(0.0, 1.0)]);
        // Capped, so a page that never stops growing can't make an endless capture.
        assert_eq!(strips(1e9).iter().map(|(_, h)| h).sum::<f64>(), MAX_HEIGHT);
    }

    #[test]
    fn the_scripts_restore_what_they_change() {
        assert!(PREP_JS.contains("__gfSnapshot") && RESTORE_JS.contains("__gfSnapshot"));
        assert!(RESTORE_JS.contains("scrollTo"));
    }
}
