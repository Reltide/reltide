use reltide_domain::{CheckKind, CheckStatus, MigrationReport, VerificationStatus};
use reltide_worker::run_stripe_demo;
use std::{
    fs,
    path::{Path, PathBuf},
};

fn workspace() -> tempfile::TempDir {
    let workspace = tempfile::tempdir().unwrap();
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/stripe-migration");
    copy_inputs(
        &fixture,
        &workspace.path().join("fixtures/stripe-migration"),
    );
    workspace
}

fn copy_inputs(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name() == "node_modules" || entry.file_name() == ".nx" {
            continue;
        }
        let destination = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_inputs(&entry.path(), &destination);
        } else {
            fs::copy(entry.path(), destination).unwrap();
        }
    }
}

fn report(workspace: &Path) -> MigrationReport {
    serde_json::from_slice(&fs::read(workspace.join(".reltide/demo/report.json")).unwrap()).unwrap()
}

#[test]
fn demo_generates_candidate_instead_of_copying_expected_source() {
    let workspace = workspace();
    let fixture = workspace.path().join("fixtures/stripe-migration");
    let original = fs::read(fixture.join("before/src/latest-charge.ts")).unwrap();
    fs::write(
        fixture.join("after/src/latest-charge.ts"),
        "throw new Error('Expected source must never execute');",
    )
    .unwrap();
    let before_run = snapshot(&fixture);
    let result = run_stripe_demo(workspace.path()).unwrap();
    assert_eq!(snapshot(&fixture), before_run);
    assert_eq!(
        result.verification_status,
        VerificationStatus::LocallyVerified
    );
    assert!(
        result
            .generated_diff
            .contains("const charge = intent.latest_charge;")
    );
    assert_eq!(
        fs::read(fixture.join("before/src/latest-charge.ts")).unwrap(),
        original
    );
    assert_eq!(
        fs::read_to_string(fixture.join("after/src/latest-charge.ts")).unwrap(),
        "throw new Error('Expected source must never execute');"
    );
    result.validate().unwrap();
    assert_eq!(report(workspace.path()), result);
    assert_eq!(
        fs::read_to_string(workspace.path().join(".reltide/demo/migration.patch")).unwrap(),
        result.generated_diff
    );
}

#[test]
fn command_failure_is_reported() {
    let workspace = workspace();
    fs::write(
        workspace
            .path()
            .join("fixtures/stripe-migration/tests/baseline.mjs"),
        "throw new Error('baseline subprocess failure');",
    )
    .unwrap();
    assert!(run_stripe_demo(workspace.path()).is_err());
    let result = report(workspace.path());
    let baseline = result
        .checks
        .iter()
        .find(|check| check.kind == CheckKind::BeforeBaseline)
        .unwrap();
    assert_eq!(baseline.status, CheckStatus::Failed);
    assert_eq!(baseline.exit_code, Some(1));
    assert!(baseline.output.contains("baseline subprocess failure"));
    assert_eq!(result.verification_status, VerificationStatus::Failed);
    result.validate().unwrap();
}

#[test]
fn unexpected_regression_error_is_not_expected_failure() {
    let workspace = workspace();
    fs::write(
        workspace
            .path()
            .join("fixtures/stripe-migration/tests/regression.mjs"),
        "throw new Error('unrelated regression error');",
    )
    .unwrap();
    assert!(run_stripe_demo(workspace.path()).is_err());
    let result = report(workspace.path());
    let regression = result
        .checks
        .iter()
        .find(|check| check.kind == CheckKind::BeforeRegression)
        .unwrap();
    assert_eq!(regression.status, CheckStatus::Failed);
    assert_eq!(regression.exit_code, Some(1));
    assert!(regression.output.contains("unrelated regression error"));
}

#[test]
fn failed_rerun_replaces_previous_success() {
    let workspace = workspace();
    run_stripe_demo(workspace.path()).unwrap();
    fs::write(
        workspace
            .path()
            .join("fixtures/stripe-migration/tests/baseline.mjs"),
        "throw new Error('second attempt failed');",
    )
    .unwrap();
    assert!(run_stripe_demo(workspace.path()).is_err());
    let result = report(workspace.path());
    assert_eq!(result.verification_status, VerificationStatus::Failed);
    assert!(result.pr_preview.contains("failed"));
    assert!(
        !workspace
            .path()
            .join(".reltide/demo/run-marker.json")
            .exists()
    );
}

