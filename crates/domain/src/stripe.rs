//! Pure transformation of the trusted historical Stripe fixture's source shapes.

use crate::migration::{
    BlockerKind, EvidenceLink, FileEdit, FindingDisposition, MigrationError, MigrationFinding,
    MigrationPlan, MigrationScope, PublicationBlocker,
};

/// Source inputs for the explicit target and both preserved controls.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StripeInputs {
    /// `before/src/client.ts` with explicit `2022-08-01` API version.
    pub explicit_client: String,
    /// `before/src/latest-charge.ts` with supported legacy charge access.
    pub explicit_helper: String,
    /// `after/src/pinned-version.ts` retaining its explicit older API pin.
    pub pinned_control: String,
    /// `before/src/ambiguous-version.ts` with unknown account default.
    pub unknown_control: String,
}

// This literal allowlist does not change when fixture files change on disk.
const SUPPORTED_CLIENT: &str = "import Stripe from 'stripe';\n\n// The target scenario starts with the 2022-08-01 API response shape.\nexport function createStripeClient(apiKey: string): Stripe {\n  return new Stripe(apiKey, { apiVersion: '2022-08-01' });\n}\n";
const SUPPORTED_HELPER: &str = "import type Stripe from 'stripe';\n\nexport function latestChargeId(\n  intent: Pick<Stripe.PaymentIntent, 'charges'>,\n): string | null {\n  return intent.charges?.data[0]?.id ?? null;\n}\n";
const SUPPORTED_PINNED: &str = "import Stripe from 'stripe';\n\nexport const PINNED_API_VERSION = '2022-08-01' as const;\n\nexport function createPinnedClient(apiKey: string): Stripe {\n  // @ts-expect-error stripe-node 12 types describe its 2022-11-15 default.\n  // Stripe documents older runtime pins as supported, with a type suppression.\n  return new Stripe(apiKey, { apiVersion: PINNED_API_VERSION });\n}\n\n// The explicit old API pin preserves this legacy response shape. A narrow local\n// type reflects that shape because stripe-node 12 types only model 2022-11-15.\nexport function latestChargeIdForPinnedVersion(intent: {\n  charges?: { data: Array<{ id: string }> };\n}): string | null {\n  return intent.charges?.data[0]?.id ?? null;\n}\n";
const SUPPORTED_UNKNOWN: &str = "import Stripe from 'stripe';\n\n// No account default API version is recorded for this separate case.\n// Its response shape cannot be inferred solely from this constructor.\nexport function createAmbiguousClient(apiKey: string): Stripe {\n  // @ts-expect-error The old SDK requires a version in its types although its\n  // runtime supports an unversioned constructor and uses the account default.\n  return new Stripe(apiKey);\n}\n\nexport function latestChargeIdWithUnknownVersion(intent: {\n  charges?: { data: Array<{ id: string }> };\n}): string | null {\n  return intent.charges?.data[0]?.id ?? null;\n}\n";

fn guard(source: &str, supported: &str, marker: &str, path: &str) -> Result<(), MigrationError> {
    if source.matches(marker).count() > 1 {
        return Err(MigrationError::MultipleMatches(path.into()));
    }
    if source != supported {
        return Err(MigrationError::UnsupportedSource(path.into()));
    }
    Ok(())
}

pub(crate) fn validate_plan(plan: &MigrationPlan) -> Result<(), MigrationError> {
    let supported = plan_stripe_migration(&StripeInputs {
        explicit_client: SUPPORTED_CLIENT.into(),
        explicit_helper: SUPPORTED_HELPER.into(),
        pinned_control: SUPPORTED_PINNED.into(),
        unknown_control: SUPPORTED_UNKNOWN.into(),
    })?;
    if plan != &supported {
        return Err(MigrationError::InvalidReport(
            "plan differs from the supported target-only migration evidence and edits".into(),
        ));
    }
    Ok(())
}

