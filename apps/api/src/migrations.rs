use std::{
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
};

use axum::{
    Json,
    extract::State,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use reltide_domain::MigrationReport;
use serde::Serialize;
use utoipa::ToSchema;

/// Reports larger than 1 MiB are unavailable; reads retain at most one extra byte.
const MAX_REPORT_BYTES: usize = 1024 * 1024;

#[derive(Serialize, ToSchema)]
struct MigrationReportError {
    error: MigrationReportErrorCode,
}

#[derive(Clone, Copy, Debug, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
enum MigrationReportErrorCode {
    MigrationReportNotFound,
    MigrationReportUnavailable,
}

impl MigrationReportErrorCode {
    fn status(self) -> StatusCode {
        match self {
            Self::MigrationReportNotFound => StatusCode::NOT_FOUND,
            Self::MigrationReportUnavailable => StatusCode::SERVICE_UNAVAILABLE,
        }
    }
}

#[utoipa::path(
    get,
    path = "/api/v1/migrations/latest",
    operation_id = "getLatestMigration",
    description = "Read validated local migration evidence from the trusted server-configured report. Reports are limited to 1 MiB. A sibling run-marker.json suppresses the report while a run is active or interrupted. All responses use Cache-Control: no-store.",
    responses(
        (status = 200, description = "Validated local report; publication blockers and failed/not-run states remain explicit", body = MigrationReport),
        (status = 404, description = "No local report configured or present", body = MigrationReportError),
        (status = 503, description = "Report unavailable: active/interrupted run, unreadable, oversized, or invalid evidence", body = MigrationReportError)
    )
)]
pub(crate) async fn latest(State(report_path): State<Option<PathBuf>>) -> Response {
    let result = match report_path {
        Some(path) => tokio::task::spawn_blocking(move || read_report(&path))
            .await
            .unwrap_or(Err(MigrationReportErrorCode::MigrationReportUnavailable)),
        None => Err(MigrationReportErrorCode::MigrationReportNotFound),
    };
    let mut response = match result {
        Ok(report) => Json(report).into_response(),
        Err(error) => (error.status(), Json(MigrationReportError { error })).into_response(),
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn io_error(error: io::Error) -> MigrationReportErrorCode {
    if error.kind() == io::ErrorKind::NotFound {
        MigrationReportErrorCode::MigrationReportNotFound
    } else {
        MigrationReportErrorCode::MigrationReportUnavailable
    }
}

fn check_marker(path: &Path) -> Result<(), MigrationReportErrorCode> {
    // Even malformed content, directories, or dangling symlinks mean incomplete.
    match fs::symlink_metadata(path.with_file_name("run-marker.json")) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        _ => Err(MigrationReportErrorCode::MigrationReportUnavailable),
    }
}

fn read_report(path: &Path) -> Result<MigrationReport, MigrationReportErrorCode> {
    check_marker(path)?;
    let result = (|| {
        let metadata = fs::metadata(path).map_err(io_error)?;
        if !metadata.is_file() || metadata.len() > MAX_REPORT_BYTES as u64 {
            return Err(MigrationReportErrorCode::MigrationReportUnavailable);
        }
        let file = File::open(path).map_err(io_error)?;
        read_bounded_report(path, file)
    })();
    check_marker(path)?;
    result
}

fn read_bounded_report(
    path: &Path,
    reader: impl Read,
) -> Result<MigrationReport, MigrationReportErrorCode> {
    check_marker(path)?;
    let result = (|| {
        let mut bytes = Vec::new();
        reader
            .take(MAX_REPORT_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| MigrationReportErrorCode::MigrationReportUnavailable)?;
        if bytes.len() > MAX_REPORT_BYTES {
            return Err(MigrationReportErrorCode::MigrationReportUnavailable);
        }
        let report: MigrationReport = serde_json::from_slice(&bytes)
            .map_err(|_| MigrationReportErrorCode::MigrationReportUnavailable)?;
        report
            .validate()
            .map_err(|_| MigrationReportErrorCode::MigrationReportUnavailable)?;
        Ok(report)
    })();
    // A worker can acquire its marker after the first check and before this read.
    check_marker(path)?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use reltide_domain::{
        SourceFingerprint, StripeInputs, VerificationStatus, plan_stripe_migration,
    };
    use std::io::Cursor;

    fn valid_report_bytes() -> Vec<u8> {
        let plan = plan_stripe_migration(&StripeInputs {
            explicit_client: include_str!(
                "../../../fixtures/stripe-migration/before/src/client.ts"
            )
            .into(),
            explicit_helper: include_str!(
                "../../../fixtures/stripe-migration/before/src/latest-charge.ts"
            )
            .into(),
            pinned_control: include_str!(
                "../../../fixtures/stripe-migration/after/src/pinned-version.ts"
            )
            .into(),
            unknown_control: include_str!(
                "../../../fixtures/stripe-migration/before/src/ambiguous-version.ts"
            )
            .into(),
        })
        .unwrap();
        let report = MigrationReport {
            schema_version: 1,
            fixture: "fixtures/stripe-migration".into(),
            source_fingerprints: [
                "before/src/client.ts",
                "before/src/latest-charge.ts",
                "after/src/pinned-version.ts",
                "before/src/ambiguous-version.ts",
            ]
            .into_iter()
            .map(|path| SourceFingerprint {
                path: path.into(),
                sha256: "a".repeat(64),
            })
            .collect(),
            created_at_unix_ms: 1_792_000_000_000,
            verification_status: VerificationStatus::NotRun,
            blockers: plan.blockers.clone(),
            plan,
            checks: vec![],
            generated_diff: String::new(),
            pr_preview: String::new(),
        };
        report.validate().unwrap();
        serde_json::to_vec(&report).unwrap()
    }

    struct MarkerDuringRead {
        bytes: Cursor<Vec<u8>>,
        marker: PathBuf,
    }

    impl Read for MarkerDuringRead {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            fs::write(&self.marker, "incomplete")?;
            self.bytes.read(buffer)
        }
    }

    #[test]
    fn marker_created_during_bounded_read_suppresses_valid_report() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("report.json");
        let bytes = valid_report_bytes();
        assert!(read_bounded_report(&path, Cursor::new(bytes.clone())).is_ok());
        let reader = MarkerDuringRead {
            bytes: Cursor::new(bytes),
            marker: directory.path().join("run-marker.json"),
        };
        assert!(matches!(
            read_bounded_report(&path, reader),
            Err(MigrationReportErrorCode::MigrationReportUnavailable)
        ));
    }

    struct CountingReader {
        count: usize,
    }

    impl Read for CountingReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            buffer.fill(b' ');
            self.count += buffer.len();
            Ok(buffer.len())
        }
    }

    #[test]
    fn bounded_read_consumes_at_most_one_mib_plus_one_sentinel_byte() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("report.json");
        let mut reader = CountingReader { count: 0 };
        assert!(matches!(
            read_bounded_report(&path, &mut reader),
            Err(MigrationReportErrorCode::MigrationReportUnavailable)
        ));
        assert_eq!(reader.count, 1024 * 1024 + 1);
    }
}
