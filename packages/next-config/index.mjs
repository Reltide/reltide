/** @type {import('next').NextConfig} */
export const config = {
  output: "standalone",
  reactStrictMode: true,
  transpilePackages: ["@repo/design-system"],
};
