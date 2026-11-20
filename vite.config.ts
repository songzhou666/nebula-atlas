import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 相对 base：静态产物可部署到任意子路径（含 Trae 站点）。
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
})
