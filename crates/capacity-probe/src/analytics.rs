//! Bounded, reader-only PostgreSQL probes of the explicit ClickHouse fixture.
use crate::protocol::{ProbeError, validate_run_id};
use serde::Serialize;
use serde_json::Value;
use std::{
    fmt,
    future::Future,
    time::{Duration, Instant},
};
use tokio::{task::JoinHandle, time::timeout};
use tokio_postgres::{
    Client, NoTls, Row,
    types::{FromSql, Type},
};

const AGGREGATE: &str = "SELECT count(*), min(sequence), max(sequence) FROM capacity_ch.ledger_sample WHERE run_id = $1 AND sequence BETWEEN 1 AND 10000 LIMIT 1";
const SEMANTICS: &str = "join_use_nulls 1, group_by_use_nulls 1, final 1, transform_null_in 0";

pub struct AnalyticsConfig {
    pub application_database_url: String,
}
impl fmt::Debug for AnalyticsConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AnalyticsConfig")
            .field("application_database_url", &"[REDACTED]")
            .finish()
    }
}
#[derive(Debug, Serialize)]
pub struct AnalyticsSample {
    pub run_id: String,
    pub sequence: u32,
}
#[derive(Debug, Serialize)]
pub struct AnalyticsProbeOutput {
    pub run_id: String,
    pub rows: u64,
    pub min_sequence: u32,
    pub max_sequence: u32,
    pub elapsed_ms: u64,
    pub pushdown: bool,
    pub library_version: String,
    pub sql_version: String,
    pub sample: Vec<AnalyticsSample>,
    pub explain: Value,
    pub backend_pid: i32,
}
#[derive(Debug, Serialize)]
pub struct CancellationEvidence {
    pub backend_pid: i32,
    pub cancelled: bool,
    pub backend_gone: bool,
}
struct JsonPlan(Value);
impl<'a> FromSql<'a> for JsonPlan {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(Self(serde_json::from_slice(raw)?))
    }
    fn accepts(ty: &Type) -> bool {
        *ty == Type::JSON
    }
}
struct Reader {
    client: Client,
    task: JoinHandle<Result<(), tokio_postgres::Error>>,
    pid: i32,
}
impl Reader {
    async fn connect(config: &AnalyticsConfig) -> Result<Self, ProbeError> {
        let mut pg: tokio_postgres::Config = config
            .application_database_url
            .parse()
            .map_err(|_| ProbeError::Validation("invalid analytics DSN"))?;
        if pg.get_user() != Some("capacity_analytics_reader") {
            return Err(ProbeError::Validation(
                "analytics requires restricted reader",
            ));
        }
        pg.connect_timeout(Duration::from_secs(3));
        let (client, connection) = timeout(Duration::from_secs(3), pg.connect(NoTls))
            .await
            .map_err(|_| ProbeError::Database)?
            .map_err(|_| ProbeError::Database)?;
        let task = tokio::spawn(connection);
        let row=client.query_one("SELECT pg_backend_pid(),session_user::text,current_user::text,current_setting('statement_timeout'),current_setting('pg_clickhouse.session_settings')",&[]).await.map_err(|_| ProbeError::Database)?;
        let reader = Self {
            pid: row.get(0),
            client,
            task,
        };
        if row.get::<_, String>(1) != "capacity_analytics_reader"
            || row.get::<_, String>(2) != "capacity_analytics_reader"
            || row.get::<_, String>(3) != "5s"
            || row.get::<_, String>(4) != SEMANTICS
        {
            return Err(ProbeError::Validation("unsafe analytics reader settings"));
        }
        reader
            .client
            .batch_execute("SET statement_timeout='5s'")
            .await
            .map_err(|_| ProbeError::Database)?;
        Ok(reader)
    }
    async fn close(self) -> Result<(), ProbeError> {
        drop(self.client);
        timeout(Duration::from_secs(2), self.task)
            .await
            .map_err(|_| ProbeError::Database)?
            .map_err(|_| ProbeError::Database)?
            .map_err(|_| ProbeError::Database)
    }
    async fn cancel(&self) -> Result<(), ProbeError> {
        timeout(
            Duration::from_secs(2),
            self.client.cancel_token().cancel_query(NoTls),
        )
        .await
        .map_err(|_| ProbeError::Database)?
        .map_err(|_| ProbeError::Database)
    }
}
fn has_pushdown(value: &Value, run_id: &str) -> bool {
    match value {
        Value::Object(map) => {
            if map.get("Node Type").and_then(Value::as_str) == Some("Aggregate") {
                return false;
            }
            if let Some(sql) = map.get("Remote SQL").and_then(Value::as_str) {
                let sql = sql.to_lowercase();
                let normalized: String = sql
                    .chars()
                    .filter(|character| {
                        !character.is_whitespace() && !['"', '(', ')'].contains(character)
                    })
                    .collect();
                let exact_bound = |fragment: &str| {
                    normalized.match_indices(fragment).any(|(offset, _)| {
                        normalized[offset + fragment.len()..]
                            .chars()
                            .next()
                            .is_none_or(|next| !next.is_ascii_digit() && next != '.')
                    })
                };
                let bounded = (exact_bound("sequence>=1") && exact_bound("sequence<=10000"))
                    || exact_bound("sequencebetween1and10000");
                return [
                    "count(", "min(", "max(", "where", "run_id", "sequence", "10000",
                ]
                .iter()
                .all(|fragment| sql.contains(fragment))
                    && (sql.contains(run_id) || sql.contains("$1"))
                    && bounded;
            }
            map.values().any(|child| has_pushdown(child, run_id))
        }
        Value::Array(values) => values.iter().any(|child| has_pushdown(child, run_id)),
        _ => false,
    }
}
async fn collect(
    reader: &Reader,
    run_id: &str,
    start: Instant,
) -> Result<AnalyticsProbeOutput, ProbeError> {
    let versions=reader.client.query_one("SELECT ch_extension.pgch_version(), extversion::text FROM pg_extension WHERE extname='pg_clickhouse'",&[]).await.map_err(query_error)?;
    let library_version: String = versions.get(0);
    let sql_version: String = versions.get(1);
    let pin: Value = serde_json::from_str(include_str!("../../../infra/capacity/images.lock.json"))
        .map_err(|_| ProbeError::Validation("invalid extension pin"))?;
    if pin["extension"]["library_version"].as_str() != Some(&library_version)
        || pin["extension"]["sql_version"].as_str() != Some(&sql_version)
    {
        return Err(ProbeError::Validation("extension pin mismatch"));
    }
    let plan = reader
        .client
        .query_one(
            &format!("EXPLAIN (VERBOSE, FORMAT JSON) {AGGREGATE}"),
            &[&run_id],
        )
        .await
        .map_err(query_error)?
        .try_get::<_, JsonPlan>(0)
        .map_err(|_| ProbeError::Database)?
        .0;
    if !has_pushdown(&plan, run_id) {
        return Err(ProbeError::Validation(
            "aggregate and predicates are not pushed down",
        ));
    }
    let row: Row = reader
        .client
        .query_one(AGGREGATE, &[&run_id])
        .await
        .map_err(query_error)?;
    let rows = u64::try_from(row.get::<_, i64>(0)).map_err(|_| ProbeError::Database)?;
    let min_sequence = u32::try_from(row.get::<_, i32>(1)).map_err(|_| ProbeError::Database)?;
    let max_sequence = u32::try_from(row.get::<_, i32>(2)).map_err(|_| ProbeError::Database)?;
    if (rows, min_sequence, max_sequence) != (10000, 1, 10000) {
        return Err(ProbeError::Validation("analytics fixture mismatch"));
    }
    let sample=reader.client.query("SELECT run_id,sequence FROM capacity_ch.ledger_sample WHERE run_id=$1 AND sequence BETWEEN 1 AND 10 ORDER BY sequence LIMIT 10",&[&run_id]).await.map_err(query_error)?.iter().map(|row|Ok(AnalyticsSample {run_id:row.try_get(0).map_err(|_|ProbeError::Database)?,sequence:u32::try_from(row.try_get::<_,i32>(1).map_err(|_|ProbeError::Database)?).map_err(|_|ProbeError::Database)?})).collect::<Result<Vec<_>,ProbeError>>()?;
    if sample.len() != 10
        || sample
            .iter()
            .enumerate()
            .any(|(index, row)| row.run_id != run_id || row.sequence != index as u32 + 1)
    {
        return Err(ProbeError::Validation("analytics sample mismatch"));
    }
    Ok(AnalyticsProbeOutput {
        run_id: run_id.to_owned(),
        rows,
        min_sequence,
        max_sequence,
        elapsed_ms: start.elapsed().as_millis() as u64,
        pushdown: true,
        library_version,
        sql_version,
        sample,
        explain: plan,
        backend_pid: reader.pid,
    })
}
pub async fn probe_analytics(
    run_id: &str,
    config: &AnalyticsConfig,
) -> Result<AnalyticsProbeOutput, ProbeError> {
    probe_analytics_cancellable(run_id, config, std::future::pending()).await
}
async fn controlled<T>(
    operation: impl Future<Output = Result<T, ProbeError>>,
    stop: impl Future<Output = ()>,
    budget: Duration,
    cancel: impl Future<Output = Result<(), ProbeError>>,
) -> Result<Option<T>, ProbeError> {
    tokio::pin!(operation);
    tokio::select! {
        result=&mut operation=>result.map(Some),
        ()=stop=>{
            cancel.await?;
            // Sending a CancelRequest is not acknowledgement; drain the query before closing.
            match timeout(Duration::from_secs(6), &mut operation).await.map_err(|_| ProbeError::Database)? {
                Err(ProbeError::QueryCancelled) => Ok(None),
                Ok(_) => Err(ProbeError::Validation("analytics cancellation unacknowledged")),
                Err(error) => Err(error),
            }
        },
        ()=tokio::time::sleep(budget)=>{
            cancel.await?;
            match timeout(Duration::from_secs(6), &mut operation).await.map_err(|_| ProbeError::Database)? {
                Ok(_) | Err(ProbeError::QueryCancelled) => {},
                Err(error) => return Err(error),
            }
            Err(ProbeError::Validation("analytics deadline exceeded"))
        }
    }
}
fn classify_query_failure(
    code: Option<&tokio_postgres::error::SqlState>,
    message: Option<&str>,
) -> ProbeError {
    // QUERY_CANCELED also covers statement_timeout. Only the server's explicit
    // user-request reason witnesses our CancelRequest; unknown/localized reasons fail closed.
    if code == Some(&tokio_postgres::error::SqlState::QUERY_CANCELED)
        && message == Some("canceling statement due to user request")
    {
        ProbeError::QueryCancelled
    } else {
        ProbeError::Database
    }
}
fn query_error(error: tokio_postgres::Error) -> ProbeError {
    classify_query_failure(
        error.code(),
        error
            .as_db_error()
            .map(tokio_postgres::error::DbError::message),
    )
}
async fn after_cleanup<T, U>(
    result: Result<T, ProbeError>,
    cleanup: impl Future<Output = Result<U, ProbeError>>,
) -> Result<(T, U), ProbeError> {
    let evidence = cleanup.await?;
    Ok((result?, evidence))
}
async fn finish_reader(
    reader: Reader,
    config: &AnalyticsConfig,
) -> Result<CancellationEvidence, ProbeError> {
    let pid = reader.pid;
    let identity = reader
        .client
        .query_one("SELECT pg_backend_pid(),session_user::text", &[])
        .await
        .map_err(|_| ProbeError::Database)?;
    if identity.get::<_, i32>(0) != pid
        || identity.get::<_, String>(1) != "capacity_analytics_reader"
    {
        return Err(ProbeError::Validation("reader backend identity changed"));
    }
    reader.close().await?;
    let observer = Reader::connect(config).await?;
    let gone = observer
        .client
        .query_one(
            "SELECT count(*) FROM pg_stat_activity WHERE pid=$1",
            &[&pid],
        )
        .await
        .map_err(|_| ProbeError::Database)?
        .get::<_, i64>(0)
        == 0;
    observer.close().await?;
    if !gone {
        return Err(ProbeError::Validation("reader backend remains after close"));
    }
    Ok(CancellationEvidence {
        backend_pid: pid,
        cancelled: false,
        backend_gone: true,
    })
}
pub async fn probe_analytics_cancellable(
    run_id: &str,
    config: &AnalyticsConfig,
    stop: impl Future<Output = ()>,
) -> Result<AnalyticsProbeOutput, ProbeError> {
    validate_run_id(run_id)?;
    let start = Instant::now();
    let reader = Reader::connect(config).await?;
    let result = controlled(
        collect(&reader, run_id, start),
        stop,
        Duration::from_secs(10).saturating_sub(start.elapsed()),
        reader.cancel(),
    )
    .await;
    let (result, _) = after_cleanup(result, finish_reader(reader, config)).await?;
    let mut output = result.ok_or(ProbeError::Validation(
        "analytics cancelled after verified backend cleanup",
    ))?;
    output.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(output)
}
/// Execute one parameterized query with the same restricted connection and cancellation lifecycle.
/// Integration tests use this path with their own disposable foreign table; no slow mode exists in the CLI.
#[cfg(test)]
async fn query_analytics_cancellable(
    query: &str,
    run_id: &str,
    config: &AnalyticsConfig,
    stop: impl Future<Output = ()>,
) -> Result<CancellationEvidence, ProbeError> {
    validate_run_id(run_id)?;
    let start = Instant::now();
    let reader = Reader::connect(config).await?;
    let result = controlled(
        async {
            reader
                .client
                .query(query, &[&run_id])
                .await
                .map_err(query_error)
        },
        stop,
        Duration::from_secs(10).saturating_sub(start.elapsed()),
        reader.cancel(),
    )
    .await;
    let (result, mut evidence) = after_cleanup(result, finish_reader(reader, config)).await?;
    evidence.cancelled = result.is_none();
    Ok(evidence)
}

