use crate::{
    ledger::LedgerActivities,
    protocol::{ProbeInput, ProbeOutput, validate},
};
use std::time::Duration;
use temporalio_common::RetryPolicy;
use temporalio_macros::{workflow, workflow_methods};
use temporalio_sdk::{
    ActivityCloseTimeouts, ActivityOptions, WorkflowContext, WorkflowContextView, WorkflowResult,
};

#[workflow]
pub struct CapacityWorkflow {
    input: ProbeInput,
}

#[workflow_methods]
impl CapacityWorkflow {
    #[init]
    pub fn new(_ctx: &WorkflowContextView, input: ProbeInput) -> Self {
        Self { input }
    }

    #[run]
    pub async fn run(ctx: &mut WorkflowContext<Self>) -> WorkflowResult<ProbeOutput> {
        let input = ctx.state(|state| state.input.clone());
        validate(&input).map_err(temporalio_sdk::ApplicationFailure::non_retryable)?;
        let output = ctx
            .execute_activity(
                LedgerActivities::record,
                input.clone(),
                ActivityOptions::with_close_timeouts(
                    ActivityCloseTimeouts::ScheduleAndStartToClose {
                        start_to_close: Duration::from_secs(5),
                        schedule_to_close: Duration::from_secs(10),
                    },
                )
                .retry_policy(RetryPolicy::builder().maximum_attempts(2).build())
                .build(),
            )
            .await?;
        if input.hold_seconds > 0
            && ctx
                .timer(Duration::from_secs(u64::from(input.hold_seconds)))
                .await
                == temporalio_sdk::TimerResult::Cancelled
        {
            return Err(temporalio_sdk::WorkflowTermination::cancelled());
        }
        Ok(output)
    }
}
