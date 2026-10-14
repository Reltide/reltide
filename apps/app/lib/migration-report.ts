import { getLatestMigration } from "@repo/api-client";
import type { MigrationReport } from "@repo/api-client";

export type MigrationReportState =
  | { kind: "unconfigured" | "empty" | "unavailable" }
  | { kind: "available"; report: MigrationReport };

const isBlocker = (
  value: MigrationReport["blockers"][number]
): value is MigrationReport["blockers"][number] =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof value.reason === "string" &&
  ["unknown_account_default", "independent_review_missing"].includes(
    value.kind
  );

const isFinding = (
  value: MigrationReport["plan"]["findings"][number]
): value is MigrationReport["plan"]["findings"][number] =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof value.file === "string" &&
  typeof value.reason === "string" &&
  typeof value.line === "number" &&
  ["migrate", "retain_legacy", "require_version_evidence"].includes(
    value.disposition
  );

const isEdit = (
  value: MigrationReport["plan"]["edits"][number]
): value is MigrationReport["plan"]["edits"][number] =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof value.path === "string" &&
  typeof value.original === "string" &&
  typeof value.updated === "string";

const isEvidence = (
  value: MigrationReport["plan"]["evidence"][number]
): value is MigrationReport["plan"]["evidence"][number] =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof value.title === "string" &&
  typeof value.url === "string" &&
  typeof value.immutable === "boolean";

const isFingerprint = (
  value: MigrationReport["source_fingerprints"][number]
): value is MigrationReport["source_fingerprints"][number] =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof value.path === "string" &&
  typeof value.sha256 === "string";

const isCheck = (
  value: MigrationReport["checks"][number]
): value is MigrationReport["checks"][number] =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof value.command === "string" &&
  typeof value.output === "string" &&
  typeof value.duration_ms === "number" &&
  (value.exit_code === undefined ||
    value.exit_code === null ||
    typeof value.exit_code === "number") &&
  [
    "before_typecheck",
    "before_baseline",
    "before_regression",
    "candidate_typecheck",
    "candidate_regression",
    "pinned_control",
    "unknown_control",
  ].includes(value.kind) &&
  ["passed", "expected_failure", "failed", "not_run"].includes(value.status);

const isPlan = (
  plan: MigrationReport["plan"]
): plan is MigrationReport["plan"] =>
  Boolean(plan) &&
  typeof plan === "object" &&
  typeof plan.source_sdk_version === "string" &&
  typeof plan.target_sdk_version === "string" &&
  typeof plan.source_api_version === "string" &&
  typeof plan.target_api_version === "string" &&
  plan.scope === "explicit_target_only" &&
  Array.isArray(plan.blockers) &&
  plan.blockers.every(isBlocker) &&
  Array.isArray(plan.findings) &&
  plan.findings.every(isFinding) &&
  Array.isArray(plan.edits) &&
  plan.edits.every(isEdit) &&
  Array.isArray(plan.evidence) &&
  plan.evidence.every(isEvidence);

// The generated Fetch client types JSON without decoding it. These transport guards
// protect rendering; Rust remains the owner of evidence and publication policy.
const isReadableReport = (
  value: MigrationReport | undefined
): value is MigrationReport => {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.fixture !== "string" ||
    typeof value.generated_diff !== "string" ||
    typeof value.pr_preview !== "string" ||
    typeof value.schema_version !== "number" ||
    typeof value.created_at_unix_ms !== "number" ||
    !Number.isFinite(value.created_at_unix_ms) ||
    Math.abs(value.created_at_unix_ms) > 8_640_000_000_000_000 ||
    !["locally_verified", "failed", "not_run"].includes(
      value.verification_status
    ) ||
    !Array.isArray(value.blockers) ||
    !value.blockers.every(isBlocker) ||
    !Array.isArray(value.source_fingerprints) ||
    !value.source_fingerprints.every(isFingerprint) ||
    !Array.isArray(value.checks) ||
    !value.checks.every(isCheck)
  ) {
    return false;
  }
  return isPlan(value.plan);
};

export const getMigrationReport = async (
  baseUrl?: string
): Promise<MigrationReportState> => {
  if (!baseUrl) {
    return { kind: "unconfigured" };
  }
  try {
    const parsed = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { kind: "unavailable" };
    }
    const result = await getLatestMigration({
      baseUrl: parsed.href.replace(/\/+$/u, ""),
      cache: "no-store",
      parseAs: "json",
      signal: AbortSignal.timeout(2000),
    });
    if (result.response?.status === 404) {
      return { kind: "empty" };
    }
    return result.response?.status === 200 && isReadableReport(result.data)
      ? { kind: "available", report: result.data }
      : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
};
