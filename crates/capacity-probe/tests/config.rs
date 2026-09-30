use reltide_capacity_probe::protocol::ProbeConfig;
use std::{
    fs::OpenOptions,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
};

fn file(name: &str, mode: u32, content: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("capacity-config-{name}-{}", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(&path)
        .unwrap();
    file.write_all(content.as_bytes()).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
    path
}

const VALID: &str = "TEMPORAL_ADDRESS=http://127.0.0.1:7233\nTEMPORAL_NAMESPACE=reltide-capacity-test-1\nTEMPORAL_TASK_QUEUE=reltide-capacity-test-1\nAPPLICATION_DATABASE_URL=postgres://secret@127.0.0.1/probe\n";

#[test]
fn reads_restricted_literal_environment_file() {
    let path = file("valid", 0o600, VALID);
    assert!(
        ProbeConfig::from_env_file(&path)
            .unwrap()
            .validate_for("test-1")
            .is_ok()
    );
    std::fs::remove_file(path).unwrap();
}

#[test]
fn rejects_world_readable_credentials() {
    let path = file("public", 0o644, VALID);
    assert!(ProbeConfig::from_env_file(&path).is_err());
    std::fs::remove_file(path).unwrap();
}

#[test]
fn rejects_duplicate_configuration_keys_without_secret_diagnostics() {
    let path = file(
        "duplicate",
        0o600,
        &format!("{VALID}APPLICATION_DATABASE_URL=postgres://another-secret@host/probe\n"),
    );
    let error = ProbeConfig::from_env_file(&path).unwrap_err();
    assert!(!format!("{error:?}").contains("secret"));
    std::fs::remove_file(path).unwrap();
}
