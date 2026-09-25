# Updating the `kaleidomo-core` Submodule

`kaleidomo-core` is a Git repository nested inside the main Kaleidomo repository. Changes must be committed and pushed inside the submodule first, followed by a commit in the parent repository that records the new submodule revision and any related application changes.

## 1. Update and test `kaleidomo-core`

From the main Kaleidomo repository:

```sh
cd kaleidomo-core
git status
```

Make the required changes and run the relevant checks:

```sh
cargo test --lib
```

If the changes affect WASM, compile and copy the generated WASM files using the provided script:

```sh
./build_wasm.sh
```

Review the changes before committing:

```sh
git status
git diff
```

Stage all related files, commit them, and push the submodule commit:

```sh
git add .
git commit -m "Describe the kaleidomo-core update"
git push
```

The submodule commit must be pushed before the parent repository commit so that other checkouts can retrieve it.

## 2. Update the parent Kaleidomo repository

Return to the parent repository:

```sh
cd ..
git status
```

The status output should show `kaleidomo-core` as modified. If `build_wasm.sh` was run, it should also show the regenerated files under `public/wasm` and `src/wasm` when their contents changed.

Run the application checks appropriate for the change:

```sh
bun run build
cargo check --manifest-path src-tauri/Cargo.toml
```

Review and stage all related parent-repository changes:

```sh
git diff --submodule=diff
git add .
git status
```

Commit and push the parent repository:

```sh
git commit -m "Update kaleidomo-core submodule"
git push
```

## 3. Verify a fresh checkout

After pulling the parent repository elsewhere, initialize or update its submodules:

```sh
git submodule update --init --recursive
```

To confirm the checked-out submodule revision:

```sh
git submodule status
```

## Notes

- Run `git status` before each `git add .` and confirm that every listed file belongs to the intended update.
- Do not commit the parent repository before the corresponding `kaleidomo-core` commit has been pushed.
- Do not manually copy WASM artifacts. Use `kaleidomo-core/build_wasm.sh` so generated files are placed in their expected destinations.
