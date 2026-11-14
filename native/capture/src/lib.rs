//! Screen capture of the Hearthstone window for the tracker's main process.
//! See PLAN.md, "native capture in Rust".

use napi_derive::napi;

/// Proves the module loaded; replaced by the capture API in M17.
#[napi]
pub fn ping() -> String {
    "capture".to_string()
}
