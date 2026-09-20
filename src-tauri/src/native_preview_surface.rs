//! macOS live-preview presentation directly into an AppKit/Metal surface.
//!
//! The view is installed above WKWebView at the DOM canvas rectangle. Frames
//! stay on the GPU: compute texture -> fullscreen blit -> CAMetalLayer.

#![cfg(target_os = "macos")]

use std::sync::{Arc, Mutex};

use objc2::{define_class, msg_send, rc::Retained, MainThreadOnly};
use objc2_app_kit::{NSClipView, NSScrollView, NSView};
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};
use tauri::{State, WebviewWindow};

use crate::{AppState, live_preview::LivePreviewParams};

define_class!(
    #[unsafe(super(NSView))]
    #[name = "KaleidomoPreviewView"]
    struct PreviewView;

    impl PreviewView {
        // Keep DOM interactions (including fullscreen click-to-exit) working
        // even though this native view is visually above WKWebView.
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, _point: NSPoint) -> *mut NSView {
            std::ptr::null_mut()
        }
    }
);

struct MountedSurface {
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    stage_ptr: usize,
    view_ptr: usize,
}

// The AppKit object itself remains owned by its superview and is only touched
// on the main thread. The stored integer is an identity used by main-thread
// resize/removal closures; it is never dereferenced on a worker thread.
unsafe impl Send for MountedSurface {}

#[derive(Clone, Default)]
pub struct NativePreviewSurfaceState {
    inner: Arc<Mutex<Option<MountedSurface>>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePreviewRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub content_x: f64,
    pub content_y: f64,
    pub content_width: f64,
    pub content_height: f64,
    pub device_pixel_ratio: f64,
    #[serde(default = "default_visible")]
    pub visible: bool,
}

fn default_visible() -> bool { true }

fn apply_view_clipping(view: &NSView, visible: bool) {
    view.setHidden(!visible);
    if let Some(layer) = view.layer() {
        layer.setMasksToBounds(true);
        layer.setCornerRadius(8.0);
    }
}

fn content_frame(rect: &NativePreviewRect) -> NSRect {
    NSRect::new(
        NSPoint::new(
            rect.content_x,
            rect.height - rect.content_y - rect.content_height,
        ),
        NSSize::new(rect.content_width.max(1.0), rect.content_height.max(1.0)),
    )
}

fn appkit_frame(viewport: &NSView, rect: &NativePreviewRect) -> NSRect {
    let bounds = viewport.bounds();
    let y = if viewport.isFlipped() {
        bounds.origin.y + rect.y
    } else {
        bounds.origin.y + bounds.size.height - rect.y - rect.height
    };
    NSRect::new(
        NSPoint::new(bounds.origin.x + rect.x, y),
        NSSize::new(rect.width.max(1.0), rect.height.max(1.0)),
    )
}

fn find_scroll_view(root: &NSView) -> Option<Retained<NSScrollView>> {
    let subviews = root.subviews();
    for index in 0..subviews.count() {
        let subview = subviews.objectAtIndex(index);
        match subview.downcast::<NSScrollView>() {
            Ok(scroll_view) => return Some(scroll_view),
            Err(subview) => {
                if let Some(scroll_view) = find_scroll_view(&subview) {
                    return Some(scroll_view);
                }
            }
        }
    }
    None
}

fn webkit_viewport(webview: &NSView) -> Result<Retained<NSClipView>, String> {
    find_scroll_view(webview)
        .map(|scroll_view| scroll_view.contentView())
        .ok_or_else(|| "could not locate WKWebView's native scroll viewport".to_string())
}

async fn webview_ptr(window: &WebviewWindow) -> Result<usize, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window.with_webview(move |webview| {
        let _ = tx.send(webview.inner() as usize);
    }).map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "failed to obtain WKWebView pointer".to_string())
}

#[tauri::command]
pub async fn mount_native_preview_surface(
    window: WebviewWindow,
    app: State<'_, AppState>,
    native: State<'_, NativePreviewSurfaceState>,
    rect: NativePreviewRect,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("native preview can only be mounted in the main window".into());
    }

    let gpu_arc = Arc::clone(&app.gpu_arc);
    let native_inner = Arc::clone(&native.inner);
    let webview = webview_ptr(&window).await?;
    let (tx, rx) = tokio::sync::oneshot::channel();

    window.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            let mtm = MainThreadMarker::new().ok_or("AppKit operation was not on the main thread")?;
            let webview = unsafe { &*(webview as *const NSView) };
            let viewport = webkit_viewport(webview)?;

            if let Some(previous) = native_inner.lock().map_err(|_| "native preview mutex poisoned")?.take() {
                let old = unsafe { &*(previous.stage_ptr as *const NSView) };
                old.removeFromSuperview();
            }

            let stage: Retained<PreviewView> = unsafe {
                msg_send![PreviewView::alloc(mtm), initWithFrame: appkit_frame(&viewport, &rect)]
            };
            stage.setWantsLayer(true);
            apply_view_clipping(&stage, rect.visible);
            viewport.addSubview(&stage);

            let view: Retained<PreviewView> = unsafe {
                msg_send![PreviewView::alloc(mtm), initWithFrame: content_frame(&rect)]
            };
            view.setWantsLayer(true);
            stage.addSubview(&view);

            let stage_ptr = Retained::as_ptr(&stage) as usize;
            let view_ptr = Retained::as_ptr(&view) as usize;
            let mut gpu = gpu_arc.lock().map_err(|_| "GPU mutex poisoned")?;
            let gpu = gpu.as_mut().ok_or("GPU backend unavailable")?;
            let surface = unsafe {
                gpu.create_appkit_surface(
                    std::ptr::NonNull::new(view_ptr as *mut std::ffi::c_void)
                        .ok_or("native preview view pointer was null")?,
                )
            }.map_err(|e| e.to_string())?;

            let format = wgpu::TextureFormat::Bgra8Unorm;
            gpu.prepare_direct_surface(format).map_err(|e| e.to_string())?;
            let dpr = rect.device_pixel_ratio.clamp(1.0, 4.0);
            let config = wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                format,
                width: (rect.content_width * dpr).round().max(1.0) as u32,
                height: (rect.content_height * dpr).round().max(1.0) as u32,
                present_mode: wgpu::PresentMode::Fifo,
                alpha_mode: wgpu::CompositeAlphaMode::Opaque,
                view_formats: vec![],
                desired_maximum_frame_latency: 2,
            };
            gpu.configure_surface(&surface, &config);
            *native_inner.lock().map_err(|_| "native preview mutex poisoned")? =
                Some(MountedSurface { surface, config, stage_ptr, view_ptr });
            Ok(())
        })();
        let _ = tx.send(result);
    }).map_err(|e| e.to_string())?;

    rx.await.map_err(|_| "native preview mount was cancelled".to_string())?
}

