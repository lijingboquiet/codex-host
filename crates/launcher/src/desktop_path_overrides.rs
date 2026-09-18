use std::ffi::{OsStr, OsString};
use std::path::Path;

const PATH_OVERRIDES: [&str; 6] = [
    "HOME",
    "USERPROFILE",
    "ZDOTDIR",
    "CODEX_HOME",
    "CODEX_ELECTRON_USER_DATA_PATH",
    "CODEXHOST_CLAUDE_COMMAND",
];

fn environment_name_matches(actual: &OsStr, expected: &str) -> bool {
    if cfg!(windows) {
        actual.to_string_lossy().eq_ignore_ascii_case(expected)
    } else {
        actual == expected
    }
}

/// LaunchServices/AppX do not inherit the launcher's environment. Forward only
/// explicit absolute path overrides, never arbitrary variables or authentication
/// material: macOS passes these entries through `open --env` arguments.
pub(crate) fn forwarded(
    variables: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    let variables = variables.into_iter().collect::<Vec<_>>();
    if variables
        .iter()
        .any(|(name, value)| {
            environment_name_matches(name, "CODEXHOST_REMOTE_SSH_MANAGED") && value == "1"
        })
    {
        return Vec::new();
    }
    variables
        .into_iter()
        .filter_map(|(name, value)| {
            let normalized_name = PATH_OVERRIDES.iter().find(|expected| {
                environment_name_matches(name, expected)
            })?;
            Path::new(&value)
                .is_absolute()
                .then(|| (OsString::from(*normalized_name), value))
        })
        .collect()
}

/// Electron's app-level userData override does not redirect Chromium's early
/// session storage by itself. Match the official Desktop's isolated launch:
/// provide the same explicit profile as a Chromium argument as well.
pub(crate) fn launch_arguments(
    base: &[OsString],
    environment: &[(OsString, OsString)],
) -> Vec<OsString> {
    let mut arguments = base.to_vec();
    if let Some((_, directory)) = environment.iter().find(|(name, directory)| {
        environment_name_matches(name, "CODEX_ELECTRON_USER_DATA_PATH")
            && Path::new(directory).is_absolute()
    }) {
        let mut argument = OsString::from("--user-data-dir=");
        argument.push(directory);
        arguments.push(argument);
    }
    arguments
}

#[cfg(test)]
mod tests {
    use super::{forwarded, launch_arguments};
    use std::ffi::OsString;

    #[test]
    fn rejects_relative_paths_and_unrelated_secrets() {
        let root = std::env::temp_dir().join("synthetic-desktop");
        let expected = (OsString::from("CODEX_HOME"), root.into_os_string());
        assert_eq!(
            forwarded([
                expected.clone(),
                (OsString::from("HOME"), OsString::from("relative")),
                (
                    OsString::from("CODEX_ELECTRON_USER_DATA_PATH"),
                    OsString::new()
                ),
                (
                    OsString::from("OPENAI_API_KEY"),
                    OsString::from("synthetic-secret")
                ),
                (
                    OsString::from("HTTPS_PROXY"),
                    OsString::from("https://synthetic:secret@example.invalid")
                ),
            ]),
            [expected],
        );
    }

    #[test]
    fn forwards_an_explicit_absolute_claude_command() {
        let command = std::env::temp_dir()
            .join("synthetic claude")
            .into_os_string();
        let expected = (
            OsString::from("CODEXHOST_CLAUDE_COMMAND"),
            command.clone(),
        );
        assert_eq!(
            forwarded([
                expected.clone(),
                (
                    OsString::from("CODEXHOST_CLAUDE_COMMAND"),
                    OsString::from("relative/claude")
                ),
            ]),
            [expected],
        );
    }

    #[test]
    fn matches_override_names_with_platform_environment_semantics() {
        let command = std::env::temp_dir().join("claude").into_os_string();
        let forwarded = forwarded([(
            OsString::from("codexhost_claude_command"),
            command.clone(),
        )]);

        if cfg!(windows) {
            assert_eq!(
                forwarded,
                [(OsString::from("CODEXHOST_CLAUDE_COMMAND"), command)]
            );
        } else {
            assert!(forwarded.is_empty());
        }
    }

    #[test]
    fn redirects_chromium_to_the_same_explicit_profile_without_splitting_spaces() {
        let profile = std::env::temp_dir()
            .join("synthetic profile")
            .into_os_string();
        let base = [OsString::from("--remote-debugging-port=12345")];
        let environment = [(
            OsString::from("CODEX_ELECTRON_USER_DATA_PATH"),
            profile.clone(),
        )];
        let mut expected = OsString::from("--user-data-dir=");
        expected.push(profile);
        assert_eq!(
            launch_arguments(&base, &environment),
            [base[0].clone(), expected]
        );
        assert_eq!(launch_arguments(&base, &[]), base);
    }

    #[test]
    fn does_not_install_remote_profile_paths_in_a_local_desktop() {
        let path = std::env::temp_dir()
            .join("synthetic-remote")
            .into_os_string();
        assert!(
            forwarded([
                (OsString::from("CODEX_HOME"), path.clone()),
                (OsString::from("HOME"), path),
                (
                    OsString::from("CODEXHOST_REMOTE_SSH_MANAGED"),
                    OsString::from("1")
                ),
            ])
            .is_empty()
        );
    }
}
