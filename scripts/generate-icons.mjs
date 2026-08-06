/**
 * Rasterises the app icon into every PNG size the PWA manifest and the backend need.
 *
 * Sources of truth (both hand-edited SVGs, both committed):
 *   public/icons/icon.svg           — full-bleed artwork with rounded corners, used
 *                                     wherever the icon is shown unmasked.
 *   public/icons/icon-maskable.svg  — same artwork scaled into Android's safe zone,
 *                                     used for `purpose: "maskable"`.
 *
 * Run `npm run icons` after editing either SVG, then commit the regenerated PNGs.
 * The build does NOT run this — PNGs are checked in so a plain `npm run build`
 * never depends on sharp being installable on the build machine.
 */
import sharp from 'sharp'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const icons = path.join(root, 'public', 'icons')

/** [source svg, output png, pixel size] */
const targets = [
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['icon.svg', 'apple-touch-icon.png', 180],
  ['icon-maskable.svg', 'icon-maskable-512.png', 512]
]

// The Spring app serves its favicon from its own static folder, so the generated
// PNG is copied there too. Keeping one source SVG for both apps is the whole point.
const backendFavicon = process.env.BACKEND_STATIC_DIR
  ? path.join(process.env.BACKEND_STATIC_DIR, 'favicon.png')
  : path.resolve(
      root,
      '..',
      '..',
      'JavaProject',
      'backend-offline-first',
      'src',
      'main',
      'resources',
      'static',
      'favicon.png'
    )

for (const [src, out, size] of targets) {
  const svg = await fs.readFile(path.join(icons, src))
  await sharp(svg, { density: 384 }).resize(size, size).png().toFile(path.join(icons, out))
  console.log(`✓ ${out} (${size}×${size}) from ${src}`)
}

// 180px is a good favicon source: browsers downscale it for the tab, and it stays
// crisp on high-DPI displays and as a bookmark/home-screen icon.
try {
  const svg = await fs.readFile(path.join(icons, 'icon.svg'))
  await sharp(svg, { density: 384 }).resize(180, 180).png().toFile(backendFavicon)
  console.log(`✓ ${backendFavicon} (180×180) from icon.svg`)
} catch (err) {
  console.warn(
    `! Skipped the backend favicon (${backendFavicon}): ${err.message}\n` +
      '  Set BACKEND_STATIC_DIR if the backend repo lives elsewhere.'
  )
}
