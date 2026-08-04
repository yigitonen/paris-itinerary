import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { cpSync, copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

const sitesBuild = process.env.ROAMLY_SITES_BUILD === '1';

export default defineConfig({
  base: './',
  build: {
    outDir: sitesBuild ? 'dist/client' : 'dist',
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
    buildStart() {
      if (sitesBuild) rmSync('dist', { recursive: true, force: true });
    },
    closeBundle() {
      const clientDir = sitesBuild ? 'dist/client' : 'dist';
      mkdirSync(`${clientDir}/assets`, { recursive: true });
      mkdirSync(`${clientDir}/icons`, { recursive: true });
      copyFileSync('manifest.webmanifest', `${clientDir}/manifest.webmanifest`);
      copyFileSync('sw.js', `${clientDir}/sw.js`);
      cpSync('assets', `${clientDir}/assets`, { recursive: true });
      cpSync('icons', `${clientDir}/icons`, { recursive: true });

      if (sitesBuild) {
        mkdirSync('dist/.openai', { recursive: true });
        mkdirSync('dist/server', { recursive: true });
        copyFileSync('.openai/hosting.json', 'dist/.openai/hosting.json');
        copyFileSync('worker/index.js', 'dist/server/index.js');
      }

      const emittedManifest = readdirSync(`${clientDir}/assets`).find((file) => /^manifest-.*\.webmanifest$/.test(file));
      if (emittedManifest) {
        const path = `${clientDir}/assets/${emittedManifest}`;
        const manifest = JSON.parse(readFileSync(path, 'utf8'));
        manifest.start_url = '../index.html';
        manifest.icons = manifest.icons.map((icon) => ({ ...icon, src: `../${icon.src}` }));
        writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
      }
    }
  }]
});
