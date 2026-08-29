import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // 5173 is Vite's default and collides with other projects on this
    // machine. On Windows `localhost` resolves to ::1 first, so a collision
    // silently sends the browser to whichever app grabbed the IPv6 socket.
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
});
