CREATE DATABASE IF NOT EXISTS capacity_analytics;
-- Per schema-pk-prioritize-filters/cardinality-order and minimal typed fixture rules.
CREATE TABLE IF NOT EXISTS capacity_analytics.ledger_sample
(
  run_id LowCardinality(String),
  sequence UInt16
)
ENGINE = MergeTree
ORDER BY (run_id, sequence);
CREATE DATABASE IF NOT EXISTS otel;