#[test]
fn existing_marker_blocks_run_and_preserves_evidence() {
    let workspace = workspace();
    let output = workspace.path().join(".reltide/demo");
    fs::create_dir_all(&output).unwrap();
    fs::write(output.join("run-marker.json"), "interrupted attempt").unwrap();
    let error = run_stripe_demo(workspace.path()).unwrap_err().to_string();
    assert!(error.contains("run-marker.json"));
    assert!(error.contains("recovery"));
    assert_eq!(
        fs::read_to_string(output.join("run-marker.json")).unwrap(),
        "interrupted attempt"
    );
}

#[test]
fn unexpected_regression_success_is_failed_verification_with_actual_exit_zero() {
    let workspace = workspace();
    fs::write(
        workspace
            .path()
            .join("fixtures/stripe-migration/tests/regression.mjs"),
        "console.log('regression assertion omitted');",
    )
    .unwrap();
    assert!(run_stripe_demo(workspace.path()).is_err());
    let result = report(workspace.path());
    assert_eq!(result.verification_status, VerificationStatus::Failed);
    let check = result
        .checks
        .iter()
        .find(|check| check.kind == CheckKind::BeforeRegression)
        .unwrap();
    assert_eq!(check.exit_code, Some(0));
    assert_eq!(check.status, CheckStatus::Passed);
    result.validate().unwrap();
}

fn snapshot(root: &Path) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
    let mut files = std::collections::BTreeMap::new();
    for entry in fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            files.extend(snapshot(&entry.path()));
        } else {
            files.insert(entry.path(), fs::read(entry.path()).unwrap());
        }
    }
    files
}

#[test]
fn concurrent_attempt_is_rejected_without_clobbering_the_winner() {
    let workspace = workspace();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let root = workspace.path().to_owned();
    let outcomes = std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            barrier.wait();
            run_stripe_demo(&root)
        });
        let second = scope.spawn(|| {
            barrier.wait();
            run_stripe_demo(&root)
        });
        [first.join().unwrap(), second.join().unwrap()]
    });
    assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
    assert!(
        outcomes
            .iter()
            .any(|result| matches!(result, Err(reltide_worker::DemoError::ConcurrentRun)))
    );
    assert_eq!(
        report(workspace.path()).verification_status,
        VerificationStatus::LocallyVerified
    );
}

#[test]
fn unsupported_rerun_removes_previous_success() {
    let workspace = workspace();
    run_stripe_demo(workspace.path()).unwrap();
    fs::write(
        workspace
            .path()
            .join("fixtures/stripe-migration/before/src/latest-charge.ts"),
        "unsupported helper",
    )
    .unwrap();
    assert!(run_stripe_demo(workspace.path()).is_err());
    assert!(!workspace.path().join(".reltide/demo/report.json").exists());
    assert!(
        !workspace
            .path()
            .join(".reltide/demo/migration.patch")
            .exists()
    );
    assert!(
        !workspace
            .path()
            .join(".reltide/demo/pull-request.md")
            .exists()
    );
}

#[test]
fn generated_patch_applies_to_the_old_target() {
    let workspace = workspace();
    let result = run_stripe_demo(workspace.path()).unwrap();
    let target = tempfile::tempdir().unwrap();
    copy_inputs(
        &workspace.path().join("fixtures/stripe-migration/before"),
        target.path(),
    );
    let patch_path = workspace.path().join(".reltide/demo/migration.patch");
    let applied = std::process::Command::new("git")
        .args(["apply"])
        .arg(&patch_path)
        .current_dir(target.path())
        .output()
        .unwrap();
    assert!(
        applied.status.success(),
        "{}",
        String::from_utf8_lossy(&applied.stderr)
    );
    assert!(
        fs::read_to_string(target.path().join("src/latest-charge.ts"))
            .unwrap()
            .contains("const charge = intent.latest_charge;")
    );
    assert_eq!(
        fs::read_to_string(&patch_path).unwrap(),
        result.generated_diff
    );
}

#[test]
fn forced_color_does_not_change_regression_classification() {
    let outcome = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "demo_generates_candidate_instead_of_copying_expected_source",
        ])
        .env("FORCE_COLOR", "1")
        .output()
        .unwrap();
    assert!(
        outcome.status.success(),
        "{}{}",
        String::from_utf8_lossy(&outcome.stdout),
        String::from_utf8_lossy(&outcome.stderr)
    );
}
