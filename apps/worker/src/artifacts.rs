use crate::{DemoError, remove_if_present};
use reltide_domain::MigrationReport;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) struct Attempt {
    marker: PathBuf,
}

impl Attempt {
    pub(crate) fn begin(output: &Path) -> Result<Self, DemoError> {
        fs::create_dir_all(output)?;
        let marker = output.join("run-marker.json");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    DemoError::ConcurrentRun
                } else {
                    error.into()
                }
            })?;
        write!(
            file,
            "{}",
            serde_json::json!({"pid": std::process::id(), "started_at_unix_ms": now_ms()?, "status": "incomplete", "recovery": "Confirm this PID is no longer running before removing run-marker.json and rerunning stripe-demo."})
        )?;
        file.sync_all()?;
        for name in ["report.json", "migration.patch", "pull-request.md"] {
            remove_if_present(&output.join(name))?;
        }
        Ok(Self { marker })
    }
}

impl Drop for Attempt {
    fn drop(&mut self) {
        let _ = remove_if_present(&self.marker);
    }
}

pub(crate) fn now_ms() -> Result<u64, DemoError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| DemoError::Fixture(error.to_string()))?;
    u64::try_from(duration.as_millis()).map_err(|error| DemoError::Fixture(error.to_string()))
}

fn atomic_write(output: &Path, name: &str, bytes: &[u8]) -> Result<(), DemoError> {
    let mut temporary = tempfile::NamedTempFile::new_in(output)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(output.join(name))
        .map_err(|error| error.error)?;
    Ok(())
}

pub(crate) fn publish(output: &Path, report: &MigrationReport) -> Result<(), DemoError> {
    report.validate()?;
    atomic_write(output, "migration.patch", report.generated_diff.as_bytes())?;
    atomic_write(output, "pull-request.md", report.pr_preview.as_bytes())?;
    // Report is the API's atomic input; its embedded patch/preview are authoritative.
    atomic_write(output, "report.json", &serde_json::to_vec_pretty(report)?)
}

pub(crate) fn preview(report: &MigrationReport) -> String {
    let status = match report.verification_status {
        reltide_domain::VerificationStatus::LocallyVerified => "locally verified",
        reltide_domain::VerificationStatus::Failed => "failed",
        reltide_domain::VerificationStatus::NotRun => "not run",
    };
    let mut text = format!(
        "# Local Stripe migration PR preview\n\nLocal verification: {}. Publication held.\n\nThe disposable explicit target upgrades stripe {} / API {} to stripe {} / API {} and reads latest_charge as a string, expanded Charge, or null. This is a target-only preview: pinned and unknown-default clients remain separate controls. Candidate type checking uses the unchanged include-all TypeScript configuration over a sparse package containing generated explicit target files and the retained pinned control. The unknown client stays in the original package. Original package verification scripts remain unchanged in the patch; repository-wide verification and migration of its original tests remain held pending version evidence and review.\n\n## Evidence\n\n",
        status,
        report.plan.source_sdk_version,
        report.plan.source_api_version,
        report.plan.target_sdk_version,
        report.plan.target_api_version
    );
    for evidence in &report.plan.evidence {
        text.push_str(&format!("- [{}]({})\n", evidence.title, evidence.url));
    }
    text.push_str("\n## Actual local checks\n\n");
    for check in &report.checks {
        text.push_str(&format!(
            "- {:?}: {:?}; exit {:?}; {} ms; `{}`\n",
            check.kind, check.status, check.exit_code, check.duration_ms, check.command
        ));
    }
    text.push_str("\nVerification constructs local SDK clients and checks synthetic response objects; no Stripe resource methods or requests execute. Original fixture inputs, candidate files, and fixed verification programs are SHA-256 fingerprinted in report.json. Paths prefixed worker-generated/tests/ identify exact embedded worker program bytes materialized only in the disposable workspace; they are not original fixture files. The full actual unified diff is migration.patch and embedded in report.json.\n\n## Publication blockers\n\n");
    for blocker in &report.blockers {
        text.push_str(&format!("- {}\n", blocker.reason));
    }
    text
}
