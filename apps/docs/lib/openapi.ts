import type { Document } from "fumadocs-openapi";
import { createOpenAPI } from "fumadocs-openapi/server";

import schema from "../../../packages/api-client/openapi.json" with { type: "json" };

export const openapi = createOpenAPI({
  // SAFETY: Nx verifies this JSON against Rust's OpenAPI export before use; JSON imports widen its literal types.
  input: { reltide: () => schema as Document },
});
