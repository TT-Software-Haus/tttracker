//! Screen capture of the Hearthstone window for the tracker's main process.
//! See PLAN.md, "native capture in Rust".
//!
//! One Windows Graphics Capture session on the game window, kept open between
//! reads. A read takes the newest frame and copies only the top `fraction` of
//! it, shrunk on the GPU with mipmaps, back to the CPU. Chromium's stream, which
//! this replaces, copied back a whole frame per read.
//!
//! Everything runs on the JS thread that calls in (Electron's main thread), so
//! the session lives in a thread-local and needs no locking. The frame pool is
//! free-threaded and polled, so no message loop or dispatcher is needed.

use std::cell::RefCell;

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use windows::core::{factory, Interface, w, PCWSTR};
use windows::Graphics::Capture::{Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::{HMODULE, HWND};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, IsIconic};

#[napi(object)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    /// BGRA, `width * height * 4` bytes, like Electron's NativeImage.toBitmap().
    pub bgra: Buffer,
}

struct Session {
    hwnd: HWND,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    winrt_device: IDirect3DDevice,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    size: SizeInt32,
    /// The newest frame seen. Window capture only sends a frame when the window
    /// changes, so a read with nothing new reuses this.
    last: Option<Direct3D11CaptureFrame>,
    /// Scratch textures, kept while the sizes they were made for still apply.
    mips: Option<(ID3D11Texture2D, ID3D11ShaderResourceView, (u32, u32, u32))>,
    staging: Option<(ID3D11Texture2D, (u32, u32))>,
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(f) = self.last.take() {
            let _ = f.Close();
        }
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

thread_local! {
    static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
    // Leaked, never dropped: releasing them while the process exits made it
    // exit with code 122 (tested in Node). One set per process (or per driver
    // reset), and Windows reclaims them at exit anyway.
    static DEVICES: RefCell<Option<&'static Devices>> = const { RefCell::new(None) };
}

type R<T> = windows::core::Result<T>;

fn napi_err(e: windows::core::Error) -> napi::Error {
    napi::Error::from_reason(format!("capture: {} ({:?})", e.message(), e.code()))
}

/// The game window, by title like the rest of the app; None if it isn't
/// running or is minimised (a minimised window captures as nothing).
fn game_window() -> Option<HWND> {
    let hwnd = unsafe { FindWindowW(PCWSTR::null(), w!("Hearthstone")) }.ok()?;
    if hwnd.is_invalid() || unsafe { IsIconic(hwnd) }.as_bool() {
        return None;
    }
    Some(hwnd)
}

/// The Direct3D device, made once and shared by every session. Making it is
/// most of the cost of opening a session (~300ms the first time in a process),
/// so main calls `warm()` at launch, before any overlay has put its mouse hook
/// on this thread; reopening a session later then costs a fraction of that.
type Devices = (ID3D11Device, ID3D11DeviceContext, IDirect3DDevice);

fn devices() -> R<Devices> {
    DEVICES.with_borrow_mut(|d| {
        if d.is_none() {
            *d = Some(Box::leak(Box::new(make_devices()?)));
        }
        Ok(d.unwrap().clone())
    })
}

fn make_devices() -> R<Devices> {
    // Electron has usually set the thread's apartment up already; a mismatch
    // error just means it has, and WinRT works either way.
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };

    let mut device = None;
    let mut context = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
    }
    let device = device.unwrap();
    let context = context.unwrap();
    let winrt_device: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&device.cast::<IDXGIDevice>()?)? }.cast()?;
    // Load the capture classes now too, so the first session doesn't pay for it.
    factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    Ok((device, context, winrt_device))
}

