fn main() {
    // The screencapturekit crate links a Swift static library that
    // depends on `@rpath/libswift_Concurrency.dylib`. Its own build.rs
    // emits the right `-rpath` link args, but those only apply to the
    // sckit crate's own bins/tests — they don't propagate into the
    // bins/examples of *consuming* crates. We replicate them here so
    // our `cargo run --example sckit_spike` (and any future bins)
    // can find the Swift runtime at startup.
    //
    // Keep these in sync with `screencapturekit-rs/build.rs`. The
    // first path is where the Swift runtime ships on macOS 12+
    // (system); the second is the Xcode toolchain fallback for
    // when system runtime predates Concurrency.
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
        // /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/...
        // is the Xcode-side Swift runtime; keep it as a fallback for
        // older macOS targets that don't have Concurrency in the
        // system path yet.
        println!("cargo:rustc-link-arg=-Wl,-rpath,/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/macosx");
    }

    tauri_build::build()
}
