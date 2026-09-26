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
          // next-validate-link skips hash-only URLs; resolve them explicitly.
          return {
            hrefs: hrefs.map((href) =>
              href.startsWith("#") ? `${file.url}${href}` : href
            ),
          };
        },
      },
      pathToUrl: (filePath) =>
        files.find((item) => item.path === filePath)?.url,
      scanned,
    })
  )
);
printErrors(results.flat(), true);
