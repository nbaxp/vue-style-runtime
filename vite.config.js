import { defineConfig } from 'vite';

// 演示页构建：根目录 index.html 作为入口，产物输出到 dist。
export default defineConfig({
  base: './',
  // 演示用 vue/dist/vue.esm-bundler.js，需显式替换 esm-bundler 的编译期特性开关。
  define: {
    __VUE_OPTIONS_API__: true,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
  },
  build: {
    target: 'es2020',
  },
});
