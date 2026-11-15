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
    rollupOptions: {
      output: {
        // Stabile Bibliotheks-Chunks: ändern sich selten und bleiben im Browser-Cache
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/](react|react-dom|scheduler|react-router)[\\/]/.test(id)) return 'react';
          if (id.includes('@tanstack')) return 'query';
          if (id.includes('lucide-react')) return 'icons';
          if (/react-markdown|remark|micromark|mdast|unified|hast|unist|vfile|property-information|decode-named|character-entities/.test(id)) return 'markdown';
          return undefined;
        },
      },
    },
  },
});
