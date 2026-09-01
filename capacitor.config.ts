import type { CapacitorConfig } from '@capacitor/cli';

/**
 * `cap sync` compiles this into `android/app/src/main/assets/capacitor.config.json`, so every
 * value here is baked into the APK — nothing below can be changed on a device.
 *
 * To inspect a misbehaving tablet, add `android: { webContentsDebuggingEnabled: true }` and
 * rebuild; the WebView then appears in `chrome://inspect`. Remove it before that build goes near a
 * tablet in service, and never commit it enabled — it produces no symptom on a working device, so
 * nothing will remind you. Do **not** reach for `debuggable` in `app/build.gradle` instead: that
 * additionally attaches a process debugger with the session JWT and every unsynced reading behind
 * it. Both are explained in docs/apk.md §3.
 */
const config: CapacitorConfig = {
  appId: 'com.hnp.mfdcs',
  appName: 'MFDCS',
  webDir: 'dist'
};

export default config;
