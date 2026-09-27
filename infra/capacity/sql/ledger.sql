-- The application PostgreSQL instance must start with track_commit_timestamp=on.
-- This synthetic schema has no ClickHouse dependency.
CREATE SCHEMA IF NOT EXISTS capacity;
CREATE TABLE IF NOT EXISTS capacity.ledger (
    run_id text NOT NULL CHECK (run_id ~ '^[a-z0-9-]{1,64}$'),
    sequence bigint NOT NULL CHECK (sequence >= 0),
    payload text NOT NULL CHECK (octet_length(payload) <= 1024),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    PRIMARY KEY (run_id, sequence)
);
