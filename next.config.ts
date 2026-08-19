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
};

export default nextConfig;
