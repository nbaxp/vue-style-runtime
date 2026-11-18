import { defineConfig } from 'vite';

// 库构建：同时产出未压缩的 dist/index.js 与压缩的 dist/index.min.js，
// 且不清空演示构建产物（--mode min 控制压缩与文件名）。
export default defineConfig(({ mode }) => {
  const minify = mode === 'min';

  return {
    build: {
      emptyOutDir: false,
      target: 'es2020',
      // Vite 8 默认压缩器是 Oxc；lib 的 ES 格式不压空白，以保留 pure 注解。
      minify: minify ? 'oxc' : false,
      lib: {
        entry: 'index.js',
        formats: ['es'],
        fileName: () => (minify ? 'index.min.js' : 'index.js'),
      },
    },
  };
});
