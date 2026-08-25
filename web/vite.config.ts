import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/ws": {
        target: process.env.VITE_WS_TARGET ?? "ws://localhost:8787",
        ws: true,
      },
      // Menu's IN-ARENA pill polls /health on its own origin — proxy it too
      // so the counter works against the same backend instance as the game.
      "/health": {
        target: (process.env.VITE_WS_TARGET ?? "ws://localhost:8787").replace(/^ws/, "http"),
      },
    },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 600,
  },
});
