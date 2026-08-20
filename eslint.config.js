// @ts-check
import js from '@eslint/js'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

/**
 * Flat config, which is the only kind ESLint 9 reads.
 *
 * There was no config file at all: `npm run lint` failed with "ESLint couldn't find an
 * eslint.config.(js|mjs|cjs) file" on every run, so a release gate that looked present in
 * package.json had been contributing exactly nothing. The script also still carried `--ext`,
 * removed in flat config, so adding a config alone would not have been enough.
 *
 * The rule set is deliberately close to what the code already is. A first run on an untouched
 * codebase either passes or produces a wall of findings nobody triages, and the second outcome
 * is how a lint gate gets disabled again a week later. `no-unused-vars` and the hooks rules are
 * the ones that catch real defects here; stylistic opinions are left to reviewers.
 */
export default [
  {
    ignores: ['dist/**', 'dev-dist/**', 'coverage/**', 'node_modules/**', '*.config.js', '*.config.ts']
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true }
      },
      globals: {
        // Browser and worker surface this code actually uses. Listed rather than pulled from
        // `globals` so the set stays reviewable and a typo in a global name is still an error.
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        indexedDB: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        DOMException: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        EventTarget: 'readonly',
        MessageEvent: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        queueMicrotask: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        console: 'readonly',
        crypto: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        performance: 'readonly',
        Image: 'readonly',
        ImageData: 'readonly',
        MediaRecorder: 'readonly',
        MediaStream: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLCanvasElement: 'readonly',
        HTMLVideoElement: 'readonly',
        HTMLAudioElement: 'readonly',
        HTMLImageElement: 'readonly',
        NDEFReader: 'readonly',
        ServiceWorkerRegistration: 'readonly',
        caches: 'readonly',
        self: 'readonly',
        location: 'readonly',
        history: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        structuredClone: 'readonly',
        ResizeObserver: 'readonly',
        IntersectionObserver: 'readonly',
        MutationObserver: 'readonly',
        getComputedStyle: 'readonly',
        matchMedia: 'readonly',
        screen: 'readonly',
        DOMParser: 'readonly',
        XMLHttpRequest: 'readonly',
        WebSocket: 'readonly',
        Notification: 'readonly',
        process: 'readonly'
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,

      // TypeScript already reports undefined identifiers, with types. Leaving the base rule on
      // over .ts files only produces false positives for type-only names.
      'no-undef': 'off',

      // The base rule cannot see type positions; the TS one can.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],

      // On, because the codebase already carries `eslint-disable` comments for it — its authors
      // were writing against an enabled rule, and turning it off made those comments themselves
      // an error ("unused disable directive"). Each `any` therefore stays deliberate and
      // annotated rather than silently permitted.
      '@typescript-eslint/no-explicit-any': 'error',

      // Hooks correctness — the rules in this list that catch real defects.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': 'off',

      // `catch {}` is used deliberately in the sync and storage paths, where a failure must not
      // propagate; an empty block elsewhere is still worth flagging.
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },
  {
    // Build-time Node scripts. They are not browser code and legitimately use `process` and
    // `console`; without this they produce a wall of no-undef noise that would most likely have
    // been "fixed" by disabling the rule for everything.
    files: ['*.js', '*.mjs', 'scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        module: 'writable',
        require: 'readonly',
        exports: 'writable'
      }
    }
  },
  {
    // Test files may reach for globals the app does not, and may shadow freely.
    files: ['**/*.test.{ts,tsx}'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly'
      }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off'
    }
  }
]
