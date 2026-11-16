import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '^/api/': 'http://127.0.0.1:7310',
      '/healthz': 'http://127.0.0.1:7310',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
    cssCodeSplit: true,
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      // React Flow 13 bringt die Laufzeit des React Compilers mit; deren Direktive „use no memo“ ist nur ein Hinweis für
      // den Compiler und beim Bündeln bedeutungslos – die Warnung dazu ausblenden, alle anderen bleiben.
      onwarn(warning, warn) {
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && /react-compiler-runtime/.test(warning.id ?? '')) return;
        warn(warning);
      },
      output: {
        // Stabile Bibliotheks-Chunks: ändern sich selten und bleiben im Browser-Cache. Gruppen mit Priorität (#192):
        // Rolldown nimmt die Abhängigkeiten eines Moduls mit in seine Gruppe – ohne Vorrang landete die React-JSX-Laufzeit
        // im Markdown-Chunk (der dadurch auf jeder Seite geladen wurde) und React Flow (@xyflow/react) samt CSS im
        // React-Chunk. Editoren (React Flow, dagre, dnd-kit) und Markdown bleiben so in den Chunks ihrer Seiten.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\/](react|react-dom|scheduler|react-router)[\/]/, priority: 40 },
            { name: 'query', test: /node_modules[\/]@tanstack[\/]/, priority: 30 },
            { name: 'icons', test: /node_modules[\/]lucide-react[\/]/, priority: 20 },
            { name: 'flow', test: /node_modules[\/](@xyflow|@dagrejs|d3-[a-z-]+|classcat|zustand|react-compiler-runtime)[\/]/, priority: 10 },
            { name: 'markdown', test: /node_modules[\/](react-markdown|remark-[a-z-]+|micromark[a-z-]*|mdast-[a-z-]+|unified|hast-[a-z-]+|unist-[a-z-]+|vfile[a-z-]*|property-information|decode-named-character-reference|character-entities[a-z-]*|devlop|bail|trough|is-plain-obj|zwitch|longest-streak|markdown-table|ccount|escape-string-regexp|comma-separated-tokens|space-separated-tokens|html-url-attributes|estree-util-is-identifier-name|style-to-js|style-to-object|inline-style-parser|trim-lines)[\/]/, priority: 10 },
          ],
        },
      },
    },
  },
});
