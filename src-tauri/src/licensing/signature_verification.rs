use kaleidomo_core::software_licensor_static_rust_lib::tamper_detection::verify_sig;
/// Crashes the program when the cert is invalid or identity does not match.
/// 
/// Returns 1 if success.
pub fn verify_cert() -> u8 {
    //#[cfg(all(target_os = "windows", not(debug_assertions)))]
    {
        #[cfg(target_os = "windows")]
        if let Err(e) = verify_sig("Hyperformance Solutions LLC", "Hyperformance Solutions LLC", None) {
            eprintln!("[FATAL] {e}");
            //std::process::exit(1);
            let arr = Vec::new();
            return arr[0];
        }
        #[cfg(target_os = "macos")]
        if let Err(e) = verify_sig("Developer ID Application: Noah Stiltner (WK272386LM)", "Noah Stiltner", "WK272386LM") {
            eprintln!("[FATAL] {e}");
            let arr = Vec::new();
            return arr[0];
        }
    }
    return 1;
}