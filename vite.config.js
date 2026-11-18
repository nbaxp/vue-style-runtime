import { defineConfig } from 'vite';

const isExternalUrl = (id) => /^https?:\/\//.test(id);

// 演示页构建：根目录 index.html 作为入口，产物输出到 dist。
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      // 演示页从 esm.sh 引入 Vue，保持外链不打包。
      external: isExternalUrl,
    },
  },
});