/// Generates target-only source edits and evidence without executing commands.
///
/// # Errors
/// Rejects changed or multiply matched source shapes. Only the exact trusted
/// synthetic fixture is supported; this is not a general TypeScript parser.
pub fn plan_stripe_migration(inputs: &StripeInputs) -> Result<MigrationPlan, MigrationError> {
    guard(
        &inputs.explicit_client,
        SUPPORTED_CLIENT,
        "export function createStripeClient(",
        "before/src/client.ts",
    )?;
    guard(
        &inputs.explicit_helper,
        SUPPORTED_HELPER,
        "export function latestChargeId(",
        "before/src/latest-charge.ts",
    )?;
    guard(
        &inputs.pinned_control,
        SUPPORTED_PINNED,
        "export function createPinnedClient(",
        "after/src/pinned-version.ts",
    )?;
    guard(
        &inputs.unknown_control,
        SUPPORTED_UNKNOWN,
        "export function createAmbiguousClient(",
        "before/src/ambiguous-version.ts",
    )?;

    let client = inputs
        .explicit_client
        .replace("apiVersion: '2022-08-01'", "apiVersion: '2022-11-15'")
        .replace(
            "// The target scenario starts with the 2022-08-01 API response shape.",
            "// The explicit target requests the 2022-11-15 API response shape.",
        );
    let helper = inputs.explicit_helper.replace("'charges'", "'latest_charge'")
        .replace("  return intent.charges?.data[0]?.id ?? null;", "  const charge = intent.latest_charge;\n  return typeof charge === 'string' ? charge : charge?.id ?? null;");
    Ok(MigrationPlan {
        source_sdk_version: "10.17.0".into(), target_sdk_version: "12.0.0".into(),
        source_api_version: "2022-08-01".into(), target_api_version: "2022-11-15".into(),
        scope: MigrationScope::ExplicitTargetOnly,
        evidence: vec![
            EvidenceLink { title: "Stripe 2022-11-15 removes PaymentIntent.charges".into(), url: "https://docs.stripe.com/changelog/2022-11-15/removes-charges-attribute-paymentintent".into(), immutable: false },
            EvidenceLink { title: "stripe-node 10.17.0 legacy PaymentIntent declarations".into(), url: "https://github.com/stripe/stripe-node/blob/82fb3afd8e6c39868ca054cae99b0bd6ec1be846/types/2022-08-01/PaymentIntents.d.ts#L76-L79".into(), immutable: true },
            EvidenceLink { title: "stripe-node 12.0.0 latest_charge declarations".into(), url: "https://github.com/stripe/stripe-node/blob/26e730a29299c167e8c8814cda23998bb388a09d/types/PaymentIntents.d.ts#L121-L124".into(), immutable: true },
            EvidenceLink { title: "Stripe Node v12 migration guide: defaults and explicit older pins".into(), url: "https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v12".into(), immutable: false },
        ],
        findings: vec![
            MigrationFinding { file: "before/src/client.ts".into(), line: 5, disposition: FindingDisposition::Migrate, reason: "Explicitly upgrade the target API pin from 2022-08-01 to 2022-11-15 with the historical SDK upgrade.".into() },
            MigrationFinding { file: "before/src/latest-charge.ts".into(), line: 6, disposition: FindingDisposition::Migrate, reason: "The explicit target removes charges; latest_charge can be an ID, expanded Charge, or null.".into() },
            MigrationFinding { file: "after/src/pinned-version.ts".into(), line: 16, disposition: FindingDisposition::RetainLegacy, reason: "The explicit 2022-08-01 API pin retains the legacy response shape despite SDK 12.0.0.".into() },
            MigrationFinding { file: "before/src/ambiguous-version.ts".into(), line: 8, disposition: FindingDisposition::RequireVersionEvidence, reason: "The old unversioned client uses an unknown account default; SDK 12 changes that default, so package-wide publication is blocked.".into() },
        ],
        edits: vec![
            FileEdit { path: "before/src/client.ts".into(), original: inputs.explicit_client.clone(), updated: client },
            FileEdit { path: "before/src/latest-charge.ts".into(), original: inputs.explicit_helper.clone(), updated: helper },
        ],
        blockers: vec![
            PublicationBlocker { kind: BlockerKind::UnknownAccountDefault, reason: "Account default API version evidence is missing for before/src/ambiguous-version.ts; a package-wide SDK upgrade cannot be published safely.".into() },
            PublicationBlocker { kind: BlockerKind::IndependentReviewMissing, reason: "Independent review tied to the generated candidate is not configured; publication requires human review.".into() },
        ],
    })
}
