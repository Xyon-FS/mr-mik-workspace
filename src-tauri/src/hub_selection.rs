use std::path::{Path, PathBuf};

/// Resolve only the selected folder or its conventional immediate Hub child.
/// No recursive search, copying, registry changes or implicit replacement.
pub fn existing_hub(root: &Path, valid: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    [root.to_owned(), root.join("MyHub"), root.join("Hub")]
        .into_iter().find(|candidate| valid(candidate))
}

pub fn creation_destination(parent: &Path, valid: impl Fn(&Path) -> bool) -> PathBuf {
    existing_hub(parent, valid).unwrap_or_else(|| parent.join("MyHub"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_hub_is_reused_instead_of_nesting_another_myhub() {
        let hub = Path::new("example/MyHub");
        assert_eq!(creation_destination(hub, |candidate| candidate == hub), hub);
    }

    #[test]
    fn parent_reuses_modern_or_legacy_hub_and_prefers_modern() {
        let parent = Path::new("example");
        let modern = parent.join("MyHub");
        let legacy = parent.join("Hub");
        assert_eq!(creation_destination(parent, |candidate| candidate == modern || candidate == legacy), modern);
        assert_eq!(existing_hub(parent, |candidate| candidate == legacy), Some(legacy));
    }

    #[test]
    fn invalid_folders_are_not_treated_as_existing_hubs() {
        let parent = Path::new("example");
        assert_eq!(existing_hub(parent, |_| false), None);
        assert_eq!(creation_destination(parent, |_| false), parent.join("MyHub"));
    }
}
