//! ChaCha20 benchmark
use benches::{Benchmarker, criterion_group_bench};
use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use std::alloc::{Layout, alloc, dealloc};

use chacha20::{
    ChaCha20,
    cipher::{KeyIvInit, StreamCipher},
};

const KB: usize = 1024;
fn bench(c: &mut Benchmarker) {
    let mut group = c.benchmark_group("stream-cipher");

    for size in &[KB, 2 * KB, 4 * KB, 8 * KB, 16 * KB] {
        let mut buf = vec![0u8; *size];

        group.throughput(Throughput::Bytes(*size as u64));

        group.bench_function(BenchmarkId::new("apply_keystream", size), |b| {
            let key = Default::default();
            let nonce = Default::default();
            let mut cipher = ChaCha20::new(&key, &nonce);
            b.iter(|| cipher.apply_keystream(&mut buf));
        });
    }

    group.finish();
}

use chacha20::rand_core::{Rng, SeedableRng};
use original_chacha::rand_core::{Rng as _, SeedableRng as _};

fn bench_chacha20rng(c: &mut Benchmarker) {
    let mut group = c.benchmark_group("ChaCha20Rng");

    for size in &[256, KB, 2 * KB, 4 * KB] {
        let mut buf = vec![0u8; *size];

        group.throughput(Throughput::Bytes(*size as u64));

        group.bench_function(BenchmarkId::new("fill_bytes", size), |b| {
            let mut rng = chacha20::ChaCha20Rng::from_seed([0u8; 32]);
            b.iter(|| rng.fill_bytes(&mut buf));
        });
    }

    for size in &[256, KB, 2 * KB, 4 * KB] {
        let layout = Layout::from_size_align(*size, 16).unwrap();
        let ptr = unsafe { alloc(layout) };

        assert_eq!(ptr as usize & 0xF, 0);

        let mut buf = unsafe { std::slice::from_raw_parts_mut(ptr, *size) };

        group.throughput(Throughput::Bytes(*size as u64));

        group.bench_function(BenchmarkId::new("fill_bytes_aligned", size), |b| {
            let mut rng = chacha20::ChaCha20Rng::from_seed([0u8; 32]);
            b.iter(|| rng.fill_bytes(&mut buf));
        });
        unsafe { dealloc(ptr, layout) };
    }

    for size in &[256, KB, 2 * KB, 4 * KB] {
        let mut buf = vec![0u8; *size];

        group.throughput(Throughput::Bytes(*size as u64));

        group.bench_function(BenchmarkId::new("OG_ChaCha_fill_bytes", size), |b| {
            let mut rng = original_chacha::ChaCha20Rng::from_seed([0u8; 32]);
            b.iter(|| rng.fill_bytes(&mut buf));
        });
    }

    group.finish();
}
criterion_group_bench!(benches_chacha20rng, bench_chacha20rng);

criterion_group_bench!(benches, bench);

criterion_main!(benches, benches_chacha20rng);
