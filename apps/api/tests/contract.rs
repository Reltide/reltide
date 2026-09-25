use std::process::Command;

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use serde_json::{Value, json};
use tower::ServiceExt;

#[tokio::test]
async fn health_response_and_served_contract_share_the_router()
-> Result<(), Box<dyn std::error::Error>> {
    let (router, document) = reltide_api::api();

    let health = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/health")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(health.status(), StatusCode::OK);
    assert_eq!(health.headers()[header::CONTENT_TYPE], "application/json");
    let body = to_bytes(health.into_body(), 1024).await?;
    assert_eq!(
        serde_json::from_slice::<Value>(&body)?,
        json!({ "status": "ok" })
    );

    let contract = router
        .oneshot(
            Request::builder()
                .uri("/openapi.json")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(contract.status(), StatusCode::OK);
    assert_eq!(contract.headers()[header::CONTENT_TYPE], "application/json");
    let body = to_bytes(contract.into_body(), 1024 * 1024).await?;
    let served: Value = serde_json::from_slice(&body)?;
    assert_eq!(served, serde_json::to_value(document)?);
    assert_eq!(served["info"]["title"], "Reltide API");
    assert!(
        served
            .pointer("/paths/~1api~1v1~1health/get/responses/200/content/application~1json/schema")
            .is_some(),
        "the health response must be described as JSON"
    );
    Ok(())
}

#[test]
fn offline_contract_export_is_pure_json() -> Result<(), Box<dyn std::error::Error>> {
    let output = Command::new(env!("CARGO_BIN_EXE_reltide-api"))
        .arg("--print-openapi")
        .env("RELTIDE_API_BIND", "not-an-address")
        .output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let printed: Value = serde_json::from_slice(&output.stdout)?;
    assert_eq!(printed, serde_json::to_value(reltide_api::api().1)?);
    assert_eq!(
        printed["paths"]["/api/v1/health"]["get"]["operationId"],
        "getHealth"
    );
    assert_eq!(
        printed["components"]["schemas"]["HealthStatus"]["enum"],
        json!(["ok"])
    );
    Ok(())
}