fn open(hwnd: HWND) -> R<Session> {
    let (device, context, winrt_device) = devices()?;
    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    let item: GraphicsCaptureItem = unsafe { interop.CreateForWindow(hwnd)? };
    let size = item.Size()?;
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&winrt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size)?;
    let session = pool.CreateCaptureSession(&item)?;
    // The cursor over a card would be read as part of it. The yellow border
    // Windows draws around a captured window is optional on Windows 11; older
    // builds refuse, and then it stays.
    let _ = session.SetIsCursorCaptureEnabled(false);
    let _ = session.SetIsBorderRequired(false);
    session.StartCapture()?;
    Ok(Session { hwnd, device, context, winrt_device, pool, session, size, last: None, mips: None, staging: None })
}

impl Session {
    /// The newest frame, or None if the session hasn't sent one yet. Never
    /// waits: this runs on Electron's main thread, which carries the overlays'
    /// mouse hook, and sleeping here for a fresh session's first frame froze
    /// the cursor for 300-400ms at every shop (seen with --profile). Callers
    /// retry anyway.
    fn latest(&mut self) -> R<Option<Direct3D11CaptureFrame>> {
        // Drain to the newest; the older ones go back to the pool.
        while let Ok(f) = self.pool.TryGetNextFrame() {
            if let Some(old) = self.last.replace(f) {
                let _ = old.Close();
            }
        }
        let Some(frame) = self.last.clone() else { return Ok(None) };
        // The window was resized: later frames come at the new size.
        let content = frame.ContentSize()?;
        if content != self.size {
            self.size = content;
            self.pool.Recreate(&self.winrt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, content)?;
        }
        Ok(Some(frame))
    }

    fn read(&mut self, height: u32, fraction: f64) -> R<Option<Frame>> {
        let Some(frame) = self.latest()? else { return Ok(None) };
        let src: ID3D11Texture2D = unsafe { frame.Surface()?.cast::<IDirect3DDxgiInterfaceAccess>()?.GetInterface()? };
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { src.GetDesc(&mut desc) };
        let content = frame.ContentSize()?;
        // The pool's textures can be larger than the window; only the content counts.
        let full_w = (content.Width.max(1) as u32).min(desc.Width);
        let full_h = (content.Height.max(1) as u32).min(desc.Height);
        let height = height.clamp(1, full_h);

        // The smallest mip level still at least `height` tall: everything below
        // it is averaged on the GPU and never crosses to the CPU.
        let mut level = 0;
        while (full_h >> (level + 1)) >= height {
            level += 1;
        }
        let step = 1u32 << level;
        let strip_w = full_w;
        let strip_h = (((full_h as f64 * fraction.clamp(0.0, 1.0)).ceil() as u32).div_ceil(step) * step).clamp(step, full_h - full_h % step);

        let ctx = self.context.clone();
        let strip_box = D3D11_BOX { left: 0, top: 0, front: 0, right: strip_w, bottom: strip_h, back: 1 };
        let (lw, lh) = ((strip_w >> level).max(1), (strip_h >> level).max(1));
        let staging = self.staging_texture(lw, lh)?;
        if level == 0 {
            unsafe { ctx.CopySubresourceRegion(&staging, 0, 0, 0, 0, &src, 0, Some(&strip_box)) };
        } else {
            let (mips, view) = self.mip_texture(strip_w, strip_h, level + 1)?;
            unsafe {
                ctx.CopySubresourceRegion(&mips, 0, 0, 0, 0, &src, 0, Some(&strip_box));
                ctx.GenerateMips(&view);
                ctx.CopySubresourceRegion(&staging, 0, 0, 0, 0, &mips, level, None);
            }
        }

        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe { ctx.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))? };
        let pitch = mapped.RowPitch as usize;
        let data = unsafe { std::slice::from_raw_parts(mapped.pData as *const u8, pitch * lh as usize) };

        // Output is the whole frame at `height`; only the strip is filled in.
        // Box filter from the mip level down to the exact size asked for.
        let out_h = height;
        let out_w = ((full_w as f64 * out_h as f64 / full_h as f64).round() as u32).max(1);
        let scale = (full_h as f64 / step as f64) / out_h as f64; // mip-level pixels per output pixel
        let rows = ((lh as f64 / scale).floor() as u32).min(out_h);
        let mut out = vec![0u8; (out_w * out_h * 4) as usize];
        for y in 0..rows {
            let sy0 = (y as f64 * scale) as u32;
            let sy1 = (((y + 1) as f64 * scale) as u32).clamp(sy0 + 1, lh);
            for x in 0..out_w {
                let sx0 = ((x as f64 * scale) as u32).min(lw - 1);
                let sx1 = (((x + 1) as f64 * scale) as u32).clamp(sx0 + 1, lw);
                let (mut b, mut g, mut r, mut n) = (0u32, 0u32, 0u32, 0u32);
                for sy in sy0..sy1 {
                    let row = &data[sy as usize * pitch..];
                    for sx in sx0..sx1 {
                        let i = sx as usize * 4;
                        b += row[i] as u32;
                        g += row[i + 1] as u32;
                        r += row[i + 2] as u32;
                        n += 1;
                    }
                }
                let o = ((y * out_w + x) * 4) as usize;
                out[o] = (b / n) as u8;
                out[o + 1] = (g / n) as u8;
                out[o + 2] = (r / n) as u8;
                out[o + 3] = 255;
            }
        }
        unsafe { ctx.Unmap(&staging, 0) };
        Ok(Some(Frame { width: out_w, height: out_h, bgra: out.into() }))
    }

    fn staging_texture(&mut self, w: u32, h: u32) -> R<ID3D11Texture2D> {
        if let Some((t, size)) = &self.staging {
            if *size == (w, h) {
                return Ok(t.clone());
            }
        }
        let desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut t = None;
        unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut t))? };
        let t = t.unwrap();
        self.staging = Some((t.clone(), (w, h)));
        Ok(t)
    }

    fn mip_texture(&mut self, w: u32, h: u32, levels: u32) -> R<(ID3D11Texture2D, ID3D11ShaderResourceView)> {
        if let Some((t, v, size)) = &self.mips {
            if *size == (w, h, levels) {
                return Ok((t.clone(), v.clone()));
            }
        }
        let desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: levels,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            // GenerateMips needs both.
            BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: D3D11_RESOURCE_MISC_GENERATE_MIPS.0 as u32,
        };
        let mut t = None;
        let mut v = None;
        unsafe {
            self.device.CreateTexture2D(&desc, None, Some(&mut t))?;
            self.device.CreateShaderResourceView(t.as_ref().unwrap(), None, Some(&mut v))?;
        }
        let (t, v) = (t.unwrap(), v.unwrap());
        self.mips = Some((t.clone(), v.clone(), (w, h, levels)));
        Ok((t, v))
    }
}

