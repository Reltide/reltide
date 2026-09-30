use serde::{Deserialize, Serialize};
use std::{
    fmt,
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProbeInput {
    pub run_id: String,
    pub sequence: u64,
    pub payload: String,
    pub hold_seconds: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProbeOutput {
    pub run_id: String,
    pub sequence: u64,
    pub sha256: String,
}

#[derive(Error, Debug)]
pub enum ProbeError {
    #[error("invalid probe request: {0}")]
    Validation(&'static str),
    #[error("database operation failed")]
    Database,
    #[error("Temporal operation failed")]
    Temporal,
    #[error("probe I/O failed")]
    Io,
}

#[derive(Clone)]
pub struct ProbeConfig {
    pub temporal_address: String,
    pub namespace: String,
    pub task_queue: String,
    pub application_database_url: String,
}

impl fmt::Debug for ProbeConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProbeConfig")
            .field("namespace", &self.namespace)
            .field("task_queue", &self.task_queue)
            .field("temporal_address", &"[redacted]")
            .field("application_database_url", &"[redacted]")
            .finish()
    }
}

impl ProbeConfig {
    pub fn validate_for(&self, run_id: &str) -> Result<(), ProbeError> {
        validate_run_id(run_id)?;
        let scope = format!("reltide-capacity-{run_id}");
        if self.namespace != scope || self.task_queue != scope {
            return Err(ProbeError::Validation(
                "namespace and task queue must match run scope",
            ));
        }
        Ok(())
    }

    /// Read literal KEY=VALUE lines, without shell evaluation, from an owner-only file.
    pub fn from_env_file(path: &Path) -> Result<Self, ProbeError> {
        use std::os::unix::fs::PermissionsExt;
        let file = std::fs::File::open(path).map_err(|_| ProbeError::Io)?;
        let metadata = file.metadata().map_err(|_| ProbeError::Io)?;
        if !metadata.is_file()
            || metadata.permissions().mode() & 0o077 != 0
            || metadata.len() > 8192
        {
            return Err(ProbeError::Validation(
                "environment file must be a restricted regular file of at most 8192 bytes",
            ));
        }
        use std::io::Read;
        let mut content = String::new();
        file.take(8193)
            .read_to_string(&mut content)
            .map_err(|_| ProbeError::Io)?;
        if content.len() > 8192 {
            return Err(ProbeError::Validation("environment file exceeds limit"));
        }
        let mut values = std::collections::BTreeMap::new();
        for line in content
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
        {
            let (key, value) = line
                .split_once('=')
                .ok_or(ProbeError::Validation("invalid environment file"))?;
            if !matches!(
                key,
                "TEMPORAL_ADDRESS"
                    | "TEMPORAL_NAMESPACE"
                    | "TEMPORAL_TASK_QUEUE"
                    | "APPLICATION_DATABASE_URL"
            ) || value.is_empty()
                || values.insert(key, value).is_some()
            {
                return Err(ProbeError::Validation(
                    "unknown, empty or duplicate environment key",
                ));
            }
        }
        let get = |key| {
            values
                .get(key)
                .map(|v| (*v).to_owned())
                .ok_or(ProbeError::Validation("missing environment key"))
        };
        Ok(Self {
            temporal_address: get("TEMPORAL_ADDRESS")?,
            namespace: get("TEMPORAL_NAMESPACE")?,
            task_queue: get("TEMPORAL_TASK_QUEUE")?,
            application_database_url: get("APPLICATION_DATABASE_URL")?,
        })
    }
}

pub fn decode_input(bytes: &[u8]) -> Result<ProbeInput, ProbeError> {
    if bytes.len() > 8192 {
        return Err(ProbeError::Validation("request exceeds 8192 bytes"));
    }
    let input = serde_json::from_slice(bytes)
        .map_err(|_| ProbeError::Validation("malformed request JSON"))?;
    validate(&input)?;
    Ok(input)
}

#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum ProbeEvent {
    Started {
        sequence: u64,
        workflow_id: String,
        temporal_run_id: String,
    },
    Completed {
        sequence: u64,
        sha256: String,
    },
    Watermark {
        sequence: u64,
        sha256: String,
        post_commit_time: String,
    },
    History {
        sequence: u64,
        workflow_id: String,
        path: String,
        sha256: String,
    },
}

#[derive(Debug, Serialize)]
pub struct EventEnvelope<'a> {
    pub protocol_version: u8,
    pub run_id: &'a str,
    /// Milliseconds since the Unix epoch in UTC, independent of the local timezone.
    pub timestamp_utc_ms: u128,
    #[serde(flatten)]
    pub event: ProbeEvent,
}

impl ProbeEvent {
    pub fn envelope(self, run_id: &str) -> Result<EventEnvelope<'_>, ProbeError> {
        validate_run_id(run_id)?;
        Ok(EventEnvelope {
            protocol_version: 1,
            run_id,
            timestamp_utc_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| ProbeError::Io)?
                .as_millis(),
            event: self,
        })
    }
    pub fn emit(self, run_id: &str) -> Result<(), ProbeError> {
        let mut output = std::io::stdout().lock();
        serde_json::to_writer(&mut output, &self.envelope(run_id)?).map_err(|_| ProbeError::Io)?;
        output.write_all(b"\n").map_err(|_| ProbeError::Io)?;
        output.flush().map_err(|_| ProbeError::Io)
    }
}

pub fn validate(input: &ProbeInput) -> Result<(), ProbeError> {
    validate_run_id(&input.run_id)?;
    if input.sequence > i64::MAX as u64 {
        return Err(ProbeError::Validation("sequence exceeds PostgreSQL bigint"));
    }
    if input.payload.len() > 1024 {
        return Err(ProbeError::Validation("payload exceeds 1024 bytes"));
    }
    if input.hold_seconds > 60 {
        return Err(ProbeError::Validation("hold exceeds 60 seconds"));
    }
    Ok(())
}

pub fn validate_run_id(run_id: &str) -> Result<(), ProbeError> {
    if run_id.is_empty()
        || run_id.len() > 64
        || !run_id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(ProbeError::Validation("run_id must match [a-z0-9-]{1,64}"));
    }
    Ok(())
}
