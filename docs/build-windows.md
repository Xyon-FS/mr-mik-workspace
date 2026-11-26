# Manual Windows installer build

Double-click `Build-Installer.cmd` in the repository root. The window stays open
when finished and prints either `SUCCESS` and the installer path, or an error.
No Codex chat or model request is involved.

For public releases, run these commands from a clean checkout of the release
commit. The packaging scripts read files from disk, including files ignored by
Git in a development checkout.

The launcher uses the existing local Node.js distribution under
`.cache/build-tooling/node-v24.19.0-win-x64` when available, otherwise Node.js on
PATH. A full Node.js installation with npm, installed repository dependencies,
Rust, the Windows C++ build tools and the usual Tauri prerequisites are required.
The existing build preparation may download npm dependencies or a Node license.

Each run builds the current saved source, including uncommitted edits, using
`src-tauri/target-isolated`. It saves the installer, `build.log`, `BUILD.txt` and
`SHA256SUMS.txt` in a new timestamped folder under `release/`. Previous release
folders are preserved. Intermediate build output and runtime staging are reused
or regenerated. Avoid running other packaging/build commands simultaneously.

The script verifies bundled source/UI file parity and the copied installer hash.
It does not run the test suite, install the application, modify native account
settings, restart Mr. Mik or stop active chats. Test changes separately as needed.
Do not edit source during packaging. Review source for private data before sharing
an installer. Failed builds retain their log; they do not produce `BUILD.txt`.

For a quick dependency-path check without starting a build, run
`Build-Installer.cmd --check`. This does not validate the native compiler toolchain.
An interrupted build can leave `.cache/manual-installer-build.lock`; remove it
only after confirming the previous build has stopped.

## Portable without an installer

The existing release packager supports `--portable-only`. Build the native app
with `tauri build --no-bundle` using the desired `CARGO_TARGET_DIR`, then run
`node scripts/package-release.mjs --portable-only` with that same target directory
and a unique `MRMIK_RELEASE_SUFFIX`. The normal App/MyHub launcher, ZIP and SHA256
manifest are retained. No NSIS installer is required or copied in this mode, so a
stale installer cannot accidentally accompany a fresh portable executable.

A portable build isolates Mr. Mik's launch profile. It uses the normal CLI
accounts unless you explicitly select an isolated account profile. See
[Claude account profiles](user-guide.md#claude-account-profiles).
