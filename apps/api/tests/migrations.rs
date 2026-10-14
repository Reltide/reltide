use std::{fs, path::Path, process::Command};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use reltide_domain::{
    CheckKind, CheckResult, CheckStatus, MigrationReport, SourceFingerprint, StripeInputs,
    VerificationStatus, plan_stripe_migration,
};
use serde_json::{Value, json};
use tower::ServiceExt;

fn report() -> MigrationReport {
    let plan = plan_stripe_migration(&StripeInputs {
        explicit_client: include_str!("../../../fixtures/stripe-migration/before/src/client.ts")
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
    MigrationReport {
        schema_version: 1,
        fixture: "fixtures/stripe-migration".into(),
        source_fingerprints: ["before/src/client.ts", "before/src/latest-charge.ts", "after/src/pinned-version.ts", "before/src/ambiguous-version.ts"].into_iter().map(|path| SourceFingerprint { path: path.into(), sha256: "a".repeat(64) }).collect(),
        created_at_unix_ms: 1_792_000_000_000,
        verification_status: VerificationStatus::LocallyVerified,
        checks: [CheckKind::BeforeTypecheck, CheckKind::BeforeBaseline, CheckKind::BeforeRegression, CheckKind::CandidateTypecheck, CheckKind::CandidateRegression, CheckKind::PinnedControl, CheckKind::UnknownControl].into_iter().map(|kind| CheckResult {
            kind,
            command: "node controlled-check.mjs".into(),
            exit_code: Some(if kind == CheckKind::BeforeRegression { 1 } else { 0 }),
            status: if kind == CheckKind::BeforeRegression { CheckStatus::ExpectedFailure } else { CheckStatus::Passed },
            output: if kind == CheckKind::BeforeRegression { "code: 'ERR_ASSERTION', actual: null, expected: 'ch_new_001', operator: 'strictEqual'".into() } else { "passed".into() },
            duration_ms: 10,
        }).collect(),
        generated_diff: "--- before/src/latest-charge.ts\n+++ candidate/src/latest-charge.ts\n".into(),
        pr_preview: "Local target-only preview; publication held.".into(),
        blockers: plan.blockers.clone(),
        plan,
    }
}

fn expected_error(status: &str) -> Value {
    let responses: Value =
        serde_json::from_str(include_str!("fixtures/report-errors.json")).unwrap();
    responses[status].clone()
}

fn persist(path: &Path, report: &MigrationReport) {
    fs::write(path, serde_json::to_vec(report).unwrap()).unwrap();
}

async fn request(router: Router) -> (StatusCode, Value) {
    let response = router
        .oneshot(
            Request::builder()
                .uri("/api/v1/migrations/latest")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn verified_report_preserves_evidence_checks_and_publication_blockers() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("report.json");
    persist(&path, &report());
    let (status, body) = request(reltide_api::api_with_report(Some(path)).0).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["verification_status"], "locally_verified");
    assert_eq!(body["plan"]["source_sdk_version"], "10.17.0");
    assert_eq!(body["plan"]["target_sdk_version"], "12.0.0");
    assert_eq!(body["plan"]["scope"], "explicit_target_only");
    assert_eq!(body["checks"].as_array().unwrap().len(), 7);
    assert_eq!(body["checks"][2]["status"], "expected_failure");
    assert_eq!(body["checks"][2]["exit_code"], 1);
    assert_eq!(body["blockers"][0]["kind"], "unknown_account_default");
    assert_eq!(body["blockers"][1]["kind"], "independent_review_missing");
    assert!(
        body["generated_diff"]
            .as_str()
            .unwrap()
            .contains("latest-charge.ts")
    );
    assert!(
        body["pr_preview"]
            .as_str()
            .unwrap()
            .contains("publication held")
    );
}

#[tokio::test]
async fn missing_and_unconfigured_reports_return_generic_json_404() {
    let directory = tempfile::tempdir().unwrap();
    for report_path in [
        None,
        Some(directory.path().join("missing-private-report.json")),
    ] {
        let (status, body) = request(reltide_api::api_with_report(report_path).0).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body, expected_error("404"));
    }
}

#[tokio::test]
async fn malformed_oversized_and_unreadable_reports_return_generic_json_503() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("private-report.json");
    for bytes in [
        b"{private malformed content".to_vec(),
        vec![b' '; 1024 * 1024 + 1],
    ] {
        fs::write(&path, bytes).unwrap();
        let (status, body) = request(reltide_api::api_with_report(Some(path.clone())).0).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body, expected_error("503"));
    }
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    let (status, body) = request(reltide_api::api_with_report(Some(path)).0).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body, expected_error("503"));
}

