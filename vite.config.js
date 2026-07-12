import { defineConfig } from 'vite'
import { execSync } from 'node:child_process'

// 遊戲版本＝最後一次 git commit 的時間（build 當下讀取，寫死進打包產物），
// 用來在畫面上標示「這個版本是什麼時候更新的」。抓不到 git（例如非 git 環境下打包）
// 就退回用打包當下的時間，不讓 build 直接失敗
function getLastCommitISO() {
  try {
    return execSync('git log -1 --format=%cI').toString().trim()
  } catch {
    return new Date().toISOString()
  }
}

// base 設為相對路徑，讓打包後用 file:// 或子目錄部署都能正確載入資源
export default defineConfig({
  base: './',
  server: { port: 5181, host: true, open: true },
  build: { outDir: 'dist', emptyOutDir: true },
  define: {
    __LAST_UPDATE_ISO__: JSON.stringify(getLastCommitISO()),
  },
})
