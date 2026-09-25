use axum::{Json, Router, routing::get};
use serde::Serialize;
use utoipa::{
    ToSchema,
    openapi::{Info, OpenApi},
};
use utoipa_axum::{router::OpenApiRouter, routes};

#[derive(Serialize, ToSchema)]
struct HealthResponse {
    status: HealthStatus,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
enum HealthStatus {
    Ok,
}

#[utoipa::path(
    get,
    path = "/api/v1/health",
    operation_id = "getHealth",
    responses((status = 200, description = "Process is healthy", body = HealthResponse))
)]
async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: HealthStatus::Ok,
    })
}

/// Return the HTTP router and the contract collected from its registered routes.
pub fn api() -> (Router, OpenApi) {
    let (router, mut document) = OpenApiRouter::new()
        .routes(routes!(health))
        .split_for_parts();
    document.info = Info::new("Reltide API", env!("CARGO_PKG_VERSION"));
    let served_document = document.clone();
    let router = router.route(
        "/openapi.json",
        get(move || {
            let document = served_document.clone();
            async move { Json(document) }
        }),
    );

    (router, document)
}