#[tokio::test]
async fn invalid_schema_check_policy_and_discarded_blockers_are_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("report.json");
    let mut invalid_schema = report();
    invalid_schema.schema_version = 2;
    let mut invalid_check = report();
    invalid_check.checks[2].output = "unrelated failure".into();
    let mut discarded_blockers = report();
    discarded_blockers.blockers.clear();
    for invalid in [invalid_schema, invalid_check, discarded_blockers] {
        persist(&path, &invalid);
        let (status, body) = request(reltide_api::api_with_report(Some(path.clone())).0).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body, expected_error("503"));
    }
}

#[tokio::test]
async fn marker_suppresses_verified_missing_and_malformed_reports_until_removed() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("report.json");
    let marker = directory.path().join("run-marker.json");
    // Marker existence is authoritative even if its content is unreadable JSON.
    fs::write(&marker, "private interrupted attempt").unwrap();
    for bytes in [
        None,
        Some(serde_json::to_vec(&report()).unwrap()),
        Some(b"broken".to_vec()),
    ] {
        if let Some(bytes) = bytes {
            fs::write(&path, bytes).unwrap();
        }
        let (status, body) = request(reltide_api::api_with_report(Some(path.clone())).0).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body, expected_error("503"));
    }
    persist(&path, &report());
    fs::remove_file(marker).unwrap();
    assert_eq!(
        request(reltide_api::api_with_report(Some(path)).0).await.0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn valid_failed_and_not_run_reports_are_served_honestly() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("report.json");
    for (verification_status, expected) in [
        (VerificationStatus::Failed, "failed"),
        (VerificationStatus::NotRun, "not_run"),
    ] {
        let mut incomplete = report();
        incomplete.verification_status = verification_status;
        incomplete.checks.clear();
        incomplete.generated_diff.clear();
        persist(&path, &incomplete);
        let (status, body) = request(reltide_api::api_with_report(Some(path.clone())).0).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["verification_status"], expected);
        assert_eq!(body["checks"], json!([]));
        assert_eq!(body["blockers"].as_array().unwrap().len(), 2);
    }
}

#[test]
fn migration_contract_is_exported_without_reading_report_or_binding() {
    let output = Command::new(env!("CARGO_BIN_EXE_reltide-api"))
        .arg("--print-openapi")
        .env("RELTIDE_API_BIND", "invalid")
        .env(
            "RELTIDE_MIGRATION_REPORT",
            "/private/nonexistent/report.json",
        )
        .output()
        .unwrap();
    assert!(output.status.success());
    let contract: Value = serde_json::from_slice(&output.stdout).unwrap();
    let operation = &contract["paths"]["/api/v1/migrations/latest"]["get"];
    assert_eq!(operation["operationId"], "getLatestMigration");
    assert_eq!(
        operation["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/MigrationReport"
    );
    for code in ["404", "503"] {
        assert_eq!(
            operation["responses"][code]["content"]["application/json"]["schema"]["$ref"],
            "#/components/schemas/MigrationReportError"
        );
    }
    assert!(operation.get("parameters").is_none());
    assert_eq!(
        contract["paths"]["/api/v1/health"]["get"]["operationId"],
        "getHealth"
    );
}

#[tokio::test]
async fn one_mib_report_is_accepted_but_one_extra_byte_is_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("report.json");
    let mut bytes = serde_json::to_vec(&report()).unwrap();
    bytes.resize(1024 * 1024, b' ');
    fs::write(&path, &bytes).unwrap();
    assert_eq!(
        request(reltide_api::api_with_report(Some(path.clone())).0)
            .await
            .0,
        StatusCode::OK
    );
    bytes.push(b' ');
    fs::write(&path, &bytes).unwrap();
    assert_eq!(
        request(reltide_api::api_with_report(Some(path)).0).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[tokio::test]
async fn request_query_cannot_select_a_different_report() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("report.json");
    persist(&path, &report());
    let response = reltide_api::api_with_report(Some(path))
        .0
        .oneshot(
            Request::builder()
                .uri("/api/v1/migrations/latest?path=/private/missing.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}
