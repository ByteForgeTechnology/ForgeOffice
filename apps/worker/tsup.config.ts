import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Keep every npm dependency external (resolved via the hoisted node_modules);
  // inline only the @forge/* workspace packages, which ship TypeScript sources.
  skipNodeModulesBundle: true,
  noExternal: [/^@forge\//],
});
