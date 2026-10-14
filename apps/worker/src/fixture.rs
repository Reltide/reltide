use crate::{DemoError, artifacts};
use reltide_domain::{
    MigrationPlan, MigrationReport, SourceFingerprint, StripeInputs, VerificationStatus,
    plan_stripe_migration,
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::Path};

const INPUTS: &[&str] = &[
    "before/src/client.ts",
    "before/src/latest-charge.ts",
    "before/src/ambiguous-version.ts",
    "after/src/pinned-version.ts",
    "before/package.json",
    "before/package-lock.json",
    "before/tsconfig.json",
    "after/package.json",
    "after/package-lock.json",
    "after/tsconfig.json",
    "tests/baseline.mjs",
    "tests/regression.mjs",
    "scenarios.json",
];
const VERIFICATION_PROGRAMS: &[(&str, &str)] = &[
    (
        "tests/candidate.mjs",
        r#"import assert from 'node:assert/strict';
import { createStripeClient } from '../after/src/client.ts';
import { latestChargeId } from '../after/src/latest-charge.ts';

assert.equal(
  createStripeClient('fixture_not_a_secret').getApiField('version'),
  '2022-11-15',
);
assert.equal(latestChargeId({ latest_charge: 'ch_new_001' }), 'ch_new_001');
assert.equal(latestChargeId({ latest_charge: { id: 'ch_new_002' } }), 'ch_new_002');
assert.equal(latestChargeId({ latest_charge: null }), null);
assert.equal(latestChargeId({}), null);
console.log('Generated explicit target API pin and all latest_charge variants passed.');
"#,
    ),
    (
        "tests/pinned.mjs",
        r#"import assert from 'node:assert/strict';
import { createPinnedClient, latestChargeIdForPinnedVersion, PINNED_API_VERSION } from '../after/src/pinned-version.ts';

assert.equal(PINNED_API_VERSION, '2022-08-01');
assert.equal(createPinnedClient('fixture_not_a_secret').getApiField('version'), '2022-08-01');
assert.equal(latestChargeIdForPinnedVersion({ charges: { data: [{ id: 'ch_pinned_001' }] } }), 'ch_pinned_001');
assert.equal(latestChargeIdForPinnedVersion({ charges: { data: [] } }), null);
console.log('SDK 12 older API pin retains legacy handling.');
"#,
    ),
    (
        "tests/unknown.mjs",
        r#"import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAmbiguousClient } from '../before/src/ambiguous-version.ts';

const scenarios = JSON.parse(await readFile(new URL('../scenarios.json', import.meta.url), 'utf8'));
assert.equal(scenarios.ambiguousVersion.accountDefaultApiVersion, null);
assert.equal(createAmbiguousClient('fixture_not_a_secret').getApiField('version'), null);
assert.equal(scenarios.ambiguousVersion.expectedDisposition, 'require version evidence before rewriting');
console.log('SDK 10 unknown account default still requires version evidence.');
"#,
    ),
];

const PATCH_PATHS: &[&str] = &[
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "src/client.ts",
    "src/latest-charge.ts",
];

pub(crate) struct Fixture {
    inputs: BTreeMap<String, Vec<u8>>,
}

impl Fixture {
    pub(crate) fn read(workspace: &Path) -> Result<Self, DemoError> {
        let root = workspace.join("fixtures/stripe-migration");
        let inputs = INPUTS
            .iter()
            .map(|path| Ok(((*path).to_owned(), fs::read(root.join(path))?)))
            .collect::<Result<_, DemoError>>()?;
        Ok(Self { inputs })
    }

    fn bytes(&self, path: &str) -> Result<&[u8], DemoError> {
        self.inputs
            .get(path)
            .map(Vec::as_slice)
            .ok_or_else(|| DemoError::Fixture(format!("missing {path}")))
    }

    fn text(&self, path: &str) -> Result<String, DemoError> {
        String::from_utf8(self.bytes(path)?.to_vec())
            .map_err(|error| DemoError::Fixture(error.to_string()))
    }

    pub(crate) fn report(&self) -> Result<MigrationReport, DemoError> {
        let plan = plan_stripe_migration(&StripeInputs {
            explicit_client: self.text("before/src/client.ts")?,
            explicit_helper: self.text("before/src/latest-charge.ts")?,
            pinned_control: self.text("after/src/pinned-version.ts")?,
            unknown_control: self.text("before/src/ambiguous-version.ts")?,
        })?;
        let mut report = MigrationReport {
            schema_version: 1,
            fixture: "fixtures/stripe-migration".into(),
            source_fingerprints: self
                .inputs
                .iter()
                .map(|(path, bytes)| fingerprint(path, bytes))
                .collect(),
            created_at_unix_ms: artifacts::now_ms()?,
            verification_status: VerificationStatus::NotRun,
            blockers: plan.blockers.clone(),
            plan,
            checks: Vec::new(),
            generated_diff: String::new(),
            pr_preview: String::new(),
        };
        report
            .source_fingerprints
            .extend(VERIFICATION_PROGRAMS.iter().map(|(path, program)| {
                fingerprint(&format!("worker-generated/{path}"), program.as_bytes())
            }));
        report.pr_preview = artifacts::preview(&report);
        Ok(report)
    }

