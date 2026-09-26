import { loader } from "fumadocs-core/source";
import { defineDocs } from "fumadocs-mdx/macro";
import { openapiPlugin } from "fumadocs-openapi/server";

const docs = defineDocs({ dir: "content/docs" });

export const source = loader({
  baseUrl: "/docs",
  plugins: [openapiPlugin()],
  source: docs.toFumadocsSource(),
});
