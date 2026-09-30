use crate::{
    client::connect,
    ledger::LedgerActivities,
    protocol::{ProbeConfig, ProbeError},
    workflow::CapacityWorkflow,
};
use std::time::Duration;
use temporalio_sdk::{
    Runtime, Worker, WorkerOptions,
    runtime::{
        PollerBehavior,
        worker_tuner::{FixedSizeSlotSupplier, TunerHolder},
    },
};

pub async fn create_worker(config: &ProbeConfig) -> Result<(Runtime, Worker), ProbeError> {
    let run_id =
        config
            .namespace
            .strip_prefix("reltide-capacity-")
            .ok_or(ProbeError::Validation(
                "worker namespace outside capacity scope",
            ))?;
    config.validate_for(run_id)?;
    let activities = LedgerActivities::connect(&config.application_database_url).await?;
    let runtime =
        Runtime::from_current_tokio(Default::default()).map_err(|_| ProbeError::Temporal)?;
    let client = connect(config).await?;
    let tuner = TunerHolder::builder()
        .workflow_task_slot_supplier(FixedSizeSlotSupplier::new(1))
        .activity_task_slot_supplier(FixedSizeSlotSupplier::new(1))
        .local_activity_task_slot_supplier(FixedSizeSlotSupplier::new(1))
        .nexus_task_slot_supplier(FixedSizeSlotSupplier::new(1))
        .build();
    let options = WorkerOptions::new(config.task_queue.clone())
        .max_cached_workflows(1)
        .tuner(tuner)
        .workflow_task_poller_behavior(PollerBehavior::SimpleMaximum(2))
        .nonsticky_to_sticky_poll_ratio(0.5)
        .activity_task_poller_behavior(PollerBehavior::SimpleMaximum(1))
        .nexus_task_poller_behavior(PollerBehavior::SimpleMaximum(1))
        .max_eager_activity_reservations_per_workflow_task(0)
        .graceful_shutdown_period(Duration::from_secs(6))
        .register_workflow::<CapacityWorkflow>()
        .map_err(|_| ProbeError::Temporal)?
        .register_activities(activities)
        .build();
    let worker = Worker::new(&runtime, client, options).map_err(|_| ProbeError::Temporal)?;
    Ok((runtime, worker))
}

pub async fn run_worker(config: &ProbeConfig) -> Result<(), ProbeError> {
    let (_runtime, mut worker) = create_worker(config).await?;
    let shutdown = worker.shutdown_handle();
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate()).map_err(|_| ProbeError::Io)?;
    let running = worker.run();
    tokio::pin!(running);
    tokio::select! {
        result = &mut running => return result.map_err(|_| ProbeError::Temporal),
        result = tokio::signal::ctrl_c() => { result.map_err(|_| ProbeError::Io)?; },
        _ = terminate.recv() => {}
    }
    shutdown();
    running.await.map_err(|_| ProbeError::Temporal)
}
