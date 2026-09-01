/**
 * Rasterises the Android launcher icon and splash screen from the app's own icon SVGs.
 *
 * <h2>Why not just let the template's icons stand</h2>
 *
 * `npx cap add android` scaffolds a generic Capacitor icon and splash. Left alone, the packaged
 * app is the only place in the whole system that does not carry the project's mark — on a tablet
 * whose home screen may hold two or three plant apps, that is the one place the icon actually
 * has a job to do.
 *
 * <h2>One source, as everywhere else</h2>
 *
 * The artwork comes from the same two committed SVGs `npm run icons` uses:
 *
 *   public/icons/icon.svg           full-bleed, rounded corners  -> the legacy launcher icon
 *   public/icons/icon-maskable.svg  artwork inside the safe zone -> the adaptive foreground
 *
 * The maskable variant already exists because a PWA icon on Android faces the same problem an
 * adaptive icon does: the launcher applies its own mask and crops whatever falls outside. Its
 * artwork is scaled to survive that crop, which is exactly what an adaptive foreground layer
 * needs, so the same file serves both and there is nothing new to keep in step.
 *
 * The brand colour and the foreground layer are *read out of* those SVGs rather than repeated
 * here. Both reads throw if the shape they expect is gone, because the silent failures are the
 * bad ones: a foreground that kept its background rect renders as a solid blue square, and a
 * hardcoded colour that drifted from the artwork shows as a seam around the icon on exactly the
 * launchers that mask it. Neither looks like an error; both look like a bad icon.
 *
 * <h2>Running it</h2>
 *
 *   npm run icons:apk
 *
 * After editing either SVG, and after `npx cap add android` ever regenerates the platform.
 * Not part of the build: the generated PNGs live under android/, which is committed, and the
 * build must not depend on sharp being installable on whatever machine runs it — the same
 * reasoning as scripts/generate-icons.mjs.
 */
import sharp from 'sharp'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const icons = path.join(root, 'public', 'icons')
const res = path.join(root, 'android', 'app', 'src', 'main', 'res')

/** Launcher icon, 48dp, per density. */
const LEGACY = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192]
]

/**
 * Adaptive foreground layer, 108dp per density.
 *
 * The layer is 108dp but only its central 72dp is guaranteed to be visible — the launcher's mask
 * eats the rest, and the outer band is what it parallax-scrolls into. The maskable SVG's artwork
 * reaches about 65% of the radius, just inside the 66.7% the mask guarantees.
 */
const ADAPTIVE = [
  ['mdpi', 108],
  ['hdpi', 162],
  ['xhdpi', 216],
  ['xxhdpi', 324],
  ['xxxhdpi', 432]
]

/** Splash, portrait; landscape is the same list with the two swapped. */
const SPLASH = [
  ['mdpi', 320, 480],
  ['hdpi', 480, 800],
  ['xhdpi', 720, 1280],
  ['xxhdpi', 960, 1600],
  ['xxxhdpi', 1280, 1920]
]

const read = name => fs.readFile(path.join(icons, name), 'utf-8')

/**
 * The brand colour, taken from the icon's own background rather than written down twice.
 *
 * A colour that drifted from the artwork does not fail: it shows as a seam around the icon on
 * every launcher that masks it, which reads as sloppy artwork rather than as a stale constant.
 */
function brandColour(svg) {
  const match = svg.match(/<rect[^>]*width="512"[^>]*fill="(#[0-9a-fA-F]{6})"/)
  if (!match) {
    throw new Error(
      'Could not find the full-canvas background rect in icon.svg. If the artwork changed, ' +
      'update brandColour() to match — do not hardcode the colour here.'
    )
  }
  return match[1]
}

/**
 * The maskable artwork with its background removed, for use as an adaptive foreground.
 *
 * The background belongs to the *background* layer of an adaptive icon; left in the foreground it
 * covers that layer entirely, and the icon renders as a solid coloured square with the artwork
 * lost inside it. That failure produces a perfectly valid PNG, so it has to be caught here.
 */
