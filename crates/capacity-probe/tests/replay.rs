use reltide_capacity_probe::{
    client::{export_history, replay_history, start_options, start_probe},
    protocol::{ProbeConfig, ProbeInput},
    worker::create_worker,
};
use std::path::Path;

#[tokio::test]
#[ignore = "requires Task 2 local Temporal namespace, application PostgreSQL and restricted config file"]
async fn workflow_completes_and_history_replays() {
    let config =
        ProbeConfig::from_env_file(Path::new(&std::env::var("CAPACITY_TEST_ENV_FILE").unwrap()))
            .unwrap();
    let run_id = config.namespace.strip_prefix("reltide-capacity-").unwrap();
    let input = ProbeInput {
        run_id: run_id.into(),
        sequence: 900001,
        payload: "synthetic".into(),
        hold_seconds: 1,
    };
    let (runtime, mut worker) = create_worker(&config).await.unwrap();
    let shutdown = worker.shutdown_handle();
    let path = std::env::temp_dir().join(format!("capacity-history-{}.json", std::process::id()));
    let task = async {
        let output = start_probe(&input, &config).await.unwrap();
        assert_eq!(output.run_id, input.run_id);
        export_history(&input, &config, &path).await.unwrap();
        shutdown();
    };
    let (result, ()) = futures::join!(worker.run(), task);
    result.unwrap();
    drop(runtime);
    replay_history(&path).await.unwrap();
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn rejects_malformed_history_without_server() {
    let path =
        std::env::temp_dir().join(format!("bad-capacity-history-{}.json", std::process::id()));
    std::fs::write(&path, b"not a history").unwrap();
    assert!(replay_history(&path).await.is_err());
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn rejects_empty_history_without_server() {
    let path = std::env::temp_dir().join(format!(
        "empty-capacity-history-{}.json",
        std::process::id()
    ));
    std::fs::write(&path, br#"{"events":[]}"#).unwrap();
    assert!(replay_history(&path).await.is_err());
    std::fs::remove_file(path).unwrap();
}

fn options(hold_seconds: u32) -> temporalio_client::WorkflowStartOptions {
    let input = ProbeInput {
        run_id: "test-1".into(),
        sequence: 1,
        payload: "synthetic".into(),
        hold_seconds,
    };
    let config = ProbeConfig {
        temporal_address: "http://127.0.0.1:7233".into(),
        namespace: "reltide-capacity-test-1".into(),
        task_queue: "reltide-capacity-test-1".into(),
        application_database_url: "postgres://127.0.0.1/probe".into(),
    };
    start_options(&input, &config)
}

#[test]
fn ordinary_probe_keeps_twenty_second_execution_bound() {
    assert_eq!(
        options(0).execution_timeout,
        Some(std::time::Duration::from_secs(20))
    );
}

#[test]
fn labeled_recovery_allows_both_restore_windows_and_overhead() {
    for hold_seconds in [1, 60] {
        assert_eq!(
            options(hold_seconds).execution_timeout,
            Some(std::time::Duration::from_secs(4500))
        );
    }
}
