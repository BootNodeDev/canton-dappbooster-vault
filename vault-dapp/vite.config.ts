import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Nothing is configured: this app reads the deployment, the instruments and every disclosure
  // off the ledger through the wallet, so there is no `VITE_*` key and no `define`. The root
  // `.env` is still the dir a later key would come from.
  envDir: fileURLToPath(new URL('..', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: 'localhost',
    port: 3013,
    strictPort: true,
  },
  // jsdom despite no DOM assertions: the wallet SDK touches DOM globals on import.
  test: {
    environment: 'jsdom',
    // Node 26's own localStorage global shadows jsdom's under vitest 4; vitest 5 fixes it.
    execArgv: ['--no-experimental-webstorage'],
  },
})
