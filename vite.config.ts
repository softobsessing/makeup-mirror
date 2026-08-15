import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  // Sub-path deploys (GitHub Pages serves at /<repo>/) need every asset URL
  // prefixed, or they resolve against the domain root and 404.
  //   VITE_BASE=/makeup-assistant/ npm run build
  base: loadEnv(mode, ".", "").VITE_BASE || "/",
  plugins: [react()],
  server: {
    // getUserMedia requires a secure context. localhost counts as secure,
    // so the dev server works without HTTPS during development.
    host: true,
    port: 5173,
  },
}));
