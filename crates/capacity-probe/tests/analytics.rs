use reltide_capacity_probe::analytics::{AnalyticsConfig, probe_analytics};

fn config() -> AnalyticsConfig {
    AnalyticsConfig {
        application_database_url: std::env::var("CAPACITY_ANALYTICS_DATABASE_URL")
            .expect("scoped local analytics reader DSN required"),
    }
}
fn run_id() -> String {
    std::env::var("CAPACITY_ANALYTICS_RUN_ID").expect("fixture run required")
}
#[tokio::test]
#[ignore = "requires owned local capacity stack and reader DSN"]
async fn foreign_aggregate_matches_fixture() {
    let output = probe_analytics(&run_id(), &config()).await.unwrap();
    assert_eq!(
        (output.rows, output.min_sequence, output.max_sequence),
        (10000, 1, 10000)
    );
}
#[tokio::test]
#[ignore = "requires owned local capacity stack and reader DSN"]
async fn foreign_sample_preserves_types() {
    let output = probe_analytics(&run_id(), &config()).await.unwrap();
    assert_eq!(
        output
            .sample
            .iter()
            .map(|row| row.sequence)
            .collect::<Vec<_>>(),
        (1..=10).collect::<Vec<_>>()
    );
    assert!(output.sample.iter().all(|row| row.run_id == run_id()));
}
#[tokio::test]
#[ignore = "requires owned local capacity stack and reader DSN"]
async fn aggregate_and_filter_are_pushed_down() {
    let output = probe_analytics(&run_id(), &config()).await.unwrap();
    assert!(output.pushdown);
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("../../infra/capacity/images.lock.json").unwrap(),
    )
    .unwrap();
    let pin = &manifest["extension"];
    assert_eq!(
        output.library_version,
        pin["library_version"].as_str().unwrap()
    );
    assert_eq!(output.sql_version, pin["sql_version"].as_str().unwrap());
}
async fn denied(sql: &str) {
    let (client, connection) =
        tokio_postgres::connect(&config().application_database_url, tokio_postgres::NoTls)
            .await
            .unwrap();
    let task = tokio::spawn(connection);
    assert!(client.simple_query(sql).await.is_err());
    drop(client);
    task.await.unwrap().unwrap();
}
#[tokio::test]
#[ignore = "requires owned local capacity stack and reader DSN"]
async fn foreign_reader_cannot_write_or_read_telemetry() {
    denied("INSERT INTO capacity_ch.ledger_sample VALUES ('denied',1)").await;
    denied("SELECT * FROM otel.otel_logs LIMIT 1").await;
    denied("SELECT ch_extension.clickhouse_raw_query('SELECT 1')").await;
}
#[tokio::test]
#[ignore = "requires owned local capacity stack and reader DSN"]
async fn foreign_reader_cannot_raise_limits() {
    let (client, connection) =
        tokio_postgres::connect(&config().application_database_url, tokio_postgres::NoTls)
            .await
            .unwrap();
    let task = tokio::spawn(connection);
    client.batch_execute("SET pg_clickhouse.session_settings='join_use_nulls 1, group_by_use_nulls 1, final 1, transform_null_in 0, max_rows_to_read 20001'").await.unwrap();
    assert!(
        client
            .query(
                "SELECT count(*) FROM capacity_ch.ledger_sample WHERE run_id=$1 LIMIT 1",
                &[&run_id()]
            )
            .await
            .is_err()
    );
    drop(client);
    task.await.unwrap().unwrap();
}
#[test]
fn analytics_config_debug_redacts_secrets() {
    let value = AnalyticsConfig {
        application_database_url: "postgresql://reader:secret@localhost/capacity".into(),
    };
    assert!(!format!("{value:?}").contains("secret"));
}

#[tokio::test]
#[ignore = "requires owned local capacity stack and reader DSN"]
async fn mapping_secrets_are_redacted() {
    let config = config();
    let pg: tokio_postgres::Config = config.application_database_url.parse().unwrap();
    let secret = std::str::from_utf8(pg.get_password().unwrap()).unwrap();
    let output = probe_analytics(&run_id(), &config).await.unwrap();
    assert!(!serde_json::to_string(&output).unwrap().contains(secret));
    assert!(!format!("{config:?}").contains(secret));
    denied("IMPORT FOREIGN SCHEMA otel FROM SERVER capacity_ch_server INTO capacity_ch").await;
}
