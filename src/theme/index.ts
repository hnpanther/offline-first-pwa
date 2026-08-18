import { createTheme } from '@mui/material/styles'

/**
 * The only two font stacks in the app, and neither names a font from the device.
 *
 * Tahoma and Arial used to sit behind Vazirmatn here. A stack is resolved **per glyph**, so
 * anything Vazirmatn does not cover was drawn by the tablet — and on Android neither Tahoma nor
 * Arial exists, so it fell through again to whatever that vendor ships. The same page therefore
 * looked different on two tablets with identical code. Vazirmatn is bundled from node_modules,
 * emitted into the build and precached by the service worker, so it is always there.
 *
 * `MONO` is for identifiers — tag ids, asset codes, sub-function codes. It was the bare
 * `monospace` keyword, which resolves to whatever the *browser* names as its fixed-width font;
 * that is a per-device setting, not a constant. Vazirmatn is not a monospace face, so
 * `tabular-nums` (applied where these are used) is what keeps digits in a column.
 *
 * The generic keyword at the end is a last resort, not a fallback in use: it is reachable only
 * if the bundled woff2 fails to load. `noSystemFonts.test.ts` fails the suite if a named system
 * font comes back.
 */
export const FONT_SANS = '"Vazirmatn", sans-serif'
export const FONT_MONO = '"Vazirmatn", monospace'

/**
 * MUI theme configured for RTL Persian language.
 * All spacing, typography, and colors are set here.
 */
export const theme = createTheme({
  direction: 'rtl',
  typography: {
    fontFamily: FONT_SANS,
    fontSize: 14,
    h1: { fontWeight: 700 },
    h2: { fontWeight: 700 },
    h3: { fontWeight: 600 },
    h4: { fontWeight: 600 },
    h5: { fontWeight: 600 },
    h6: { fontWeight: 600 },
    button: {
      fontFamily: FONT_SANS,
      fontWeight: 500
    }
  },
  palette: {
    primary: {
      main: '#1565C0',
      light: '#5E92F3',
      dark: '#003c8f',
      contrastText: '#ffffff'
    },
    secondary: {
      main: '#00897B',
      light: '#4ebaaa',
      dark: '#005b4f',
      contrastText: '#ffffff'
    },
    error: {
      main: '#C62828'
    },
    warning: {
      main: '#E65100'
    },
    success: {
      main: '#2E7D32'
    },
    background: {
      default: '#F5F7FA',
      paper: '#FFFFFF'
    }
  },
  shape: {
    borderRadius: 10
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          padding: '10px 20px',
          fontSize: '0.95rem',
          minHeight: 44 // touch-friendly minimum
        },
        sizeLarge: {
          minHeight: 52,
          fontSize: '1rem'
        }
      }
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiInputBase-root': {
            minHeight: 48
          }
        }
      }
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 12,
          boxShadow: '0 1px 6px rgba(0,0,0,0.07)',
          transition: 'box-shadow 0.2s'
        }
      }
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 6
        }
      }
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          minHeight: 48
        }
      }
    },
    MuiAccordion: {
      styleOverrides: {
        root: {
          borderRadius: '10px !important',
          '&:before': { display: 'none' },
          boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
          marginBottom: 8
        }
      }
    },
    MuiAccordionSummary: {
      styleOverrides: {
        root: {
          minHeight: 56,
          borderRadius: 10,
          '&.Mui-expanded': { minHeight: 56 }
        }
      }
    },
    MuiTab: {
      styleOverrides: {
        root: {
          minHeight: 48,
          fontSize: '0.9rem',
          fontWeight: 500
        }
      }
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          borderRadius: 0
        }
      }
    }
  }
})
