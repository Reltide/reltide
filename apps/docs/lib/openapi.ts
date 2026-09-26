import { createOpenAPI } from "fumadocs-openapi/server";

import schema from "../../../packages/api-client/openapi.json" with { type: "json" };

export const openapi = createOpenAPI({
  input: { reltide: () => schema },
});
