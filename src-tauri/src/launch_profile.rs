use std::path::{Path, PathBuf};

/// A packaged portable owns a profile distinct from the installed application.
/// Detect the layout even when App/mrmak-workspace.exe is opened directly.
pub fn portable_root(executable: &Path) -> Option<PathBuf> {
    let app = executable.parent()?;
    if !app.file_name()?.to_string_lossy().eq_ignore_ascii_case("App") { return None; }
    let root = app.parent()?;
    if root.join("Start Mr. Mik.cmd").is_file() || root.join("MyHub").is_dir() || root.join("Hub").is_dir() {
        Some(root.to_owned())
    } else { None }
}

pub fn supplied_hub(args: &[String]) -> Option<PathBuf> {
    args.windows(2).find(|pair| pair[0] == "--repo").map(|pair| PathBuf::from(&pair[1]))
}

pub fn portable_hub(root: &Path) -> PathBuf {
    let modern = root.join("MyHub");
    if !modern.join("workspace/workspace.json").is_file() && root.join("Hub/workspace/workspace.json").is_file() {
        root.join("Hub")
    } else { modern }
}

pub fn identifier(base: &str, executable: &Path, args: &[String]) -> String {
    let location = portable_root(executable).map(|root| ("portable", root))
        .or_else(|| supplied_hub(args).map(|hub| ("explicit", hub)));
    let Some((kind, path)) = location else { return base.to_owned(); };
    let absolute = std::fs::canonicalize(&path).unwrap_or_else(|_| {
        if path.is_absolute() { path.clone() } else { std::env::current_dir().unwrap_or_default().join(&path) }
    });
    let normalized = absolute.to_string_lossy().replace('/', "\\").trim_start_matches(r"\\?\").to_lowercase();
    // Fixed FNV-1a keeps the profile stable across builds/app versions.
    let hash = normalized.bytes().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3));
    format!("{base}.{kind}.{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installed_and_explicit_hubs_never_share_a_profile() {
        let exe = Path::new("installed/mrmak-workspace.exe");
        let base = "com.mrmik.workspace";
        assert_eq!(identifier(base, exe, &[]), base);
        let a = vec!["app".into(), "--repo".into(), "first-hub".into()];
        let b = vec!["app".into(), "--repo".into(), "second-hub".into()];
        assert_ne!(identifier(base, exe, &a), base);
        assert_ne!(identifier(base, exe, &a), identifier(base, exe, &b));
        assert_eq!(identifier(base, exe, &a), identifier(base, exe, &a));
    }
    #[test]
    fn portable_profile_is_stable_with_or_without_launcher_and_across_hub_arguments() {
        let root = std::env::temp_dir().join(format!("mik-launch-profile-{}", std::process::id()));
        std::fs::create_dir_all(root.join("App")).unwrap();
        std::fs::create_dir_all(root.join("MyHub/workspace")).unwrap();
        let exe = root.join("App/mrmak-workspace.exe");
        let base = "com.mrmik.workspace";
        let direct = identifier(base, &exe, &[]);
        let args = vec!["app".into(), "--repo".into(), root.join("MyHub").to_string_lossy().into_owned()];
        assert_eq!(portable_root(&exe), Some(root.clone()));
        assert_ne!(direct, base);
        assert_eq!(direct, identifier(base, &exe, &args));
        assert_eq!(portable_hub(&root), root.join("MyHub"));
        std::fs::create_dir_all(root.join("Hub/workspace")).unwrap();
        std::fs::write(root.join("Hub/workspace/workspace.json"), "{}").unwrap();
        assert_eq!(portable_hub(&root), root.join("Hub"));
        std::fs::write(root.join("MyHub/workspace/workspace.json"), "{}").unwrap();
        assert_eq!(portable_hub(&root), root.join("MyHub"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
