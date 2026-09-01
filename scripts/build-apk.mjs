/**
 * Runs the Gradle wrapper for the Android project, and reports honestly when it fails.
 *
 * <h2>Why this is not one line in package.json</h2>
 *
 * It was, and it was wrong twice over. `cd android && gradlew.bat assembleDebug` picks the wrong
 * wrapper on Linux, and on Windows it depends on the shell npm happens to hand the script to —
 * which is not the shell you are typing in. It printed
 *
 *     'gradlew.bat' is not recognized as an internal or external command
 *
 * and **still exited 0**, so `npm run build:apk` reported success while producing no APK. Anyone
 * reading the tail of that output would have copied a stale file to the tablets.
 *
 * Two rules, both of which the shell one-liner broke:
 *
 *   1. Pick the wrapper from `process.platform`, not from whatever shell is in the way.
 *   2. Exit with Gradle's own status. A build script that swallows a failure is worse than no
 *      build script, because it converts a loud problem into a silent one.
 *
 * <h2>And why Windows still needs a shell here</h2>
 *
 * Node 20 stopped spawning `.bat` and `.cmd` files directly (CVE-2024-27980) — without a shell it
 * fails with a bare `EINVAL`, which says nothing at all about the cause. So on Windows the wrapper
 * goes through `cmd.exe`. Once a shell is doing the word-splitting the path has to be quoted here,
 * and the task name has to be checked rather than concatenated: it comes from `argv`, and this is
 * a command line being assembled.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const android = path.join(root, 'android')
const wrapper = path.join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')
const task = process.argv[2] ?? 'assembleDebug'
if (!/^[A-Za-z0-9:._-]+$/.test(task)) {
  // On Windows this string is spliced into a shell command. A Gradle task name has no reason to
  // contain anything else, so rejecting the rest costs nothing and closes the injection.
  console.error(`Not a Gradle task name: ${task}`)
  process.exit(1)
}

// A release task would succeed and produce nothing installable. `buildTypes.release` has no
// `signingConfig` — this project has no release keystore, deliberately (docs/apk.md section 3) —
// and Gradle's answer to that is not an error: it writes `app-release-unsigned.apk`, reports
// BUILD SUCCESSFUL, and leaves a file that every device refuses with a message that never
// mentions signing. That is the exact failure this script exists to prevent, arriving by a
// different door, so it is refused here rather than explained afterwards.
if (/release/i.test(task)) {
  console.error(
    `Refusing to run "${task}": this project has no release signing key.\n\n` +
    'Gradle would still report success and write an unsigned APK that installs nowhere.\n' +
    'The fleet is signed with the local debug key on purpose — see docs/apk.md section 3,\n' +
    '"Debug, not release" and "Why this is not a release build".\n\n' +
    'If you are deliberately moving to a signed release build, add a signingConfig first;\n' +
    'that decision is documented in the same section, including what it costs every tablet.'
  )
  process.exit(1)
}

if (!fs.existsSync(wrapper)) {
  console.error(
    `No Gradle wrapper at ${path.relative(root, wrapper)}.\n` +
    'The Android platform is missing or incomplete — see docs/apk.md section 10.'
  )
  process.exit(1)
}

const windows = process.platform === 'win32'
// One command string rather than a command plus args: with `shell: true` Node concatenates them
// anyway, and doing it explicitly is both what Node now asks for and clearer about the quoting.
const result = windows
  ? spawnSync(`"${wrapper}" ${task}`, { cwd: android, stdio: 'inherit', shell: true })
  : spawnSync(wrapper, [task], { cwd: android, stdio: 'inherit' })

if (result.error) {
  console.error(`Could not run the Gradle wrapper: ${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) process.exit(result.status ?? 1)

// Named rather than left for the reader to find: the path is four directories deep and the debug
// and release builds sit next to each other.
const apk = path.join(android, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
if (fs.existsSync(apk)) {
  const mb = (fs.statSync(apk).size / 1024 / 1024).toFixed(1)
  console.log(`\nAPK: ${path.relative(root, apk)}  (${mb} MB)`)
}
