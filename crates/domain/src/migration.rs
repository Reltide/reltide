//! Migration evidence contracts shared by the local worker and read-only API.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use utoipa::ToSchema;

/// Maximum retained command output, measured in UTF-8 bytes.
pub const MAX_CHECK_OUTPUT_BYTES: usize = 16_384;
/// Version of the persisted report contract.
pub const REPORT_SCHEMA_VERSION: u32 = 1;

/// A supported source or report-policy violation.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum MigrationError {
    /// The trusted fixture differs from a supported source shape.
    #[error("unsupported source pattern in {0}")]
    UnsupportedSource(String),
    /// More than one supported source pattern was present.
    #[error("multiply matched source pattern in {0}")]
    MultipleMatches(String),
    /// The report cannot substantiate its stated result.
    #[error("invalid migration report: {0}")]
    InvalidReport(String),
}

/// The preview changes only the explicitly versioned target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum MigrationScope {
    /// Controls do not establish a safe package-wide migration.
    ExplicitTargetOnly,
}

/// Authoritative provider or immutable SDK source supporting a decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct EvidenceLink {
    /// What this reference establishes.
    pub title: String,
    /// Canonical documentation or commit-pinned source URL.
    pub url: String,
    /// Whether the reference pins immutable source bytes through a commit.
    pub immutable: bool,
}

/// How the supported source is classified.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FindingDisposition {
    /// Rewrite only the explicit target's helper and API version.
    Migrate,
    /// Keep the explicitly older response shape.
    RetainLegacy,
    /// Obtain account/version evidence before changing this control.
    RequireVersionEvidence,
}

/// A version-scoped finding with an exact source location.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct MigrationFinding {
    /// Path relative to the trusted fixture directory.
    pub file: String,
    /// One-based line identifying the affected expression.
    pub line: u32,
    /// Decision derived from effective API version evidence.
    pub disposition: FindingDisposition,
    /// Explanation of the decision and its limits.
    pub reason: String,
}

/// An edit generated from supported old source bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct FileEdit {
    /// Original path relative to the fixture.
    pub path: String,
    /// Exact supported input bytes retained for diff generation.
    pub original: String,
    /// Generated replacement bytes.
    pub updated: String,
}

/// Reasons publication remains held even after local verification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum BlockerKind {
    /// A package upgrade changes unversioned defaults without account evidence.
    UnknownAccountDefault,
    /// No independent review is tied to the generated candidate.
    IndependentReviewMissing,
}

/// A publication prerequisite that local checks cannot satisfy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct PublicationBlocker {
    /// Stable prerequisite identity.
    pub kind: BlockerKind,
    /// Human-readable reason publication remains held.
    pub reason: String,
}

/// Pure analysis and edits for the supported historical Stripe migration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct MigrationPlan {
    /// Historical SDK supplying the legacy declarations.
    pub source_sdk_version: String,
    /// Historical SDK supplying the target declarations.
    pub target_sdk_version: String,
    /// Explicit API version of the old target.
    pub source_api_version: String,
    /// Explicit API version requested by the generated target.
    pub target_api_version: String,
    /// Target-only preview boundary.
    pub scope: MigrationScope,
    /// Provider and immutable declaration references.
    pub evidence: Vec<EvidenceLink>,
    /// Explicit target and preserved control decisions.
    pub findings: Vec<MigrationFinding>,
    /// Generated source edits; controls remain unchanged.
    pub edits: Vec<FileEdit>,
    /// Prerequisites required before publication.
    pub blockers: Vec<PublicationBlocker>,
}

/// Fixed local verification identities; callers cannot replace mandatory checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CheckKind {
    /// Old target type checking.
    BeforeTypecheck,
    /// Old helper baseline and explicit version.
    BeforeBaseline,
    /// New-shape regression against the old helper, expected to fail.
    BeforeRegression,
    /// Generated target type checking.
    CandidateTypecheck,
    /// Generated helper handles string, expanded object, and null.
    CandidateRegression,
    /// Older API pin and legacy handling remain preserved.
    PinnedControl,
    /// Unknown-default control remains unclassified and unchanged.
    UnknownControl,
}

/// Outcome of a real command, separating evidenced regression from failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    /// Command exited successfully.
    Passed,
    /// The known old-helper regression failed for the expected assertion.
    ExpectedFailure,
    /// Command failed unexpectedly or could not execute.
    Failed,
    /// Command was not executed.
    NotRun,
}

/// Bounded command evidence captured by the Rust runner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct CheckResult {
    /// Fixed verification identity.
    pub kind: CheckKind,
    /// Actual command executed, including its fixed arguments.
    pub command: String,
    /// Actual process exit code when available.
    pub exit_code: Option<i32>,
    /// Outcome distinguished from publication readiness.
    pub status: CheckStatus,
    /// Retained combined output, at most [`MAX_CHECK_OUTPUT_BYTES`] bytes.
    pub output: String,
    /// Measured elapsed command time in milliseconds.
    pub duration_ms: u64,
}

/// Local verification result; this never authorizes publication.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStatus {
    /// All mandatory local checks and expected regression evidence are present.
    LocallyVerified,
    /// A local verification step failed.
    Failed,
    /// Verification has not completed.
    NotRun,
}

