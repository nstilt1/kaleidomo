cargo build --release --target wasm32-unknown-unknown

wasm-bindgen --target web \
    --out-dir ../src/wasm \
    ../target/wasm32-unknown-unknown/release/kaleidomo_core.wasm

wasm-opt ../src/wasm/kaleidomo_core.wasm \
    -o ../src/wasm/kaleidomo_core_bg.wasm \
    -Oz \
    --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int

echo "Build successful"