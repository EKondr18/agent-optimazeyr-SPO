import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({ include: ['buffer', 'stream', 'assert', 'util', 'process'] }),
  ],
  base: process.env.VITE_BASE_URL || '/',
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      output: {
        // Libraries that rarely change get their own files, so a redeploy of the
        // app code doesn't make every browser download react and antd again.
        // Plotly and xlsx are loaded on demand and form their own chunks.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
          if (/node_modules\/(antd|@ant-design|@rc-component|rc-[^/]+)\//.test(id)) return 'antd';
          return undefined;
        },
      },
    },
  },
})
