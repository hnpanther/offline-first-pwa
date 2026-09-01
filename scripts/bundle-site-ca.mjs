/**
 * Copies this site's certificate authority into the Android project, so the packaged app trusts
 * the nginx that serves the PWA.
 *
 * <h2>Why the app needs this and a browser does not</h2>
 *
 * The PWA is served over HTTPS with a certificate this site issued itself. A browser can be
 * taught to trust it by installing the CA on the device. An Android app cannot: since API 24 an
 * app trusts only the *system* CA store, and a CA installed by hand lands in the *user* store,
 * which apps ignore unless they opt in. Without this file every request from the app fails with
 * CertPathValidatorException — which reaches the operator as "could not reach the server",
 * indistinguishable from the network being down. It is a long way to chase from that symptom.
 *
 * Bundling the CA also removes the per-tablet install step: a device needs the APK and nothing
 * else.
 *
 * <h2>Why it is copied on every build rather than committed</h2>
 *
 * `certs/` is gitignored because it is machine- and site-specific, and the bundled copy is no
 * different. Committed, it would be a second copy that silently goes stale: regenerate the CA,
 * rebuild, and the APK would still carry the old one — the build succeeds, the app installs, and
 * only a login attempt reveals it. Copying it as part of the build means the two cannot disagree.
 *
 * The certificate is public — it is the CA's certificate, not its key — so bundling it discloses
 * nothing. The key never leaves `certs/`.
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'certs', 'rootCA.crt')
const target = path.join(root, 'android', 'app', 'src', 'main', 'res', 'raw', 'plant_ca.crt')

try {
  await fs.access(source)
} catch {
  // Failing here is the point. Building without it produces an APK that installs, opens, and
  // then cannot reach the server — the most expensive way to find out.
  console.error(
    `Missing ${path.relative(root, source)}.\n` +
    'The packaged app bundles this site\'s CA so it trusts the nginx serving the PWA.\n' +
    'Create it with:  npm run setup:mkcert -- -Ip <server-ip>'
  )
  process.exit(1)
}

await fs.mkdir(path.dirname(target), { recursive: true })
await fs.copyFile(source, target)
console.log(`Bundled ${path.relative(root, source)} as res/raw/plant_ca.crt`)
