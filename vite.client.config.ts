import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const { name } = JSON.parse(readFileSync('package.json', 'utf8'))

export default defineConfig({
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'lib', emptyOutDir: false, target: 'es2022', minify: false,
    lib: { entry: 'src/client/index.tsx', formats: ['cjs'], fileName: () => 'client.js' },
    rollupOptions: {
      external: id => /^(react(?:-dom)?(?:\/|$)|@deepseek-ai\/)/u.test(id),
      output: {
        codeSplitting: false,
        banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {`,
        intro: 'var module = { exports: {} }; var exports = module.exports;',
        footer: 'return module.exports; } });',
      },
    },
  },
})
