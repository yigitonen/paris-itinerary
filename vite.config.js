import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { cpSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        advanced: resolve(import.meta.dirname, 'app.html'),
        privacy: resolve(import.meta.dirname, 'privacy.html'),
        support: resolve(import.meta.dirname, 'support.html')
      }
    }
  },
  plugins: [{
    name: 'roamly-static-assets',
    closeBundle() {
      mkdirSync('dist/assets', { recursive: true });
      mkdirSync('dist/icons', { recursive: true });
      copyFileSync('manifest.webmanifest', 'dist/manifest.webmanifest');
      copyFileSync('sw.js', 'dist/sw.js');
      cpSync('assets', 'dist/assets', { recursive: true });
      cpSync('icons', 'dist/icons', { recursive: true });
      const emittedManifest = readdirSync('dist/assets').find((file) => /^manifest-.*\.webmanifest$/.test(file));
      if (emittedManifest) {
        const path = `dist/assets/${emittedManifest}`;
        const manifest = JSON.parse(readFileSync(path, 'utf8'));
        manifest.start_url = '../index.html';
        manifest.icons = manifest.icons.map((icon) => ({ ...icon, src: `../${icon.src}` }));
        writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
      }
    }
  }]
});
