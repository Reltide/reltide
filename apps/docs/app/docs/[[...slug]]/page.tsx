import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ComponentProps } from "react";

import { OpenAPIPage } from "../../../components/api-page";
import { openapi } from "../../../lib/openapi";
import { source } from "../../../lib/source";

interface Props {
  params: Promise<{ slug?: string[] }>;
}

const getMdxComponents = (
  page: NonNullable<ReturnType<typeof source.getPage>>
) => ({
  ...defaultMdxComponents,
  OpenAPIPage: async (props: ComponentProps<typeof OpenAPIPage>) => (
    <OpenAPIPage {...await openapi.preloadOpenAPIPage(page)} {...props} />
  ),
});

const Page = async ({ params }: Props) => {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) {
    notFound();
  }

  const MdxContent = page.data.body;
  return (
    <DocsPage full={page.data.full} toc={page.data.toc}>
      <DocsTitle>{page.data.title}</DocsTitle>
      {page.data.description && (
        <DocsDescription>{page.data.description}</DocsDescription>
      )}
      <DocsBody>
        <MdxContent components={getMdxComponents(page)} />
      </DocsBody>
    </DocsPage>
  );
};

export const generateStaticParams = () => source.generateParams();

export const generateMetadata = async ({
  params,
}: Props): Promise<Metadata> => {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) {
    notFound();
  }
  return { description: page.data.description, title: page.data.title };
};

export default Page;
