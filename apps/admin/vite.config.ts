import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  base: "/miniapp/",
  plugins: [react(), tsconfigPaths()],
  server: {
    port: 5173,
  },
});
