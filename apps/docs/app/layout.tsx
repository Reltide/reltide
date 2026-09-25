import { RootProvider } from "fumadocs-ui/provider/next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./global.css";

export const metadata: Metadata = {
  description: "Product and developer documentation for API Sync.",
  title: "Reltide documentation",
};

const RootLayout = ({ children }: { children: ReactNode }) => (
  <html
    lang="en"
    className={`${GeistSans.variable} ${GeistMono.variable}`}
    suppressHydrationWarning
  >
    <body
      className={`${GeistSans.className} flex min-h-screen flex-col antialiased`}
    >
      <RootProvider>{children}</RootProvider>
    </body>
  </html>
);

export default RootLayout;
