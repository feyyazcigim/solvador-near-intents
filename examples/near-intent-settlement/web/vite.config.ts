import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The paywall bundle. `vite build web` from the example root; output lands in
// web/dist, which server.ts serves statically and injects the 402 payload into.
export default defineConfig({
  plugins: [react()],
  server: {
    // `npm run dev:web` — proxy the API + paid route to the running example
    // server so the paywall can be iterated on with HMR.
    proxy: {
      "/api": "http://localhost:4021",
      "/premium": "http://localhost:4021",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
