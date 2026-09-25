import { source } from "../../lib/source";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";

const Layout = ({ children }: { children: ReactNode }) => (
  <DocsLayout nav={{ title: "Reltide" }} tree={source.getPageTree()}>
    {children}
  </DocsLayout>
);

export default Layout;
