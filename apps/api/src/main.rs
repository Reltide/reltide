use std::{env, net::SocketAddr, path::PathBuf};

use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (_, document) = reltide_api::api();
    match env::args().nth(1).as_deref() {
        Some("--print-openapi") => {
            println!("{}", document.to_pretty_json()?);
            return Ok(());
        }
        Some(argument) => return Err(format!("unknown argument: {argument}").into()),
        None => {}
    }

    let report_path = env::var_os("RELTIDE_MIGRATION_REPORT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.reltide/demo/report.json")
        });
    let (router, _) = reltide_api::api_with_report(Some(report_path));
    let bind = env::var("RELTIDE_API_BIND").unwrap_or_else(|_| "127.0.0.1:3002".to_owned());
    let address: SocketAddr = bind.parse()?;
    let listener = TcpListener::bind(address).await?;
    println!("Reltide API listening on {}", listener.local_addr()?);
    axum::serve(listener, router).await?;
    Ok(())
}