#[tauri::command]
pub async fn unmount_native_preview_surface(
    window: WebviewWindow,
    native: State<'_, NativePreviewSurfaceState>,
) -> Result<(), String> {
    let native_inner = Arc::clone(&native.inner);
    let (tx, rx) = tokio::sync::oneshot::channel();
    window.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            if let Some(mounted) = native_inner.lock().map_err(|_| "native preview mutex poisoned")?.take() {
                let stage = unsafe { &*(mounted.stage_ptr as *const NSView) };
                stage.removeFromSuperview();
            }
            Ok(())
        })();
        let _ = tx.send(result);
    }).map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "native preview unmount was cancelled".to_string())?
}

#[tauri::command]
pub async fn update_native_preview_surface(
    window: WebviewWindow,
    app: State<'_, AppState>,
    native: State<'_, NativePreviewSurfaceState>,
    rect: NativePreviewRect,
) -> Result<(), String> {
    let native_inner = Arc::clone(&native.inner);
    let gpu_arc = Arc::clone(&app.gpu_arc);
    let webview = webview_ptr(&window).await?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    window.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            let webview = unsafe { &*(webview as *const NSView) };
            let viewport = webkit_viewport(webview)?;
            let mut mounted = native_inner.lock().map_err(|_| "native preview mutex poisoned")?;
            let mounted = mounted.as_mut().ok_or("native preview surface is not mounted")?;
            let stage = unsafe { &*(mounted.stage_ptr as *const NSView) };
            stage.setFrame(appkit_frame(&viewport, &rect));
            apply_view_clipping(stage, rect.visible);
            let view = unsafe { &*(mounted.view_ptr as *const NSView) };
            view.setFrame(content_frame(&rect));

            let dpr = rect.device_pixel_ratio.clamp(1.0, 4.0);
            let width = (rect.content_width * dpr).round().max(1.0) as u32;
            let height = (rect.content_height * dpr).round().max(1.0) as u32;
            if mounted.config.width != width || mounted.config.height != height {
                mounted.config.width = width;
                mounted.config.height = height;
                let gpu = gpu_arc.lock().map_err(|_| "GPU mutex poisoned")?;
                let gpu = gpu.as_ref().ok_or("GPU backend unavailable")?;
                gpu.configure_surface(&mounted.surface, &mounted.config);
            }
            Ok(())
        })();
        let _ = tx.send(result);
    }).map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "native preview layout update was cancelled".to_string())?
}

#[tauri::command]
pub fn present_native_preview_frame(
    app: State<'_, AppState>,
    native: State<'_, NativePreviewSurfaceState>,
    params: LivePreviewParams,
) -> Result<(), String> {
    let mut settings = params.to_kaleido_settings()?;
    settings.triangle_center_x = settings.triangle_center_x.clamp(0.0, params.img_width.saturating_sub(1) as f32);
    settings.triangle_center_y = settings.triangle_center_y.clamp(0.0, params.img_height.saturating_sub(1) as f32);

    let factor = kaleidomo_core::safe_super_sample(
        settings.super_sample,
        settings.output_size_w,
        settings.output_size_h,
    );
    if factor > 1 {
        settings.output_size_w *= factor as u32;
        settings.output_size_h *= factor as u32;
        settings.offset_x *= factor as i32;
        settings.offset_y *= factor as i32;
        settings.zoom *= factor as f32;
        settings.super_sample = 1;
    }

    let mut mounted = native.inner.lock().map_err(|_| "native preview mutex poisoned")?;
    let mounted = mounted.as_mut().ok_or("native preview surface is not mounted")?;
    let frame = match mounted.surface.get_current_texture() {
        wgpu::CurrentSurfaceTexture::Success(frame)
        | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
        wgpu::CurrentSurfaceTexture::Lost | wgpu::CurrentSurfaceTexture::Outdated => {
            let gpu = app.gpu_arc.lock().map_err(|_| "GPU mutex poisoned")?;
            let gpu = gpu.as_ref().ok_or("GPU backend unavailable")?;
            gpu.configure_surface(&mounted.surface, &mounted.config);
            return Ok(());
        }
        wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => return Ok(()),
        wgpu::CurrentSurfaceTexture::Validation => return Err("native preview surface validation error".into()),
    };
    let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
    let mut gpu = app.gpu_arc.lock().map_err(|_| "GPU mutex poisoned")?;
    let gpu = gpu.as_mut().ok_or("GPU backend unavailable")?;
    gpu.render_directly_to_view_with_internal_uniform(&settings, &view, mounted.config.format)
        .map_err(|e| e.to_string())?;
    frame.present();
    Ok(())
}