function foregroundSvg(maskable) {
  const withoutBackground = maskable.replace(/<rect\s+width="512"\s+height="512"\s+fill="#[0-9a-fA-F]{6}"\s*\/>\s*/, '')
  if (withoutBackground === maskable) {
    throw new Error(
      'Could not strip the background rect from icon-maskable.svg. Leaving it in would render ' +
      'the adaptive foreground as a solid square, so this is a hard failure rather than a warning.'
    )
  }
  return withoutBackground
}

/** A circular cut-out of the icon, for launchers that ask for `ic_launcher_round`. */
function circleMask(size) {
  const r = size / 2
  return Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${r}" fill="#fff"/></svg>`
  )
}

async function write(dir, file, image) {
  await fs.mkdir(path.join(res, dir), { recursive: true })
  await image.png().toFile(path.join(res, dir, file))
}

async function main() {
  const iconSvg = await read('icon.svg')
  const maskableSvg = await read('icon-maskable.svg')
  const colour = brandColour(iconSvg)
  const icon = Buffer.from(iconSvg)
  const foreground = Buffer.from(foregroundSvg(maskableSvg))

  for (const [density, size] of LEGACY) {
    await write(`mipmap-${density}`, 'ic_launcher.png', sharp(icon).resize(size, size))
    await write(
      `mipmap-${density}`,
      'ic_launcher_round.png',
      sharp(icon)
        .resize(size, size)
        .composite([{ input: circleMask(size), blend: 'dest-in' }])
    )
  }

  for (const [density, size] of ADAPTIVE) {
    await write(
      `mipmap-${density}`,
      'ic_launcher_foreground.png',
      sharp(foreground).resize(size, size)
    )
  }

  // The adaptive icon's background layer. The template points it at a colour resource and ships
  // white, which shows as a white ring around the artwork on any launcher that masks the icon.
  await fs.writeFile(
    path.join(res, 'values', 'ic_launcher_background.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<resources>\n' +
      `    <color name="ic_launcher_background">${colour}</color>\n` +
      '</resources>\n',
    'utf-8'
  )

  // The template also ships a vector foreground under drawable-v24, which wins over the PNG on
  // API 24+ — that is every device this app runs on, so the generated foreground would never be
  // seen. Removing it is what makes the rest of this script take effect.
  await fs.rm(path.join(res, 'drawable-v24', 'ic_launcher_foreground.xml'), { force: true })
  // Same story for the drawable-level background: an unused duplicate of the colour above, and
  // one more place for the brand colour to go stale.
  await fs.rm(path.join(res, 'drawable', 'ic_launcher_background.xml'), { force: true })

  await splashes(colour, icon)

  console.log(`Android icons and splash written from icon.svg (${colour}).`)
}

/**
 * The launch screen: brand background, icon centred.
 *
 * Generated per density *and* per orientation because the theme sets it as a plain window
 * background, which stretches to fill. One bitmap for both orientations would show the icon
 * squashed on whichever one it was not drawn for — briefly, on every single launch.
 */
async function splashes(colour, icon) {
  const background = { r: parseInt(colour.slice(1, 3), 16), g: parseInt(colour.slice(3, 5), 16), b: parseInt(colour.slice(5, 7), 16) }

  const one = async (dir, width, height) => {
    const size = Math.round(Math.min(width, height) * 0.3)
    const logo = await sharp(icon).resize(size, size).png().toBuffer()
    await write(
      dir,
      'splash.png',
      sharp({ create: { width, height, channels: 4, background } }).composite([{ input: logo, gravity: 'centre' }])
    )
  }

  for (const [density, width, height] of SPLASH) {
    await one(`drawable-port-${density}`, width, height)
    await one(`drawable-land-${density}`, height, width)
  }
  // The density-less fallback, for a configuration none of the above matches.
  await one('drawable', 720, 1280)
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