    pub(crate) fn prepare(&self, root: &Path, plan: &MigrationPlan) -> Result<(), DemoError> {
        for (path, bytes) in &self.inputs {
            if path.starts_with("before/")
                || path.starts_with("tests/")
                || path == "scenarios.json"
                || path == "after/src/pinned-version.ts"
            {
                write(root, path, bytes)?;
            }
        }
        for (path, program) in VERIFICATION_PROGRAMS {
            write(root, path, program.as_bytes())?;
        }
        let manifest: serde_json::Value =
            serde_json::from_slice(self.bytes("before/package.json")?)?;
        let target_manifest: serde_json::Value =
            serde_json::from_slice(self.bytes("after/package.json")?)?;
        if manifest["dependencies"]["stripe"] != plan.source_sdk_version
            || target_manifest["dependencies"]["stripe"] != plan.target_sdk_version
            || manifest["devDependencies"]["typescript"] != "5.9.3"
            || target_manifest["devDependencies"]["typescript"] != "5.9.3"
        {
            return Err(DemoError::Fixture(
                "historical package pins do not match the canonical plan".into(),
            ));
        }
        let lock: serde_json::Value =
            serde_json::from_slice(self.bytes("after/package-lock.json")?)?;
        if lock["packages"]["node_modules/stripe"]["version"] != plan.target_sdk_version
            || lock["packages"][""]["dependencies"]["stripe"] != plan.target_sdk_version
        {
            return Err(DemoError::Fixture(
                "historical target lockfile does not match target SDK".into(),
            ));
        }
        let manifest_text = replace_exact(
            &self.text("before/package.json")?,
            &format!("\"stripe\": \"{}\"", plan.source_sdk_version),
            &format!("\"stripe\": \"{}\"", plan.target_sdk_version),
            1,
        )?;
        write(root, "after/package.json", manifest_text.as_bytes())?;
        let lock_text = replace_exact(
            &self.text("after/package-lock.json")?,
            &format!("\"name\": {}", serde_json::to_string(&lock["name"])?),
            &format!("\"name\": {}", serde_json::to_string(&manifest["name"])?),
            2,
        )?;
        write(root, "after/package-lock.json", lock_text.as_bytes())?;
        write(
            root,
            "after/tsconfig.json",
            self.bytes("before/tsconfig.json")?,
        )?;
        for edit in &plan.edits {
            let path = edit
                .path
                .strip_prefix("before/")
                .ok_or_else(|| DemoError::Fixture("unexpected generated edit path".into()))?;
            write(root, &format!("after/{path}"), edit.updated.as_bytes())?;
        }
        Ok(())
    }

    pub(crate) fn patch(&self, root: &Path) -> Result<String, DemoError> {
        let mut patch = String::new();
        for path in PATCH_PATHS {
            let original = self.text(&format!("before/{path}"))?;
            let updated = fs::read_to_string(root.join("after").join(path))?;
            if original == updated {
                continue;
            }
            // Whole-file unified hunks preserve the exact generated bytes without a shell or diff dependency.
            patch.push_str(&format!(
                "diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1,{} +1,{} @@\n",
                original.lines().count(),
                updated.lines().count()
            ));
            for (prefix, content) in [("-", original.as_str()), ("+", updated.as_str())] {
                for line in content.lines() {
                    patch.push_str(prefix);
                    patch.push_str(line);
                    patch.push('\n');
                }
                if !content.ends_with('\n') {
                    patch.push_str("\\ No newline at end of file\n");
                }
            }
        }
        Ok(patch)
    }

    pub(crate) fn fingerprint_candidate(
        &self,
        root: &Path,
        fingerprints: &mut Vec<SourceFingerprint>,
    ) -> Result<(), DemoError> {
        for path in PATCH_PATHS {
            fingerprints.push(fingerprint(
                &format!("candidate/{path}"),
                &fs::read(root.join("after").join(path))?,
            ));
        }
        Ok(())
    }
}

fn write(root: &Path, path: &str, bytes: &[u8]) -> Result<(), DemoError> {
    let destination = root.join(path);
    let parent = destination
        .parent()
        .ok_or_else(|| DemoError::Fixture("invalid candidate path".into()))?;
    fs::create_dir_all(parent)?;
    fs::write(destination, bytes)?;
    Ok(())
}

fn fingerprint(path: &str, bytes: &[u8]) -> SourceFingerprint {
    SourceFingerprint {
        path: path.into(),
        sha256: Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    }
}

fn replace_exact(
    source: &str,
    original: &str,
    updated: &str,
    count: usize,
) -> Result<String, DemoError> {
    if source.matches(original).count() != count {
        return Err(DemoError::Fixture(format!(
            "unsupported package/config pattern: {original}"
        )));
    }
    Ok(source.replace(original, updated))
}
