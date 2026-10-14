//! Local execution for the trusted synthetic Stripe migration fixture.

mod artifacts;
mod checks;
mod fixture;

use reltide_domain::{MigrationReport, VerificationStatus};
use std::{fs, path::Path};

/// Failures retain honest evidence in `.reltide/demo` whenever a plan exists.
#[derive(Debug, thiserror::Error)]
pub enum DemoError {
    /// Filesystem or process plumbing failure.
    #[error("local demo I/O failure: {0}")]
    Io(#[from] std::io::Error),
    /// Input or persisted evidence failed domain validation.
    #[error(transparent)]
    Domain(#[from] reltide_domain::MigrationError),
    /// JSON input/output is malformed.
    #[error("local demo JSON failure: {0}")]
    Json(#[from] serde_json::Error),
    /// Another run or interrupted attempt requires operator attention.
    #[error(
        "run-marker.json exists: recovery requires checking its PID is no longer running, then removing the marker and rerunning stripe-demo"
    )]
    ConcurrentRun,
    /// A real verification command did not meet the required outcome.
    #[error("local verification failed; inspect .reltide/demo/report.json")]
    Verification,
    /// Unsupported trusted fixture metadata.
    #[error("unsupported fixture: {0}")]
    Fixture(String),
}

/// Generates and verifies a target-only candidate from a fixed trusted fixture.
///
/// `workspace` is only for local CLI and isolated tests, never an HTTP input.
/// # Errors
/// Returns a typed failure when input, execution, or evidence is incomplete.
pub fn run_stripe_demo(workspace: &Path) -> Result<MigrationReport, DemoError> {
    let output = workspace.join(".reltide/demo");
    let _attempt = artifacts::Attempt::begin(&output)?;
    let fixture = fixture::Fixture::read(workspace)?;
    let mut report = fixture.report()?;
    artifacts::publish(&output, &report)?;
    let result = execute(&fixture, &mut report);
    if result.is_err() {
        report.verification_status = VerificationStatus::Failed;
    }
    report.pr_preview = artifacts::preview(&report);
    if let Err(error) = &result {
        report
            .pr_preview
            .push_str(&format!("\n## Run error\n\n{error}\n"));
    }
    artifacts::publish(&output, &report)?;
    result?;
    Ok(report)
}

fn execute(fixture: &fixture::Fixture, report: &mut MigrationReport) -> Result<(), DemoError> {
    let disposable = tempfile::tempdir()?;
    fixture.prepare(disposable.path(), &report.plan)?;
    report.generated_diff = fixture.patch(disposable.path())?;
    fixture.fingerprint_candidate(disposable.path(), &mut report.source_fingerprints)?;
    checks::verify(disposable.path(), &mut report.checks);
    if report.checks.iter().any(|check| {
        check.status
            != if check.kind == reltide_domain::CheckKind::BeforeRegression {
                reltide_domain::CheckStatus::ExpectedFailure
            } else {
                reltide_domain::CheckStatus::Passed
            }
    }) {
        return Err(DemoError::Verification);
    }
    report.verification_status = VerificationStatus::LocallyVerified;
    report.validate()?;
    Ok(())
}

pub(crate) fn remove_if_present(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}
