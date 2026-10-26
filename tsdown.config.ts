import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'market-api': 'src/market-api.ts',
    'archive': 'src/archive.ts',
    'skill-install': 'src/skill-install.ts',
    'plugin-install': 'src/plugin-install.ts',
    'routes': 'src/routes.ts',
  },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-host-webserver',
  ],
})
