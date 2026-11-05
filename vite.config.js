import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Strict Content-Security-Policy for the packaged app (dev needs inline HMR scripts).
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
const cspPlugin = {
  name: 'raijin-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
};

export default defineConfig({
  plugins: [react(), cspPlugin],
  base: './',
  publicDir: 'public',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'chrome130', reportCompressedSize: false, chunkSizeWarningLimit: 900 },
});