/// The Hearthstone window at `height` (width follows the window), with only
/// the top `fraction` of its rows filled in; the rest are zero. Undefined if
/// the game isn't running, is minimised, or hasn't sent a frame yet. Opens the
/// capture session on first use and keeps it until `close()`.
#[napi]
pub fn frame(height: u32, fraction: f64) -> napi::Result<Option<Frame>> {
    let Some(hwnd) = game_window() else {
        close();
        return Ok(None);
    };
    SESSION.with_borrow_mut(|s| {
        // A restarted game is a new window.
        if s.as_ref().is_some_and(|s| s.hwnd != hwnd) {
            *s = None;
        }
        if s.is_none() {
            *s = Some(open(hwnd).map_err(napi_err)?);
        }
        let result = s.as_mut().unwrap().read(height, fraction);
        if result.is_err() {
            // Start afresh next time rather than retrying a broken session,
            // or a lost device (a driver reset, say).
            *s = None;
            DEVICES.with_borrow_mut(|d| *d = None);
        }
        result.map_err(napi_err)
    })
}

/// Make the Direct3D device ahead of the first capture (see `devices()`).
#[napi]
pub fn warm() -> napi::Result<()> {
    devices().map(|_| ()).map_err(napi_err)
}

/// Stop capturing until the next `frame()`.
#[napi]
pub fn close() {
    SESSION.with_borrow_mut(|s| *s = None);
}
