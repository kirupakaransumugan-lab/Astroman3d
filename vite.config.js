import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2020',
    rollupOptions: {
      output: {
        // three.js in its own long-lived chunk: a change to the scene code doesn't make returning visitors
        // download the 3D library again, and the page's own code stays small enough to paint immediately
        manualChunks(id) {
          if (id.includes('node_modules/three/')) return 'three';
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler') || id.includes('node_modules/@remix-run') || id.includes('node_modules/react-router')) return 'react';
        },
      },
    },
    // the three.js chunk is one cacheable file by design
    chunkSizeWarningLimit: 700,
  },
});
