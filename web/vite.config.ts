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
    },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 600,
  },
});
