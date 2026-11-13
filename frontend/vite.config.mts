import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL(".", import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  root: root,

  build: {
    outDir: "../dist",
    emptyOutDir: true,
    assetsDir: "assets"
  },

  // npm run dev: the page on :5173, the API (tsx watch) on :3000.
  server: {
    proxy: {
      '/api': `http://localhost:${process.env.PORT || "3000"}`,
    },
  },
})
