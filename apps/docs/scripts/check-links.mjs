import path from "node:path";

import { register } from "fumadocs-mdx/node";
import { printErrors, scanURLs, validateFiles } from "next-validate-link";

register();
const { source } = await import("../lib/source.ts");
const pages = source.getPages();
const scanned = await scanURLs({
  populate: {
    "docs/[[...slug]]": pages.map((page) => ({
      hashes: page.data.toc.map((item) => item.url.slice(1)),
      value: { slug: page.slugs },
    })),
  },
  preset: "next",
});
const files = await Promise.all(
  pages.map(async (page) => ({
    content: await page.data.getText("raw"),
    data: page.data,
    path: page.absolutePath,
    url: page.url,
  }))
);
const urlsByPath = new Map(
  files.map((file) => [path.resolve(file.path), file.url])
);
const results = await Promise.all(
  files.map((file) =>
    validateFiles([file], {
      checkExternal: false,
      checkRelativePaths: "as-url",
      markdown: {
        onNode(node) {
          let hrefs = [];
          if (node.type === "link" || node.type === "definition") {
            hrefs = [node.url];
          } else if (
            node.type === "mdxJsxFlowElement" ||
            node.type === "mdxJsxTextElement"
          ) {
            hrefs = node.attributes
              .filter(
                (attribute) =>
                  attribute.type === "mdxJsxAttribute" &&
                  attribute.name === "href" &&
                  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Parsed MDX attributes are strings, expressions, or null at this input boundary.
                  typeof attribute.value === "string"
              )
              .map((attribute) => attribute.value);
          }
          // The validator skips URLs with no pathname; resolve their page first.
          return {
            hrefs: hrefs.map((href) =>
              href.startsWith("#") || href.startsWith("?")
                ? `${file.url}${href}`
                : href
            ),
          };
        },
      },
      pathToUrl(filePath) {
        const url = urlsByPath.get(path.resolve(filePath));
        if (!url) {
          throw new Error(`No documentation route for ${filePath}`);
        }
        return url;
      },
      scanned,
    })
  )
);
printErrors(results.flat(), true);
