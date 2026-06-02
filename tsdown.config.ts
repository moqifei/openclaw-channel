import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: 'esm',
  target: 'node22',
  platform: 'node',
  clean: true,
  outDir: 'dist',
  dts: false,
  extension: '.js',
  deps: {
    neverBundle: [
      /^openclaw(\/.*)?$/,
      /^@openim\//,
      /^@clack\//,
    ],
  },
});
