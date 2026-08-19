/** @type {import('next').NextConfig} */
const nextConfig = {
  // The dev-tools "N" badge floats over the terminal's status line — off.
  devIndicators: false,
  // Stop `next dev` writing its agent-rules block into AGENTS.md/CLAUDE.md.
  agentRules: false,
  // Trace the server and its real dependencies into .next/standalone so the
  // published package ships a prebuilt app: `evepad` boots node server.js
  // instead of installing 1GB and compiling on first request.
  output: "standalone",
  // node-pty is a native addon — keep it a runtime require, never bundled.
  serverExternalPackages: ["node-pty"],
  // No next/image anywhere, so sharp never runs — don't let tracing ship it.
  images: { unoptimized: true },
  // Dead weight the tracer copies into standalone anyway (~23MB of the 57MB
  // package): sharp's binaries, browserslist data, and Next's bundled babel /
  // edge-runtime / devtools, none of which a prebuilt node runtime touches.
  // Verified after every change by booting the packed tarball and exercising
  // all routes — re-run that check before trusting a new exclude.
  outputFileTracingExcludes: {
    "*": [
      "**/node_modules/sharp/**",
      "**/node_modules/@img/**",
      "**/node_modules/caniuse-lite/**",
      "**/node_modules/next/dist/compiled/babel/**",
      "**/node_modules/next/dist/compiled/babel-packages/**",
      "**/node_modules/next/dist/compiled/@edge-runtime/primitives/**",
      "**/node_modules/next/dist/compiled/edge-runtime/**",
      "**/node_modules/next/dist/compiled/next-devtools/**",
      "**/node_modules/next/dist/compiled/amphtml-validator/**",
      "**/node_modules/next/dist/compiled/postcss-preset-env/**",
      "**/node_modules/next/dist/compiled/crypto-browserify/**",
      "**/node_modules/next/dist/next-devtools/**",
    ],
  },
};

export default nextConfig;
