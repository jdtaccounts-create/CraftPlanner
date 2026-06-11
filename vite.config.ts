import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  clearScreen: false,
  plugins: [vue()],
  server: {
    host: process.env.TAURI_DEV_HOST || '127.0.0.1',
    port: 5175,
    strictPort: true,
    watch: {
      ignored: [
        '**/src-tauri/**',
        '**/public/cache/images/**',
        '**/public/data/generated/**',
      ],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
})
