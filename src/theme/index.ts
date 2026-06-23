import { createTheme } from '@mui/material/styles'

/**
 * MUI theme configured for RTL Persian language.
 * All spacing, typography, and colors are set here.
 */
export const theme = createTheme({
  direction: 'rtl',
  typography: {
    fontFamily: '"Vazirmatn", "Tahoma", "Arial", sans-serif',
    fontSize: 14,
    h1: { fontWeight: 700 },
    h2: { fontWeight: 700 },
    h3: { fontWeight: 600 },
    h4: { fontWeight: 600 },
    h5: { fontWeight: 600 },
    h6: { fontWeight: 600 },
    button: {
      fontFamily: '"Vazirmatn", "Tahoma", "Arial", sans-serif',
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
          boxShadow: '0 2px 12px rgba(0,0,0,0.08)'
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
    }
  }
})
