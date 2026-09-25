use std::{env, net::SocketAddr};

use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (router, document) = reltide_api::api();
    match env::args().nth(1).as_deref() {
        Some("--print-openapi") => {
            println!("{}", document.to_pretty_json()?);
            return Ok(());
        }
        Some(argument) => return Err(format!("unknown argument: {argument}").into()),
        None => {}
    }

    let bind = env::var("RELTIDE_API_BIND").unwrap_or_else(|_| "127.0.0.1:3002".to_owned());
    let address: SocketAddr = bind.parse()?;
    let listener = TcpListener::bind(address).await?;
    println!("Reltide API listening on {}", listener.local_addr()?);
    axum::serve(listener, router).await?;
    Ok(())
}
