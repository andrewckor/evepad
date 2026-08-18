// Web app manifest, served at /manifest.webmanifest and linked automatically.
// This is the whole PWA story on purpose: installability needs the manifest
// and icons, not a service worker — and a service worker caching a localhost
// dev server would serve stale builds long after the real one moved on.
export default function manifest() {
  return {
    name: "evepad",
    short_name: "evepad",
    description: "Agent runs, local and remote",
    start_url: "/",
    display: "standalone",
    // The boot script resolves the real theme before first paint; black chrome
    // matches the dark default and reads fine around the light palette too.
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
