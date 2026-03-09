//! ChaCha20 benchmark
use benches::{Benchmarker, criterion_group_bench};
use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use std::alloc::{Layout, alloc, dealloc};

use kaleidomo_core::Register;
use kaleidomo_core::{KaleidoSettings, KaleidoType, render_kaleidoscope_with_backend};
use kaleidomo_core::image::{DynamicImage, RgbaImage};

fn kaleido_bench(c: &mut Benchmarker) {
    let mut group = c.benchmark_group("kaleidomo");

    let sw = 4096;
    let sh = sw;
    let mut source_pixels = Vec::new();
    for y in 0..sh {
        for x in 0..sw {
            source_pixels.extend_from_slice(&[x as u8, y as u8, 128, 255]);
        }
    }
    let source = DynamicImage::ImageRgba8(RgbaImage::from_raw(sw, sh, source_pixels).unwrap());

    let mut settings = KaleidoSettings {
        output_size: 4096, // Keep it small for fast tests
        count: 6,        // Hexagonal symmetry
        zoom: 1.0,
        triangle_center_x: 50.0,
        triangle_center_y: 50.0,
        triangle_rotation_rad: 0.0,
        kaleido_type: KaleidoType::Radial,
        tile_count: 4.0,
    };

    for (ty, ty_str) in [KaleidoType::Radial, KaleidoType::Square, KaleidoType::Diamond, KaleidoType::Hexagonal, KaleidoType::HexagonalFlatTop].iter().zip(&["radial", "square", "diamond", "hexagonal", "hexagonal_flat_top"]) {
        group.bench_function(BenchmarkId::new(&format!("f32 backend - {}", ty_str), 4096), |b| {
            b.iter(|| render_kaleidoscope_with_backend::<f32>(&source, settings.clone()));
        });
        group.bench_function(BenchmarkId::new(&format!("SIMD backend - {}", ty_str), 4096), |b| {
            b.iter(|| render_kaleidoscope_with_backend::<Register>(&source, settings.clone()));
        });
    }

    group.finish();
}
criterion_group_bench!(kaleido_benches, kaleido_bench);

criterion_main!(kaleido_benches);
