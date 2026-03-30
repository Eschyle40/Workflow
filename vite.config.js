import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Pas de manifest d'installation PWA — uniquement le cache réseau
      manifest: false,
      workbox: {
        // Précache les bundles JS/CSS/HTML (contentHash dans le nom → toujours frais)
        globPatterns: ['**/*.{js,css,html,ico,svg,png}'],
        // Runtime caching pour les assets lourds non-hachés (public/)
        runtimeCaching: [
          {
            // GLB : modèles 3D — rarement mis à jour, cache longue durée
            urlPattern: /\/models\/.*\.glb(\?.*)?$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'glb-models',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // DAE : fichiers Collada — même stratégie que les GLB
            urlPattern: /\/models\/.*\.dae(\?.*)?$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'dae-models',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // EXR : texture de ciel — même fréquence de mise à jour que les GLB
            urlPattern: /\.exr(\?.*)?$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'exr-textures',
              expiration: { maxEntries: 5, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Draco WASM : décodeur Draco (chargé une fois, ne change jamais)
            urlPattern: /\/draco\/.*\.(js|wasm)(\?.*)?$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'draco-decoder',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // pages.json : peut être mis à jour → StaleWhileRevalidate
            urlPattern: /\/models\/pages\.json(\?.*)?$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'pages-config',
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: {
          'three':        ['three'],
          'react-vendor': ['react', 'react-dom'],
          'r3f':          ['@react-three/fiber', '@react-three/drei', '@react-three/rapier'],
        },
      },
    },
  },
})
