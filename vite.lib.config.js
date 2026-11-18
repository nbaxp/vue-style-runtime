import { defineConfig } from 'vite';

// 库构建：同时产出未压缩的 dist/index.js 与压缩的 dist/index.min.js，
// 且不清空演示构建产物（--mode min 控制压缩与文件名）。
export default defineConfig(({ mode }) => {
  const minify = mode === 'min';

  return {
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      copyPublicDir: false,
      target: 'es2020',
      // 库构建用 terser：Vite 对 ES 格式的 lib 构建会强制 esbuild 的
      // minifyWhitespace: false，只能混淆标识符与语法，体积压不下去。
      minify: minify ? 'terser' : false,
      lib: {
        entry: 'index.js',
        formats: ['es'],
        fileName: () => (minify ? 'index.min.js' : 'index.js'),
      },
    },
  };
});
