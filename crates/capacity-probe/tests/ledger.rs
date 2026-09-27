use reltide_capacity_probe::{ledger::LedgerActivities, protocol::ProbeInput};
use temporalio_sdk::testing::ActivityEnvironment;

fn input(run_id: &str) -> ProbeInput {
    ProbeInput {
        run_id: run_id.into(),
        sequence: 1,
        payload: "synthetic".into(),
        hold_seconds: 0,
    }
}

async fn activities() -> LedgerActivities {
    let url =
        std::env::var("CAPACITY_TEST_DATABASE_URL").expect("local Task 2 database URL required");
    let activities = LedgerActivities::connect(&url).await.unwrap();
    activities.install_schema().await.unwrap();
    activities
}

#[tokio::test]
#[ignore = "requires Task 2 local PostgreSQL with track_commit_timestamp=on"]
async fn committed_retry_keeps_one_effect() {
    let activities = activities().await;
    let run_id = format!("retry-{}", std::process::id());
    let env = ActivityEnvironment::builder_with_default()
        .register_activities(activities.clone())
        .build();
    let first = env
        .run(LedgerActivities::record, input(&run_id))
        .await
        .unwrap();
    let (_, original_commit) = activities.verify(&input(&run_id)).await.unwrap();
    // Discarding the first acknowledgement models redelivery after a committed effect.
    let second = env
        .run(LedgerActivities::record, input(&run_id))
        .await
        .unwrap();
    assert_eq!(first, second);
    assert_eq!(activities.row_count(&run_id).await.unwrap(), 1);
    assert_eq!(
        activities.verify(&input(&run_id)).await.unwrap().1,
        original_commit
    );
}

#[tokio::test]
#[ignore = "requires Task 2 local PostgreSQL with track_commit_timestamp=on"]
async fn conflicting_retry_is_rejected() {
    let activities = activities().await;
    let run_id = format!("conflict-{}", std::process::id());
    let env = ActivityEnvironment::builder_with_default()
        .register_activities(activities.clone())
        .build();
    let first = env
        .run(LedgerActivities::record, input(&run_id))
        .await
        .unwrap();
    let mut conflicting = input(&run_id);
    conflicting.payload = "changed".into();
    assert!(
        env.run(LedgerActivities::record, conflicting)
            .await
            .is_err()
    );
    assert_eq!(activities.verify(&input(&run_id)).await.unwrap().0, first);
}

#[tokio::test]
#[ignore = "requires Task 2 local PostgreSQL with track_commit_timestamp=on"]
async fn seed_fixture_verifies_every_key_and_detects_missing_rows() {
    let activities = activities().await;
    let run_id = format!("seed-{}", std::process::id());
    let input = ProbeInput {
        run_id: run_id.clone(),
        sequence: 100_000,
        payload: "x".repeat(1024),
        hold_seconds: 0,
    };
    activities.seed(&input).await.unwrap();
    activities.verify_seed(&input).await.unwrap();
    let (client, connection) = tokio_postgres::connect(
        &std::env::var("CAPACITY_TEST_DATABASE_URL").unwrap(),
        tokio_postgres::NoTls,
    )
    .await
    .unwrap();
    let task = tokio::spawn(connection);
    client
        .execute(
            "DELETE FROM capacity.ledger WHERE run_id = $1 AND sequence = 50000",
            &[&run_id],
        )
        .await
        .unwrap();
    assert!(activities.verify_seed(&input).await.is_err());
    drop(client);
    task.await.unwrap().unwrap();
}