/// Content identity for one source input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct SourceFingerprint {
    /// Path relative to the trusted fixture directory.
    pub path: String,
    /// Lowercase hexadecimal SHA-256 of the exact input bytes.
    pub sha256: String,
}

/// Persisted local evidence, served by the API and consumed by the dashboard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct MigrationReport {
    /// Must be [`REPORT_SCHEMA_VERSION`].
    pub schema_version: u32,
    /// Trusted synthetic fixture identity, `fixtures/stripe-migration`.
    pub fixture: String,
    /// Source byte identities captured before verification.
    pub source_fingerprints: Vec<SourceFingerprint>,
    /// Report creation time as milliseconds since the Unix epoch.
    pub created_at_unix_ms: u64,
    /// Local result, independent from publication blockers.
    pub verification_status: VerificationStatus,
    /// Historical scope, source evidence, decisions, and generated edits.
    pub plan: MigrationPlan,
    /// Actual local command outcomes.
    pub checks: Vec<CheckResult>,
    /// Unified patch generated from the supported old source and candidate.
    pub generated_diff: String,
    /// Local Markdown PR preparation artifact with publication held.
    pub pr_preview: String,
    /// Retained unresolved prerequisites; never hidden by local success.
    pub blockers: Vec<PublicationBlocker>,
}

impl MigrationReport {
    /// Checks report consistency and evidence required for local success.
    /// Failed and incomplete reports remain valid when they state their result honestly.
    ///
    /// # Errors
    /// Returns [`MigrationError::InvalidReport`] for malformed identities, check
    /// evidence, discarded blockers, or an unsubstantiated local success.
    pub fn validate(&self) -> Result<(), MigrationError> {
        let invalid = |reason: &str| MigrationError::InvalidReport(reason.into());
        if self.schema_version != REPORT_SCHEMA_VERSION
            || self.fixture != "fixtures/stripe-migration"
            || self.created_at_unix_ms == 0
        {
            return Err(invalid("unsupported schema, fixture, or creation time"));
        }
        crate::stripe::validate_plan(&self.plan)?;
        for kind in [
            BlockerKind::UnknownAccountDefault,
            BlockerKind::IndependentReviewMissing,
        ] {
            let Some(blocker) = self
                .plan
                .blockers
                .iter()
                .find(|blocker| blocker.kind == kind)
            else {
                return Err(invalid("missing plan publication blocker"));
            };
            if blocker.reason.trim().is_empty() || !self.blockers.contains(blocker) {
                return Err(invalid("discarded publication blocker"));
            }
        }
        let mut paths = HashSet::new();
        for fingerprint in &self.source_fingerprints {
            if fingerprint.path.is_empty()
                || !paths.insert(fingerprint.path.as_str())
                || fingerprint.sha256.len() != 64
                || !fingerprint
                    .sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(invalid("invalid or duplicate source fingerprint"));
            }
        }
        for path in [
            "before/src/client.ts",
            "before/src/latest-charge.ts",
            "after/src/pinned-version.ts",
            "before/src/ambiguous-version.ts",
        ] {
            if !paths.contains(path) {
                return Err(invalid("missing required source fingerprint"));
            }
        }
        let mut kinds = HashSet::new();
        for check in &self.checks {
            if !kinds.insert(check.kind)
                || check.command.trim().is_empty()
                || check.output.len() > MAX_CHECK_OUTPUT_BYTES
            {
                return Err(invalid(
                    "duplicate check, missing command, or oversized output",
                ));
            }
            let consistent = match check.status {
                CheckStatus::Passed => check.exit_code == Some(0),
                CheckStatus::ExpectedFailure => {
                    check.kind == CheckKind::BeforeRegression
                        && check.exit_code == Some(1)
                        && check.output.contains("code: 'ERR_ASSERTION'")
                        && check.output.contains("actual: null,")
                        && check.output.contains("expected: 'ch_new_001',")
                        && check.output.contains("operator: 'strictEqual'")
                }
                CheckStatus::Failed => check.exit_code != Some(0),
                CheckStatus::NotRun => check.exit_code.is_none(),
            };
            if !consistent {
                return Err(invalid(
                    "check status contradicts exit code or regression evidence",
                ));
            }
        }
        if self.verification_status != VerificationStatus::LocallyVerified {
            return Ok(());
        }
        for kind in [
            CheckKind::BeforeTypecheck,
            CheckKind::BeforeBaseline,
            CheckKind::BeforeRegression,
            CheckKind::CandidateTypecheck,
            CheckKind::CandidateRegression,
            CheckKind::PinnedControl,
            CheckKind::UnknownControl,
        ] {
            let required = if kind == CheckKind::BeforeRegression {
                CheckStatus::ExpectedFailure
            } else {
                CheckStatus::Passed
            };
            if !self
                .checks
                .iter()
                .any(|check| check.kind == kind && check.status == required)
            {
                return Err(invalid(
                    "missing or unsuccessful mandatory verification check",
                ));
            }
        }
        if self.generated_diff.trim().is_empty() || self.pr_preview.trim().is_empty() {
            return Err(invalid("missing generated patch or PR preview"));
        }
        Ok(())
    }
}
