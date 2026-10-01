import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // relative asset paths -- the production build gets republished as a
  // Claude Artifact, served from a subpath rather than domain root, so an
  // absolute "/assets/..." reference 404s there even though it works fine
  // in normal local/CDN hosting.
  base: "./",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["apple-touch-icon.png"],
      manifest: {
        name: "Room Builder",
        short_name: "Room Builder",
        description: "Browser-based 3D architectural design tool",
        start_url: ".",
        scope: ".",
        display: "standalone",
        // the UI is a dense, desktop-style layout (side panels, a ribbon
        // toolbar) that overlaps badly in portrait on a phone; it's fully
        // usable in landscape, so an installed launch should open there.
        orientation: "landscape",
        background_color: "#1a1a1a",
        theme_color: "#1a1a1a",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // the Three.js/vendor bundle is >2MB after gzip estimation headroom --
        // raise Workbox's default 2MB precache limit so the main chunk isn't
        // silently skipped from the install-time cache.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
});
