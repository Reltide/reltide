use reltide_domain::{CheckKind, CheckResult, CheckStatus, MAX_CHECK_OUTPUT_BYTES};
use std::os::unix::process::CommandExt;
use std::{
    io::{self, Read},
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

pub(crate) fn verify(root: &Path, checks: &mut Vec<CheckResult>) {
    let before = root.join("before");
    let candidate = root.join("after");
    for (kind, directory, steps) in [
        (
            CheckKind::BeforeTypecheck,
            &before,
            vec![
                (
                    "node",
                    vec![
                        "--eval",
                        "console.log(process.version); if (process.version !== 'v26.11.1') process.exitCode = 1;",
                    ],
                ),
                ("npm", vec!["--version"]),
                (
                    "npm",
                    vec!["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
                ),
                ("node", vec!["node_modules/typescript/bin/tsc", "--noEmit"]),
            ],
        ),
        (
            CheckKind::BeforeBaseline,
            &before,
            vec![(
                "node",
                vec!["--experimental-strip-types", "../tests/baseline.mjs"],
            )],
        ),
        (
            CheckKind::BeforeRegression,
            &before,
            vec![(
                "node",
                vec![
                    "--experimental-strip-types",
                    "../tests/regression.mjs",
                    "before",
                ],
            )],
        ),
        (
            CheckKind::CandidateTypecheck,
            &candidate,
            vec![
                (
                    "npm",
                    vec!["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
                ),
                ("node", vec!["node_modules/typescript/bin/tsc", "--noEmit"]),
            ],
        ),
        (
            CheckKind::CandidateRegression,
            &candidate,
            vec![(
                "node",
                vec!["--experimental-strip-types", "../tests/candidate.mjs"],
            )],
        ),
        (
            CheckKind::PinnedControl,
            &candidate,
            vec![(
                "node",
                vec!["--experimental-strip-types", "../tests/pinned.mjs"],
            )],
        ),
        (
            CheckKind::UnknownControl,
            &before,
            vec![(
                "node",
                vec!["--experimental-strip-types", "../tests/unknown.mjs"],
            )],
        ),
    ] {
        let started = Instant::now();
        let mut result = CheckResult {
            kind,
            command: String::new(),
            exit_code: None,
            status: CheckStatus::NotRun,
            output: String::new(),
            duration_ms: 0,
        };
        for (program, arguments) in steps {
            let command =
                serde_json::json!({"cwd": directory, "program": program, "arguments": arguments})
                    .to_string();
            if !result.command.is_empty() {
                result.command.push_str("; then ");
            }
            result.command.push_str(&command);
            let executed = run_command(program, &arguments, directory, COMMAND_TIMEOUT);
            result.output.push_str(&format!(
                "$ {command}\n{}\nexit_code: {:?}; duration_ms: {}\n",
                executed.output, executed.exit_code, executed.duration_ms
            ));
            result.exit_code = executed.exit_code;
            result.status = classify(kind, executed.exit_code, &executed.output);
            if result.status == CheckStatus::Failed {
                break;
            }
        }
        result.duration_ms = elapsed_ms(started);
        result.output = bounded(&result.output, MAX_CHECK_OUTPUT_BYTES);
        checks.push(result);
    }
}

fn classify(kind: CheckKind, exit_code: Option<i32>, output: &str) -> CheckStatus {
    if kind == CheckKind::BeforeRegression {
        if exit_code == Some(1)
            && [
                "code: 'ERR_ASSERTION'",
                "actual: null,",
                "expected: 'ch_new_001',",
                "operator: 'strictEqual'",
            ]
            .iter()
            .all(|part| output.contains(part))
        {
            CheckStatus::ExpectedFailure
        } else if exit_code == Some(0) {
            CheckStatus::Passed
        } else {
            CheckStatus::Failed
        }
    } else if exit_code == Some(0) {
        CheckStatus::Passed
    } else {
        CheckStatus::Failed
    }
}

struct CommandOutput {
    duration_ms: u64,
    exit_code: Option<i32>,
    output: String,
}

fn run_command(
    program: &str,
    arguments: &[&str],
    directory: &Path,
    timeout: Duration,
) -> CommandOutput {
    let started = Instant::now();
    let spawned = Command::new(program)
        .args(arguments)
        .current_dir(directory)
        .env_remove("FORCE_COLOR")
        .env("NO_COLOR", "1")
        .env("NODE_DISABLE_COLORS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            return CommandOutput {
                duration_ms: elapsed_ms(started),
                exit_code: None,
                output: format!("could not execute {program}: {error}"),
            };
        }
    };
    let stdout = child
        .stdout
        .take()
        .map(|pipe| thread::spawn(move || drain(pipe)));
    let stderr = child
        .stderr
        .take()
        .map(|pipe| thread::spawn(move || drain(pipe)));
    let (exit_code, error) = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                terminate(&mut child);
                break (status.code(), None);
            }
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                terminate(&mut child);
                break (
                    None,
                    Some(format!(
                        "command timed out after {} ms; process group terminated",
                        timeout.as_millis()
                    )),
                );
            }
            Err(error) => {
                terminate(&mut child);
                break (None, Some(format!("could not wait for {program}: {error}")));
            }
        }
    };
    let mut output = String::new();
    let mut truncated = false;
    for reader in [stdout, stderr].into_iter().flatten() {
        match reader.join() {
            Ok(Ok((bytes, stream_truncated))) => {
                output.push_str(&String::from_utf8_lossy(&bytes));
                truncated |= stream_truncated;
            }
            Ok(Err(error)) => output.push_str(&format!("output read failed: {error}\n")),
            Err(_) => output.push_str("output reader stopped unexpectedly\n"),
        }
    }
    if truncated {
        output.push_str("\n[output truncated; trailing evidence retained]\n");
    }
    if let Some(error) = error {
        output.push_str(&format!("\n{error}"));
    }
    CommandOutput {
        duration_ms: elapsed_ms(started),
        exit_code,
        output: bounded(&output, MAX_CHECK_OUTPUT_BYTES),
    }
}

