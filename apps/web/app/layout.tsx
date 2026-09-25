import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./global.css";

export const metadata: Metadata = {
  description:
    "A developer tool for evidence-backed API change detection and verified migration drafts.",
  title: "Reltide — API migrations, prepared for review",
};

const RootLayout = ({ children }: { children: ReactNode }) => (
  <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
    <body className={`${GeistSans.className} antialiased`}>{children}</body>
  </html>
);

export default RootLayout;
