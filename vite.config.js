import { defineConfig } from 'vite'

// base 設為相對路徑，讓打包後用 file:// 或子目錄部署都能正確載入資源
export default defineConfig({
  base: './',
  server: { port: 5181, host: true, open: true },
  build: { outDir: 'dist', emptyOutDir: true }
})
