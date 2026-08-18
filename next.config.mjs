/** @type {import('next').NextConfig} */
const nextConfig = {
  // The dev-tools "N" badge floats over the terminal's status line — off.
  devIndicators: false,
  // Trace the server and its real dependencies into .next/standalone so the
  // published package ships a prebuilt app: `evepad` boots node server.js
  // instead of installing 1GB and compiling on first request.
  output: "standalone",
};

export default nextConfig;