fn terminate(child: &mut std::process::Child) {
    // Fixed Unix process groups include npm children; no shell is used.
    let _ = Command::new("/bin/kill")
        .args(["-KILL", "--", &format!("-{}", child.id())])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

fn drain(mut pipe: impl Read) -> io::Result<(Vec<u8>, bool)> {
    let mut retained = Vec::new();
    let mut truncated = false;
    let mut buffer = [0; 4096];
    loop {
        let read = pipe.read(&mut buffer)?;
        if read == 0 {
            return Ok((retained, truncated));
        }
        retained.extend_from_slice(&buffer[..read]);
        if retained.len() > MAX_CHECK_OUTPUT_BYTES / 2 {
            retained.drain(..retained.len() - MAX_CHECK_OUTPUT_BYTES / 2);
            truncated = true;
        }
    }
}

fn bounded(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let suffix = "\n[output truncated; trailing evidence retained]\n";
    let mut start = text.len() - (limit - suffix.len());
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("{suffix}{}", &text[start..])
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_kills_the_command_and_records_no_exit_code() {
        let directory = tempfile::tempdir().unwrap();
        let result = run_command(
            "node",
            &["--eval", "setTimeout(() => {}, 10000)"],
            directory.path(),
            Duration::from_millis(40),
        );
        assert_eq!(result.exit_code, None);
        assert!(result.output.contains("timed out"));
    }

    #[test]
    fn missing_program_is_a_failed_command() {
        let result = run_command(
            "/nonexistent/reltide-command",
            &[],
            Path::new("/tmp"),
            Duration::from_secs(1),
        );
        assert_eq!(result.exit_code, None);
        assert!(result.output.contains("could not execute"));
    }

    #[test]
    fn excessive_output_is_bounded_and_does_not_deadlock() {
        let result = run_command(
            "node",
            &[
                "--eval",
                "process.stdout.write('界'.repeat(100000)); process.stderr.write('error-tail');",
            ],
            Path::new("/tmp"),
            Duration::from_secs(10),
        );
        assert_eq!(result.exit_code, Some(0));
        assert!(result.output.len() <= MAX_CHECK_OUTPUT_BYTES);
        assert!(result.output.contains("error-tail"));
        assert!(result.output.contains("output truncated"));
    }

    #[test]
    fn truncated_stdout_is_disclosed_below_the_final_cap() {
        let result = run_command(
            "node",
            &[
                "--eval",
                "process.stdout.write('界'.repeat(100000) + 'stdout-tail');",
            ],
            Path::new("/tmp"),
            Duration::from_secs(10),
        );
        assert_eq!(result.exit_code, Some(0));
        assert!(result.output.len() < MAX_CHECK_OUTPUT_BYTES);
        assert!(result.output.contains("stdout-tail"));
        assert!(result.output.contains("output truncated"));
    }

    #[test]
    fn truncated_stderr_is_disclosed_below_the_final_cap() {
        let result = run_command(
            "node",
            &[
                "--eval",
                "process.stderr.write('界'.repeat(100000) + 'stderr-tail');",
            ],
            Path::new("/tmp"),
            Duration::from_secs(10),
        );
        assert_eq!(result.exit_code, Some(0));
        assert!(result.output.len() < MAX_CHECK_OUTPUT_BYTES);
        assert!(result.output.contains("stderr-tail"));
        assert!(result.output.contains("output truncated"));
    }
}

#[cfg(test)]
mod descendant_tests {
    use super::*;

    #[test]
    fn timeout_covers_children_holding_the_output_pipe() {
        let started = Instant::now();
        let result = run_command(
            "node",
            &[
                "--eval",
                "require('node:child_process').spawn(process.execPath, ['--eval', 'setTimeout(() => {}, 2500)'], {stdio: 'inherit'}).unref(); process.exit(0);",
            ],
            Path::new("/tmp"),
            Duration::from_millis(500),
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(result.exit_code, Some(0));
    }
}
