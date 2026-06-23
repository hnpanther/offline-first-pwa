/**
 * Run with: node scripts/generate-icons.js
 * Requires: npm install -g sharp  (or: npm install sharp --save-dev)
 *
 * Converts public/icons/icon.svg into the PNG icons required by the PWA manifest.
 * Run this once after cloning the project.
 */

import { createReadStream, createWriteStream } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const sizes = [192, 512]
const src = join(root, 'public', 'icons', 'icon.svg')

;(async () => {
  try {
    const sharp = (await import('sharp')).default

    for (const size of sizes) {
      const dest = join(root, 'public', 'icons', `icon-${size}.png`)
      await sharp(src)
        .resize(size, size)
        .png()
        .toFile(dest)
      console.log(`Created ${dest}`)
    }

    // Apple touch icon (180x180)
    await sharp(src)
      .resize(180, 180)
      .png()
      .toFile(join(root, 'public', 'icons', 'apple-touch-icon.png'))
    console.log('Created apple-touch-icon.png')

    console.log('Icons generated successfully.')
  } catch (err) {
    console.error('Error generating icons:', err.message)
    console.log('\nAlternative: copy any 192x192 and 512x512 PNG files to:')
    console.log('  public/icons/icon-192.png')
    console.log('  public/icons/icon-512.png')
  }
})()
