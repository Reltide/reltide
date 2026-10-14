use std::io::Write;
use std::process::{Command, Stdio};

use reltide_domain::{
    BlockerKind, CheckKind, CheckResult, CheckStatus, FindingDisposition, MigrationReport,
    SourceFingerprint, StripeInputs, VerificationStatus, plan_stripe_migration,
};

fn inputs() -> StripeInputs {
    StripeInputs {
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
    }
}

fn verified_report() -> MigrationReport {
    let plan = plan_stripe_migration(&inputs()).unwrap();
    MigrationReport {
        schema_version: 1,
        fixture: "fixtures/stripe-migration".into(),
        created_at_unix_ms: 1_792_000_000_000,
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
        verification_status: VerificationStatus::LocallyVerified,
        checks: [
            CheckKind::BeforeTypecheck,
            CheckKind::BeforeBaseline,
            CheckKind::BeforeRegression,
            CheckKind::CandidateTypecheck,
            CheckKind::CandidateRegression,
            CheckKind::PinnedControl,
            CheckKind::UnknownControl,
        ]
        .into_iter()
        .map(|kind| CheckResult {
            kind,
            command: "node controlled-check.mjs".into(),
            exit_code: Some(if kind == CheckKind::BeforeRegression {
                1
            } else {
                0
            }),
            status: if kind == CheckKind::BeforeRegression {
                CheckStatus::ExpectedFailure
            } else {
                CheckStatus::Passed
            },
            output: if kind == CheckKind::BeforeRegression {
                    "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n+ actual - expected\n\n+ null\n- 'ch_new_001'\n  code: 'ERR_ASSERTION',\n  actual: null,\n  expected: 'ch_new_001',\n  operator: 'strictEqual',\n  diff: 'simple'".into()
            } else {
                "passed".into()
            },
            duration_ms: 10,
        })
        .collect(),
        generated_diff: "--- before/src/latest-charge.ts\n+++ candidate/src/latest-charge.ts\n"
            .into(),
        pr_preview: "Local target-only PR preview; publication held.".into(),
        blockers: plan.blockers.clone(),
        plan,
    }
}

