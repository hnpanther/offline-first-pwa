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
  const mkcertHttps = mobileDev ? loadMkcertHttps(certDir) : null
  const useTrustedCert = mkcertHttps != null

  return {
    plugins: [
      ...(mobileDev && !useTrustedCert ? [basicSsl()] : []),
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'],
        manifest: {
          name: 'سیستم جمع‌آوری اطلاعات',
          short_name: 'داده‌برداری',
          description: 'اپلیکیشن جمع‌آوری اطلاعات با پشتیبانی آفلاین',
          theme_color: '#1976d2',
          background_color: '#ffffff',
          display: 'standalone',
          orientation: 'any',
          lang: 'fa',
          dir: 'rtl',
          start_url: '/',
          scope: '/',
          id: '/',
          icons: [
            {
              src: 'icons/icon-192.png',
              sizes: '192x192',
              type: 'image/png'
            },
            {
              src: 'icons/icon-512.png',
              sizes: '512x512',
              type: 'image/png'
            },
            {
              src: 'icons/icon-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any maskable'
            }
          ]
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//]
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
      port: 4173
    }
  }
})
