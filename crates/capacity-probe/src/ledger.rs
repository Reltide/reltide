use crate::protocol::{ProbeError, ProbeEvent, ProbeInput, ProbeOutput, validate};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use temporalio_macros::activities;
use temporalio_sdk::{
    ApplicationFailure,
    activities::{ActivityContext, ActivityError},
};
use tokio_postgres::NoTls;

pub fn checksum(payload: &str) -> String {
    checksum_bytes(payload.as_bytes())
}

pub fn checksum_bytes(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        const DIGITS: &[u8; 16] = b"0123456789abcdef";
        hex.push(DIGITS[(byte >> 4) as usize] as char);
        hex.push(DIGITS[(byte & 15) as usize] as char);
    }
    hex
}

pub fn validate_seed(input: &ProbeInput) -> Result<(), ProbeError> {
    validate(input)?;
    if input.sequence != 100_000 || input.payload.len() != 1024 || input.hold_seconds != 0 {
        return Err(ProbeError::Validation(
            "seed requires sequence=100000, 1024 payload bytes and hold_seconds=0",
        ));
    }
    Ok(())
}

#[derive(Clone)]
pub struct LedgerActivities {
    pool: Pool,
}

impl LedgerActivities {
    /// One connection per process leaves room for the operator and analytics reader.
    pub async fn connect(url: &str) -> Result<Self, ProbeError> {
        let mut config: tokio_postgres::Config = url.parse().map_err(|_| ProbeError::Database)?;
        config.connect_timeout(Duration::from_secs(3));
        config.options("-c statement_timeout=4000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=4000");
        let manager = Manager::from_config(
            config,
            NoTls,
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        let pool = Pool::builder(manager)
            .max_size(1)
            .runtime(deadpool_postgres::Runtime::Tokio1)
            .wait_timeout(Some(Duration::from_secs(1)))
            .create_timeout(Some(Duration::from_secs(3)))
            .build()
            .map_err(|_| ProbeError::Database)?;
        let activities = Self { pool };
        let client = activities
            .pool
            .get()
            .await
            .map_err(|_| ProbeError::Database)?;
        let enabled: String = client
            .query_one("SHOW track_commit_timestamp", &[])
            .await
            .map_err(|_| ProbeError::Database)?
            .get(0);
        if enabled != "on" {
            return Err(ProbeError::Validation(
                "PostgreSQL track_commit_timestamp must be on",
            ));
        }
        drop(client);
        Ok(activities)
    }

    /// Explicit setup command; the runtime activity never creates schemas.
    pub async fn install_schema(&self) -> Result<(), ProbeError> {
        self.pool
            .get()
            .await
            .map_err(|_| ProbeError::Database)?
            .batch_execute(include_str!("../../../infra/capacity/sql/ledger.sql"))
            .await
            .map_err(|_| ProbeError::Database)
    }

    pub async fn row_count(&self, run_id: &str) -> Result<i64, ProbeError> {
        crate::protocol::validate_run_id(run_id)?;
        let row = self
            .pool
            .get()
            .await
            .map_err(|_| ProbeError::Database)?
            .query_one(
                "SELECT count(*) FROM capacity.ledger WHERE run_id = $1",
                &[&run_id],
            )
            .await
            .map_err(|_| ProbeError::Database)?;
        Ok(row.get(0))
    }

    pub async fn verify(&self, input: &ProbeInput) -> Result<(ProbeOutput, String), ProbeError> {
        validate(input)?;
        let sequence = input.sequence as i64;
        let row = self.pool.get().await.map_err(|_| ProbeError::Database)?.query_opt("SELECT sha256, payload, to_char(pg_xact_commit_timestamp(xmin) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') FROM capacity.ledger WHERE run_id = $1 AND sequence = $2", &[&input.run_id, &sequence]).await.map_err(|_| ProbeError::Database)?.ok_or(ProbeError::Validation("ledger key missing"))?;
        let stored: String = row.get(0);
        let payload: String = row.get(1);
        if stored != checksum(&input.payload) || payload != input.payload {
            return Err(ProbeError::Validation("ledger checksum conflict"));
        }
        let commit_time: Option<String> = row.get(2);
        Ok((
            ProbeOutput {
                run_id: input.run_id.clone(),
                sequence: input.sequence,
                sha256: stored,
            },
            commit_time.ok_or(ProbeError::Validation("commit timestamp unavailable"))?,
        ))
    }

    pub async fn commit(&self, input: &ProbeInput) -> Result<(ProbeOutput, String), ProbeError> {
        validate(input)?;
        let sequence = input.sequence as i64;
        let sha256 = checksum(&input.payload);
        {
            let mut client = self.pool.get().await.map_err(|_| ProbeError::Database)?;
            let transaction = client
                .transaction()
                .await
                .map_err(|_| ProbeError::Database)?;
            transaction.execute("INSERT INTO capacity.ledger (run_id, sequence, payload, sha256) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", &[&input.run_id, &sequence, &input.payload, &sha256]).await.map_err(|_| ProbeError::Database)?;
            let row = transaction.query_one("SELECT sha256, payload FROM capacity.ledger WHERE run_id = $1 AND sequence = $2", &[&input.run_id, &sequence]).await.map_err(|_| ProbeError::Database)?;
            if row.get::<_, String>(0) != sha256 || row.get::<_, String>(1) != input.payload {
                return Err(ProbeError::Validation("ledger checksum conflict"));
            }
            transaction
                .commit()
                .await
                .map_err(|_| ProbeError::Database)?;
        }
        // Read after COMMIT in a fresh statement. xmin identifies the original
        // effect even on redelivery, so an acknowledgement loss cannot move its watermark.
        self.verify(input).await
    }

    /// Verify all fixture keys and payload/checksum pairs before certifying its last watermark.
    pub async fn verify_seed(
        &self,
        input: &ProbeInput,
    ) -> Result<(ProbeOutput, String), ProbeError> {
        validate_seed(input)?;
        let sha256 = checksum(&input.payload);
        let row = self.pool.get().await.map_err(|_| ProbeError::Database)?.query_one("SELECT count(*), count(*) FILTER (WHERE payload <> $2 OR sha256 <> $3) FROM capacity.ledger WHERE run_id = $1 AND sequence BETWEEN 1 AND 100000", &[&input.run_id, &input.payload, &sha256]).await.map_err(|_| ProbeError::Database)?;
        if row.get::<_, i64>(0) != 100_000 || row.get::<_, i64>(1) != 0 {
            return Err(ProbeError::Validation(
                "seed fixture is incomplete or has checksum conflicts",
            ));
        }
        self.verify(input).await
    }

    /// Seed the approved 100,000-row fixture in transactions of at most 256 rows.
    pub async fn seed(&self, input: &ProbeInput) -> Result<(ProbeOutput, String), ProbeError> {
        validate_seed(input)?;
        let sha256 = checksum(&input.payload);
        for first in (1_i64..=100_000).step_by(256) {
            let last = (first + 255).min(100_000);
            let mut client = self.pool.get().await.map_err(|_| ProbeError::Database)?;
            let transaction = client
                .transaction()
                .await
                .map_err(|_| ProbeError::Database)?;
            transaction.execute("INSERT INTO capacity.ledger (run_id, sequence, payload, sha256) SELECT $1, sequence, $4, $5 FROM generate_series($2::bigint, $3::bigint) AS sequence ON CONFLICT DO NOTHING", &[&input.run_id, &first, &last, &input.payload, &sha256]).await.map_err(|_| ProbeError::Database)?;
            let conflicts: i64 = transaction.query_one("SELECT count(*) FROM capacity.ledger WHERE run_id = $1 AND sequence BETWEEN $2 AND $3 AND (payload <> $4 OR sha256 <> $5)", &[&input.run_id, &first, &last, &input.payload, &sha256]).await.map_err(|_| ProbeError::Database)?.get(0);
            if conflicts != 0 {
                return Err(ProbeError::Validation("seed ledger conflict"));
            }
            transaction
                .commit()
                .await
                .map_err(|_| ProbeError::Database)?;
        }
        self.verify_seed(input).await
    }
}

#[activities]
impl LedgerActivities {
    #[activity]
    pub async fn record(
        self: Arc<Self>,
        _ctx: ActivityContext,
        input: ProbeInput,
    ) -> Result<ProbeOutput, ActivityError> {
        let result = tokio::time::timeout(Duration::from_millis(4500), self.commit(&input))
            .await
            .map_err(|_| ActivityError::from(ProbeError::Database))?;
        let (output, post_commit_time) = result.map_err(|error| match error {
            ProbeError::Validation(_) => {
                ActivityError::application(ApplicationFailure::non_retryable(error))
            }
            other => ActivityError::from(other),
        })?;
        ProbeEvent::Watermark {
            sequence: output.sequence,
            sha256: output.sha256.clone(),
            post_commit_time,
        }
        .emit(&output.run_id)?;
        Ok(output)
    }
}
