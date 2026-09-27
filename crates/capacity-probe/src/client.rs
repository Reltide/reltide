use crate::{
    ledger::{checksum, checksum_bytes},
    protocol::{ProbeConfig, ProbeError, ProbeEvent, ProbeInput, ProbeOutput, validate},
    workflow::CapacityWorkflow,
};
use futures::StreamExt;
use std::{path::Path, time::Duration};
use temporalio_client::WorkflowIdReusePolicy;
use temporalio_client::{
    Client, ClientOptions, Connection, ConnectionOptions, Url, WorkflowFetchHistoryOptions,
    WorkflowHistory, WorkflowStartOptions,
};
use temporalio_sdk::workflow_replayer::{WorkflowReplayer, WorkflowReplayerOptions};

pub async fn connect(config: &ProbeConfig) -> Result<Client, ProbeError> {
    let address: Url = config
        .temporal_address
        .parse()
        .map_err(|_| ProbeError::Temporal)?;
    let connection = tokio::time::timeout(
        Duration::from_secs(5),
        Connection::connect(
            ConnectionOptions::new(address)
                .connect_timeout(Duration::from_secs(3))
                .retry_options(
                    temporalio_client::RetryOptions::builder()
                        .max_retries(2)
                        .max_elapsed_time(Some(Duration::from_secs(5)))
                        .build(),
                )
                .build(),
        ),
    )
    .await
    .map_err(|_| ProbeError::Temporal)?
    .map_err(|_| ProbeError::Temporal)?;
    Client::new(
        connection,
        ClientOptions::new(config.namespace.clone()).build(),
    )
    .map_err(|_| ProbeError::Temporal)
}

pub fn workflow_id(input: &ProbeInput) -> String {
    format!("reltide-capacity-{}-{}", input.run_id, input.sequence)
}

pub fn start_options(input: &ProbeInput, config: &ProbeConfig) -> WorkflowStartOptions {
    // A labeled probe must survive two sequential 30-minute restore windows plus
    // coordinator/restart overhead (controller ruling R3). Its timer stays <=60s.
    let execution_seconds = if input.hold_seconds == 0 { 20 } else { 75 * 60 };
    WorkflowStartOptions::new(config.task_queue.clone(), workflow_id(input))
        .id_reuse_policy(WorkflowIdReusePolicy::RejectDuplicate)
        .execution_timeout(Duration::from_secs(execution_seconds))
        .build()
}

pub async fn start_probe(
    input: &ProbeInput,
    config: &ProbeConfig,
) -> Result<ProbeOutput, ProbeError> {
    validate(input)?;
    config.validate_for(&input.run_id)?;
    let client = connect(config).await?;
    let id = workflow_id(input);
    let handle = tokio::time::timeout(
        Duration::from_secs(10),
        client.start_workflow(
            CapacityWorkflow::run,
            input.clone(),
            start_options(input, config),
        ),
    )
    .await
    .map_err(|_| ProbeError::Temporal)?
    .map_err(|_| ProbeError::Temporal)?;
    ProbeEvent::Started {
        sequence: input.sequence,
        workflow_id: id,
        temporal_run_id: handle.info().run_id.clone().ok_or(ProbeError::Temporal)?,
    }
    .emit(&input.run_id)?;
    let output = tokio::time::timeout(
        Duration::from_secs(u64::from(input.hold_seconds) + 30),
        handle.get_result(Default::default()),
    )
    .await
    .map_err(|_| ProbeError::Temporal)?
    .map_err(|_| ProbeError::Temporal)?;
    if output.run_id != input.run_id
        || output.sequence != input.sequence
        || output.sha256 != checksum(&input.payload)
    {
        return Err(ProbeError::Validation(
            "workflow result differs from request",
        ));
    }
    ProbeEvent::Completed {
        sequence: output.sequence,
        sha256: output.sha256.clone(),
    }
    .emit(&input.run_id)?;
    Ok(output)
}

pub async fn export_history(
    input: &ProbeInput,
    config: &ProbeConfig,
    path: &Path,
) -> Result<(), ProbeError> {
    validate(input)?;
    config.validate_for(&input.run_id)?;
    let client = connect(config).await?;
    let id = workflow_id(input);
    let handle = client.get_workflow_handle::<CapacityWorkflow>(id.clone());
    let bytes = tokio::time::timeout(Duration::from_secs(10), async {
        let mut history = handle.fetch_history(WorkflowFetchHistoryOptions::default());
        let mut bytes = b"{\"events\":[".to_vec();
        let mut count = 0;
        while let Some(event) = history.next().await {
            let event = event.map_err(|_| ProbeError::Temporal)?;
            let encoded = serde_json::to_vec(&event).map_err(|_| ProbeError::Temporal)?;
            count += 1;
            if count > 256 || bytes.len() + encoded.len() + 3 > 2 * 1024 * 1024 {
                return Err(ProbeError::Validation(
                    "history exceeds 256 events or 2 MiB",
                ));
            }
            if count > 1 {
                bytes.push(b',');
            }
            bytes.extend_from_slice(&encoded);
        }
        if count == 0 {
            return Err(ProbeError::Validation("history is empty"));
        }
        bytes.extend_from_slice(b"]}");
        Ok(bytes)
    })
    .await
    .map_err(|_| ProbeError::Temporal)??;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(ProbeError::Validation("history exceeds 2 MiB"));
    }
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| ProbeError::Io)?;
    file.write_all(&bytes).map_err(|_| ProbeError::Io)?;
    file.sync_all().map_err(|_| ProbeError::Io)?;
    ProbeEvent::History {
        sequence: input.sequence,
        workflow_id: id,
        path: path.to_string_lossy().into_owned(),
        sha256: checksum_bytes(&bytes),
    }
    .emit(&input.run_id)
}

pub async fn replay_history(path: &Path) -> Result<(), ProbeError> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|_| ProbeError::Io)?
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ProbeError::Io)?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(ProbeError::Validation("history exceeds 2 MiB"));
    }
    let history = WorkflowHistory::from_json(&bytes)
        .map_err(|_| ProbeError::Validation("invalid workflow history"))?;
    let events = history
        .into_events()
        .await
        .map_err(|_| ProbeError::Temporal)?;
    if events.is_empty()
        || events.len() > 256
        || events
            .iter()
            .enumerate()
            .any(|(index, event)| event.event_id != index as i64 + 1)
    {
        return Err(ProbeError::Validation(
            "history is empty, truncated or exceeds 256 events",
        ));
    }
    let history = temporalio_common::protos::temporal::api::history::v1::History { events }.into();
    let replayer = WorkflowReplayer::new(
        WorkflowReplayerOptions::new()
            .register_workflow::<CapacityWorkflow>()
            .map_err(|_| ProbeError::Temporal)?
            .build(),
    )
    .map_err(|_| ProbeError::Temporal)?;
    tokio::time::timeout(Duration::from_secs(10), replayer.replay_workflow(history))
        .await
        .map_err(|_| ProbeError::Temporal)?
        .map_err(|_| ProbeError::Temporal)
}