#[cfg(test)]
mod live_tests {
    use super::*;
    fn config() -> AnalyticsConfig {
        AnalyticsConfig {
            application_database_url: std::env::var("CAPACITY_ANALYTICS_DATABASE_URL")
                .expect("scoped local reader required"),
        }
    }
    fn run_id() -> String {
        std::env::var("CAPACITY_ANALYTICS_RUN_ID").expect("fixture run required")
    }
    #[tokio::test]
    #[ignore = "requires owned local capacity stack and reader DSN"]
    async fn cancellation_verifies_reader_backend_cleanup() {
        let config = config();
        let evidence = query_analytics_cancellable(
            "SELECT pg_sleep(30) WHERE $1::text <> ''",
            &run_id(),
            &config,
            async { tokio::time::sleep(std::time::Duration::from_millis(100)).await },
        )
        .await
        .unwrap();
        assert!(evidence.cancelled && evidence.backend_gone);
        assert!(evidence.backend_pid > 0);
    }
    #[tokio::test]
    #[ignore = "requires owned local capacity stack and reader DSN"]
    async fn deadline_verifies_reader_backend_cleanup() {
        let config = config();
        let reader = Reader::connect(&config).await.unwrap();
        let result = controlled(
            async {
                reader
                    .client
                    .query("SELECT pg_sleep(30)", &[])
                    .await
                    .map_err(query_error)
            },
            std::future::pending(),
            Duration::from_millis(100),
            reader.cancel(),
        )
        .await;
        let evidence = finish_reader(reader, &config).await.unwrap();
        assert!(evidence.backend_gone && evidence.backend_pid > 0);
        assert!(matches!(
            result,
            Err(ProbeError::Validation("analytics deadline exceeded"))
        ));
    }
    #[tokio::test]
    #[ignore = "requires owned local capacity stack and reader DSN"]
    async fn normal_completion_does_not_claim_cancellation() {
        let evidence = query_analytics_cancellable(
            "SELECT $1::text",
            &run_id(),
            &config(),
            std::future::pending(),
        )
        .await
        .unwrap();
        assert!(!evidence.cancelled && evidence.backend_gone);
    }
    #[tokio::test]
    #[ignore = "requires owned local capacity stack and reader DSN"]
    async fn statement_timeout_is_failure_after_reader_cleanup() {
        let config = config();
        let reader = Reader::connect(&config).await.unwrap();
        let result = controlled(
            async {
                reader
                    .client
                    .query("SELECT pg_sleep(30)", &[])
                    .await
                    .map_err(query_error)
            },
            std::future::pending(),
            Duration::from_secs(10),
            reader.cancel(),
        )
        .await;
        let evidence = finish_reader(reader, &config).await.unwrap();
        assert!(evidence.backend_gone);
        assert!(matches!(result, Err(ProbeError::Database)));
    }
    #[tokio::test]
    #[ignore = "requires owned local slow fixture plus external remote observation gate"]
    async fn remote_cancellation_waits_for_reader_cleanup() {
        let table =
            std::env::var("CAPACITY_ANALYTICS_SLOW_TABLE").expect("owned slow fixture required");
        assert!(
            table
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        );
        let gate = std::env::var("CAPACITY_ANALYTICS_CANCEL_GATE")
            .expect("remote observation gate required");
        let output =
            std::env::var("CAPACITY_ANALYTICS_CANCEL_EVIDENCE").expect("evidence file required");
        let sql = format!(
            "SELECT count(*), min(sequence), max(sequence) FROM capacity_ch.{table} WHERE run_id=$1 AND sequence BETWEEN 1 AND 10000 LIMIT 1"
        );
        let cancelled = async {
            let start = std::time::Instant::now();
            loop {
                if std::path::Path::new(&gate).exists() {
                    break;
                }
                assert!(
                    start.elapsed() < std::time::Duration::from_secs(4),
                    "remote query was never positively observed"
                );
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        };
        let evidence = query_analytics_cancellable(&sql, &run_id(), &config(), cancelled)
            .await
            .unwrap();
        assert!(evidence.cancelled && evidence.backend_gone);
        std::fs::write(output, serde_json::to_string(&evidence).unwrap()).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    #[tokio::test]
    async fn requested_cancellation_requires_query_acknowledgement() {
        let (sent, receive) = tokio::sync::oneshot::channel();
        let result = controlled(
            async {
                receive.await.unwrap();
                Err::<(), _>(ProbeError::QueryCancelled)
            },
            async {},
            Duration::from_secs(1),
            async {
                sent.send(()).unwrap();
                Ok(())
            },
        )
        .await;
        assert!(matches!(result, Ok(None)), "{result:?}");
    }

    #[tokio::test]
    async fn completed_query_after_cancel_dispatch_is_not_acknowledgement() {
        let (sent, receive) = tokio::sync::oneshot::channel();
        let result = controlled(
            async {
                receive.await.unwrap();
                Ok(())
            },
            async {},
            Duration::from_secs(1),
            async {
                sent.send(()).unwrap();
                Ok(())
            },
        )
        .await;
        assert!(
            matches!(
                result,
                Err(ProbeError::Validation(
                    "analytics cancellation unacknowledged"
                ))
            ),
            "{result:?}"
        );
    }

    #[tokio::test]
    async fn unrelated_query_error_after_cancel_dispatch_is_preserved() {
        let (sent, receive) = tokio::sync::oneshot::channel();
        let result = controlled(
            async {
                receive.await.unwrap();
                Err::<(), _>(ProbeError::Database)
            },
            async {},
            Duration::from_secs(1),
            async {
                sent.send(()).unwrap();
                Ok(())
            },
        )
        .await;
        assert!(matches!(result, Err(ProbeError::Database)), "{result:?}");
    }

    #[test]
    fn statement_timeout_is_not_requested_cancellation() {
        assert!(matches!(
            classify_query_failure(
                Some(&tokio_postgres::error::SqlState::QUERY_CANCELED),
                Some("canceling statement due to statement timeout")
            ),
            ProbeError::Database
        ));
    }

    #[test]
    fn server_user_cancellation_retains_typed_outcome() {
        assert!(matches!(
            classify_query_failure(
                Some(&tokio_postgres::error::SqlState::QUERY_CANCELED),
                Some("canceling statement due to user request")
            ),
            ProbeError::QueryCancelled
        ));
    }

    #[test]
    fn unrelated_sqlstate_with_cancellation_message_is_not_acknowledgement() {
        assert!(matches!(
            classify_query_failure(
                Some(&tokio_postgres::error::SqlState::INTERNAL_ERROR),
                Some("canceling statement due to user request")
            ),
            ProbeError::Database
        ));
    }

    #[tokio::test]
    async fn rejected_cancellation_still_waits_for_cleanup() {
        let closed = Arc::new(AtomicBool::new(false));
        let cleaned = closed.clone();
        let result = after_cleanup::<(), ()>(Err(ProbeError::Database), async move {
            tokio::task::yield_now().await;
            cleaned.store(true, Ordering::SeqCst);
            Ok(())
        })
        .await;
        assert!(closed.load(Ordering::SeqCst));
        assert!(matches!(result, Err(ProbeError::Database)));
    }

    #[tokio::test]
    async fn cleanup_failure_overrides_acknowledged_cancellation() {
        let result = after_cleanup(Ok::<_, ProbeError>(None::<()>), async {
            Err::<(), _>(ProbeError::Validation("backend remains"))
        })
        .await;
        assert!(matches!(
            result,
            Err(ProbeError::Validation("backend remains"))
        ));
    }
    #[test]
    fn pushdown_rejects_missing_lower_sequence_bound() {
        let plan = serde_json::json!([{"Plan":{"Node Type":"Foreign Scan","Remote SQL":"SELECT count(*),min(sequence),max(sequence) FROM ledger_sample WHERE run_id='test' AND sequence<=10000"}}]);
        assert!(!has_pushdown(&plan, "test"));
    }
    #[test]
    fn pushdown_requires_exact_numeric_bounds() {
        for (lower, upper) in [(100, 10000), (1, 100000)] {
            let plan = serde_json::json!([{"Plan":{"Node Type":"Foreign Scan","Remote SQL":format!("SELECT count(*),min(sequence),max(sequence) FROM ledger_sample WHERE run_id='test' AND sequence>={lower} AND sequence<={upper}")}}]);
            assert!(!has_pushdown(&plan, "test"));
        }
    }
    #[test]
    fn local_aggregate_is_not_pushdown() {
        let plan = serde_json::json!([{"Plan":{"Node Type":"Aggregate","Plans":[{"Node Type":"Foreign Scan","Remote SQL":"SELECT count(*),min(sequence),max(sequence) FROM ledger_sample WHERE run_id='test' AND sequence>=1 AND sequence<=10000"}]}}]);
        assert!(!has_pushdown(&plan, "test"));
    }
}
