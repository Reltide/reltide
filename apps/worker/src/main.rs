use std::path::Path;

fn main() -> std::process::ExitCode {
    match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{}", format_error(error.as_ref()));
            std::process::ExitCode::FAILURE
        }
    }
}

fn format_error(error: &dyn std::error::Error) -> String {
    format!("Stripe demo failed: {error}")
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.as_slice() != ["stripe-demo"] {
        return Err("expected exactly one subcommand: stripe-demo".into());
    }
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let report = reltide_worker::run_stripe_demo(&workspace)?;
    println!(
        "Stripe fixture locally verified: {} checks; publication held. Artifacts: .reltide/demo/report.json, migration.patch, pull-request.md",
        report.checks.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn cli_errors_include_recovery_guidance() {
        assert!(
            super::format_error(&reltide_worker::DemoError::ConcurrentRun).contains("recovery")
        );
        assert!(
            super::format_error(&reltide_worker::DemoError::Verification).contains("report.json")
        );
    }
}
