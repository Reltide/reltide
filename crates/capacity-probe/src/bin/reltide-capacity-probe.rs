use reltide_capacity_probe::{
    analytics::{AnalyticsConfig, probe_analytics_cancellable},
    client::{export_history, replay_history, start_probe},
    ledger::{LedgerActivities, validate_seed},
    protocol::{ProbeConfig, ProbeError, ProbeEvent, ProbeInput, decode_input, validate},
    worker::run_worker,
};
use serde::Deserialize;
use std::{path::Path, process::ExitCode};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryRequest {
    input: ProbeInput,
    path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReplayRequest {
    path: String,
}

fn config() -> Result<ProbeConfig, ProbeError> {
    let path = std::env::var_os("RELTIDE_CAPACITY_ENV_FILE").ok_or(ProbeError::Validation(
        "RELTIDE_CAPACITY_ENV_FILE is required",
    ))?;
    ProbeConfig::from_env_file(Path::new(&path))
}

async fn stdin() -> Result<Vec<u8>, ProbeError> {
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    tokio::io::stdin()
        .take(8193)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| ProbeError::Io)?;
    if bytes.len() > 8192 {
        return Err(ProbeError::Validation("request exceeds 8192 bytes"));
    }
    Ok(bytes)
}

async fn run() -> Result<(), ProbeError> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [command] = args.as_slice() else {
        return Err(ProbeError::Validation(
            "expected one subcommand: worker, start, seed-ledger, verify-ledger, history, replay",
        ));
    };
    match command.as_str() {
        "probe-analytics" => {
            let input = decode_input(&stdin().await?)?;
            let config = AnalyticsConfig {
                application_database_url: std::env::var("CAPACITY_ANALYTICS_DATABASE_URL")
                    .map_err(|_| ProbeError::Validation("scoped analytics DSN required"))?,
            };
            let stop = async {
                let _ = tokio::signal::ctrl_c().await;
            };
            let output = serde_json::to_string(
                &probe_analytics_cancellable(&input.run_id, &config, stop).await?,
            )
            .map_err(|_| ProbeError::Io)?;
            println!("{output}");
            Ok(())
        }
        "worker" => run_worker(&config()?).await,
        "start" => {
            let input = decode_input(&stdin().await?)?;
            start_probe(&input, &config()?).await?;
            Ok(())
        }
        "seed-ledger" | "verify-ledger" => {
            let input = decode_input(&stdin().await?)?;
            if command == "seed-ledger" {
                validate_seed(&input)?;
            }
            let config = config()?;
            config.validate_for(&input.run_id)?;
            let ledger = LedgerActivities::connect(&config.application_database_url).await?;
            let (output, post_commit_time) = if command == "seed-ledger" {
                ledger.install_schema().await?;
                ledger.seed(&input).await?
            } else if validate_seed(&input).is_ok() {
                ledger.verify_seed(&input).await?
            } else {
                ledger.verify(&input).await?
            };
            ProbeEvent::Watermark {
                sequence: output.sequence,
                sha256: output.sha256,
                post_commit_time,
            }
            .emit(&output.run_id)
        }
        "history" => {
            let request: HistoryRequest = serde_json::from_slice(&stdin().await?)
                .map_err(|_| ProbeError::Validation("invalid history request"))?;
            validate(&request.input)?;
            export_history(&request.input, &config()?, Path::new(&request.path)).await
        }
        "replay" => {
            let request: ReplayRequest = serde_json::from_slice(&stdin().await?)
                .map_err(|_| ProbeError::Validation("invalid replay request"))?;
            replay_history(Path::new(&request.path)).await
        }
        _ => Err(ProbeError::Validation("unknown subcommand")),
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
