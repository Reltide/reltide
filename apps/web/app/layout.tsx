import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./global.css";

export const metadata: Metadata = {
  description:
    "A developer tool for evidence-backed API change detection and verified migration drafts.",
  title: "Reltide — API migrations, prepared for review",
};

const RootLayout = ({ children }: { children: ReactNode }) => (
  <html lang="en">
    <body>{children}</body>
  </html>
);

export default RootLayout;
