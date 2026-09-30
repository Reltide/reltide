use std::{
    io::Write,
    process::{Command, Stdio},
};

#[test]
fn invalid_stdin_does_not_print_secret_input() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_reltide-capacity-probe"))
        .arg("start")
        .env_remove("RELTIDE_CAPACITY_ENV_FILE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"postgres://password@secret.invalid/database")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(
        !String::from_utf8(output.stderr)
            .unwrap()
            .contains("password")
    );
}

#[test]
fn unknown_subcommand_fails() {
    let output = Command::new(env!("CARGO_BIN_EXE_reltide-capacity-probe"))
        .arg("deploy")
        .output()
        .unwrap();
    assert!(!output.status.success());
}
