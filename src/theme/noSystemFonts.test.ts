import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { FONT_MONO, FONT_SANS } from './index'

/**
 * Nothing the app renders may depend on a font that lives on the tablet.
 *
 * The web panel and this app hit the same defect from opposite ends. There, `'Vazirmatn Persian'`
 * carried a `unicode-range` and handed every Latin glyph to `'Segoe UI'`. Here, the stack ended in
 * `"Tahoma", "Arial"` — neither of which exists on Android, so the device fell through again to
 * whatever its vendor ships — and identifiers were set in the bare `monospace` keyword, which is
 * whatever the *browser* has configured as its fixed-width font, not a constant.
 *
 * None of that shows up in a diff. `Tahoma` at the end of a stack reads as politeness. So the
 * suite checks instead: every `fontFamily` in the source must resolve to a font this repository
 * ships, and Vazirmatn is bundled from `node_modules`, emitted into the build and precached by the
 * service worker, so it is present offline on first launch.
 *
 * A trailing generic keyword is allowed — it is reachable only if the bundled woff2 fails to load,
 * and a stack with no fallback at all is not a thing a browser offers.
 */

/** Read off the device rather than shipped by us. `ui-*` and `system-ui` are the same defect in standards clothing. */
const SYSTEM_FONTS = [
  'consolas', 'segoe ui', 'tahoma', 'arial', 'helvetica', 'menlo', 'monaco',
  'sfmono', 'liberation mono', 'courier', 'verdana', 'ui-monospace', 'ui-sans-serif',
  'ui-serif', 'system-ui', '-apple-system', 'blinkmacsystemfont', 'roboto', 'droid sans'
]

/** Legal as the last resort in a stack, never as the first entry. */
const GENERIC_KEYWORDS = ['monospace', 'sans-serif', 'serif', 'cursive', 'fantasy', 'inherit']

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.css', '.html']

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (SOURCE_EXTENSIONS.includes(extname(name))) out.push(full)
  }
  return out
}

/** Comments say *why* these fonts are banned and would otherwise trip the scan on the word. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
}

describe('no system fonts', () => {
  it('no source file names a font that comes from the device', () => {
    const offences: string[] = []

    for (const file of [...sourceFiles('src'), 'index.html']) {
      const content = stripComments(readFileSync(file, 'utf8'))
      const declarations = content.matchAll(/font-?[Ff]amily\s*[:=]\s*([^,;\n}]*(?:,[^;\n}]*)*)/g)
      for (const match of declarations) {
        const stack = match[1].toLowerCase()
        for (const banned of SYSTEM_FONTS) {
          if (stack.includes(banned)) {
            offences.push(`${file} → ${match[1].trim()}  (names "${banned}")`)
          }
        }
        // A generic keyword is fine at the *end* of a stack and is a device dependency at the
        // front, where nothing we ship precedes it. `fontFamily: 'monospace'` was exactly that:
        // every identifier on the fill page drawn in whatever the browser calls fixed-width.
        const first = stack.split(',')[0].replace(/['"`]/g, '').trim()
        if (GENERIC_KEYWORDS.includes(first)) {
          offences.push(`${file} → ${match[1].trim()}  (starts at the generic "${first}")`)
        }
      }
    }

    expect(offences, 'use FONT_SANS / FONT_MONO from @/theme instead').toEqual([])
  })

  it('the exported stacks end at a font this repository ships', () => {
    expect(FONT_SANS).toBe('"Vazirmatn", sans-serif')
    expect(FONT_MONO).toBe('"Vazirmatn", monospace')
  })

  it('vazirmatn is a real dependency, not a font the device is assumed to have', () => {
    // The stacks above are only honest if the font is actually in the build. It arrives through
    // this import in main.tsx; without it every stack silently falls to the generic keyword and
    // the app looks different on every device while the tests still pass.
    const main = readFileSync('src/main.tsx', 'utf8')
    expect(main).toContain("import 'vazirmatn/Vazirmatn-font-face.css'")

    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(pkg.dependencies.vazirmatn ?? pkg.devDependencies?.vazirmatn).toBeTruthy()
  })

  it('the font files it ships are local, not fetched from a font host', () => {
    // One CDN url() here would make the app's appearance depend on the plant having internet —
    // in an application whose entire premise is that it does not.
    const faceCss = readFileSync('node_modules/vazirmatn/Vazirmatn-font-face.css', 'utf8')
    const urls = [...faceCss.matchAll(/url\(['"]?([^'")]+)/g)].map(m => m[1])

    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      expect(url, `${url} is remote`).not.toMatch(/^https?:/)
    }
  })

  it('the service worker precaches fonts, so the first offline launch has them', () => {
    // Bundling is not enough: a tablet that installs the PWA and goes offline before the font is
    // requested would render everything in a device font until it next reconnected.
    const viteConfig = readFileSync('vite.config.ts', 'utf8')
    const globLine = viteConfig.match(/globPatterns:\s*\[([^\]]*)\]/)?.[1] ?? ''

    expect(globLine).toContain('woff2')
  })
})
