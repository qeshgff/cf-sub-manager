import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  build: {
    // 修改输出目录，使其与我们部署文件夹的结构匹配
    outDir: '../cf-sub-manager/static', 
    emptyOutDir: true, // 构建时清空目标目录
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        // 固定生成的文件名，避免 hash 变化导致文件名不匹配
        entryFileNames: `assets/[name].js`,
        chunkFileNames: `assets/[name].js`,
        assetFileNames: `assets/[name].[ext]`
      }
    }
  }
})
