import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { configDotenv } from "dotenv"
import { fileURLToPath } from "node:url"

configDotenv()

const domain = process.env.DOMAIN_NAME || "localhost"
const port = process.env.PORT || "3000"

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

  server: {
    proxy: {
      '/api': `http://${domain}:${port}`,
    },
  },
})