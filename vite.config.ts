import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import fs from 'fs'

function loadMkcertHttps(certDir: string) {
  const certFile = path.join(certDir, 'cert.pem')
  const keyFile = path.join(certDir, 'key.pem')
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) return null
  return {
    cert: fs.readFileSync(certFile),
    key: fs.readFileSync(keyFile)
  }
}

export default defineConfig(({ mode }) => {
  const mobileDev = mode === 'mobile'
  const certDir = path.resolve(__dirname, 'certs')
  const mkcertHttps = loadMkcertHttps(certDir)
  const useTrustedCert = mkcertHttps != null

  if (mobileDev) {
    if (useTrustedCert) {
      console.log('\n[mobile] HTTPS: mkcert (certs/cert.pem)\n')
    } else {
      console.warn(
        '\n[mobile] WARNING: No certs/cert.pem — run: npm run setup:mkcert\n'
      )
    }
    if (process.argv.includes('dev')) {
      console.warn(
        '[mobile] Dev server (5173) is NOT reliable offline after PWA install.\n' +
          '         For offline: npm run build:mobile && npm run preview:mobile (port 4173)\n'
      )
    }
  }

  return {
    plugins: [
      ...(mobileDev && !useTrustedCert ? [basicSsl()] : []),
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg', 'icons/icon.svg', 'icons/icon-maskable.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'],
        manifest: {
          name: 'Mobile-First Field Data Collection System',
          short_name: 'MFDCS',
          description: 'اپلیکیشن ثبت داده‌های میدانی با پشتیبانی آفلاین',
          theme_color: '#1976d2',
          background_color: '#ffffff',
          display: 'standalone',
          orientation: 'any',
          lang: 'fa',
          dir: 'rtl',
          start_url: '/',
          scope: '/',
          id: '/',
          // `any` and `maskable` are deliberately DIFFERENT files. Android applies its
          // own mask (circle / squircle / teardrop) and crops everything outside the
          // central 80% safe zone, so an icon whose artwork reaches the edges gets its
          // corners eaten. icon-maskable-512.png carries the same artwork scaled into
          // that safe zone with the brand colour bleeding to all four edges.
          // Regenerate both with `npm run icons` after editing public/icons/*.svg.
          icons: [
            {
              src: 'icons/icon-192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any'
            },
            {
              src: 'icons/icon-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any'
            },
            {
              src: 'icons/icon-maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable'
            }
          ]
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,webmanifest}'],
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//],
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          skipWaiting: true
        },
        devOptions: {
          enabled: mobileDev,
          navigateFallback: '/index.html'
        }
      })
    ],
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-mui': [
              '@mui/material',
              '@mui/icons-material',
              '@emotion/react',
              '@emotion/styled',
              '@emotion/cache'
            ],
            'vendor-storage': ['dexie', 'zustand'],
            'vendor-forms': ['react-hook-form', 'zod', '@hookform/resolvers']
          }
        }
      }
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src')
      }
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts']
    },
    server: {
      host: '0.0.0.0',
      port: 5173,
      ...(mobileDev
        ? {
            https: mkcertHttps ?? true,
            proxy: {
              '/api': {
                target: 'http://127.0.0.1:8081',
                changeOrigin: true
              }
            }
          }
        : {})
    },
    preview: {
      host: '0.0.0.0',
      port: 4173,
      ...(mobileDev
        ? {
            https: mkcertHttps ?? true,
            proxy: {
              '/api': {
                target: 'http://127.0.0.1:8081',
                changeOrigin: true
              }
            }
          }
        : {})
    }
  }
})