#[test]
fn explicit_target_generates_latest_charge_patch() {
    let plan = plan_stripe_migration(&inputs()).unwrap();
    let edit = plan
        .edits
        .iter()
        .find(|edit| edit.path == "before/src/latest-charge.ts")
        .unwrap();
    assert!(
        edit.updated
            .contains("Pick<Stripe.PaymentIntent, 'latest_charge'>")
    );
    let script = format!(
        "{}\nimport assert from 'node:assert/strict';\nassert.equal(latestChargeId({{ latest_charge: 'ch_string' }}), 'ch_string');\nassert.equal(latestChargeId({{ latest_charge: {{ id: 'ch_expanded' }} }}), 'ch_expanded');\nassert.equal(latestChargeId({{ latest_charge: null }}), null);\nassert.equal(latestChargeId({{}}), null);",
        edit.updated
    );
    let mut child = Command::new("node")
        .args([
            "--experimental-strip-types",
            "--input-type=module-typescript",
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(script.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        plan.edits
            .iter()
            .any(|edit| edit.path == "before/src/client.ts"
                && edit.updated.contains("apiVersion: '2022-11-15'"))
    );
}

#[test]
fn old_pin_retains_legacy_access() {
    let plan = plan_stripe_migration(&inputs()).unwrap();
    assert!(
        plan.findings
            .iter()
            .any(|finding| finding.file == "after/src/pinned-version.ts"
                && finding.disposition == FindingDisposition::RetainLegacy)
    );
    assert!(
        !plan
            .edits
            .iter()
            .any(|edit| edit.path == "after/src/pinned-version.ts")
    );
}

#[test]
fn unknown_default_blocks_package_upgrade() {
    let plan = plan_stripe_migration(&inputs()).unwrap();
    assert!(
        plan.findings
            .iter()
            .any(|finding| finding.file == "before/src/ambiguous-version.ts"
                && finding.disposition == FindingDisposition::RequireVersionEvidence)
    );
    assert!(
        plan.blockers
            .iter()
            .any(|blocker| blocker.kind == BlockerKind::UnknownAccountDefault)
    );
    assert!(
        plan.blockers
            .iter()
            .any(|blocker| blocker.kind == BlockerKind::IndependentReviewMissing)
    );
    assert!(
        !plan
            .edits
            .iter()
            .any(|edit| edit.path == "before/src/ambiguous-version.ts")
    );
}

#[test]
fn unsupported_source_is_rejected() {
    let mut source = inputs();
    source.explicit_helper = source.explicit_helper.replace("data[0]", "data[1]");
    assert!(plan_stripe_migration(&source).is_err());
}

#[test]
fn multiply_matched_sources_are_rejected() {
    let mut source = inputs();
    source
        .explicit_client
        .push_str(&source.explicit_client.clone());
    assert!(plan_stripe_migration(&source).is_err());
}

#[test]
fn missing_or_failed_checks_cannot_validate_success() {
    let report = verified_report();
    assert!(report.validate().is_ok());
    for index in 0..report.checks.len() {
        let mut missing = report.clone();
        missing.checks.remove(index);
        assert!(missing.validate().is_err(), "missing check {index}");
        let mut failed = report.clone();
        failed.checks[index].status = CheckStatus::Failed;
        failed.checks[index].exit_code = Some(1);
        assert!(failed.validate().is_err(), "failed check {index}");
        let mut not_run = report.clone();
        not_run.checks[index].status = CheckStatus::NotRun;
        not_run.checks[index].exit_code = None;
        assert!(not_run.validate().is_err(), "not-run check {index}");
    }
}

#[test]
fn missing_regression_evidence_cannot_validate_success() {
    let mut report = verified_report();
    report
        .checks
        .iter_mut()
        .find(|check| check.kind == CheckKind::BeforeRegression)
        .unwrap()
        .output = "module not found".into();
    assert!(report.validate().is_err());
}

#[test]
fn discarded_publication_blockers_are_rejected() {
    let mut report = verified_report();
    report.blockers.clear();
    assert!(report.validate().is_err());
    report.plan.blockers.clear();
    assert!(report.validate().is_err());
}

#[test]
fn honest_failed_and_incomplete_reports_remain_readable() {
    let mut report = verified_report();
    report.verification_status = VerificationStatus::Failed;
    report.checks[0].status = CheckStatus::Failed;
    report.checks[0].exit_code = Some(1);
    assert!(report.validate().is_ok());
    report.verification_status = VerificationStatus::NotRun;
    report.checks.clear();
    assert!(report.validate().is_ok());
}

#[test]
fn malformed_or_oversized_check_results_are_rejected() {
    let report = verified_report();
    let mut wrong_exit = report.clone();
    wrong_exit.checks[0].exit_code = Some(1);
    assert!(wrong_exit.validate().is_err());
    let mut duplicate = report.clone();
    duplicate.checks.push(duplicate.checks[0].clone());
    assert!(duplicate.validate().is_err());
    let mut oversized = report;
    oversized.checks[0].output = "x".repeat(16_385);
    assert!(oversized.validate().is_err());
}

#[test]
fn missing_or_invalid_source_identity_is_rejected() {
    let report = verified_report();
    let mut missing = report.clone();
    missing.source_fingerprints.pop();
    assert!(missing.validate().is_err());
    let mut invalid = report;
    invalid.source_fingerprints[0].sha256 = "not a sha256 fingerprint".into();
    assert!(invalid.validate().is_err());
}

#[test]
fn altered_plan_cannot_misrepresent_supported_migration() {
    let report = verified_report();
    let mut missing_evidence = report.clone();
    missing_evidence.plan.evidence.clear();
    assert!(missing_evidence.validate().is_err());
    let mut altered_control = report.clone();
    altered_control.plan.findings[2].disposition = FindingDisposition::Migrate;
    assert!(altered_control.validate().is_err());
    let mut altered_edit = report;
    altered_edit.plan.edits[1].updated = "export function latestChargeId() { return null; }".into();
    assert!(altered_edit.validate().is_err());
}

#[test]
fn actual_node_regression_signature_can_validate_success() {
    let mut report = verified_report();
    report.checks.iter_mut().find(|check| check.kind == CheckKind::BeforeRegression).unwrap().output =
        "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n+ actual - expected\n\n+ null\n- 'ch_new_001'\n  code: 'ERR_ASSERTION',\n  actual: null,\n  expected: 'ch_new_001',\n  operator: 'strictEqual',\n  diff: 'simple'".into();
    assert!(report.validate().is_ok());
}

#[test]
fn different_regression_assertions_cannot_validate_success() {
    for (old, replacement) in [
        ("code: 'ERR_ASSERTION'", "code: 'ERR_MODULE_NOT_FOUND'"),
        ("actual: null,", "actual: undefined,"),
        ("expected: 'ch_new_001',", "expected: 'ch_wrong',"),
        ("operator: 'strictEqual'", "operator: 'notStrictEqual'"),
    ] {
        let mut report = verified_report();
        let check = report
            .checks
            .iter_mut()
            .find(|check| check.kind == CheckKind::BeforeRegression)
            .unwrap();
        check.output = check.output.replace(old, replacement);
        assert!(
            report.validate().is_err(),
            "incorrect regression assertion {replacement}"
        );
    }
}
