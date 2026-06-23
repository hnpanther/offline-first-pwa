import {
  Box,
  Button,
  Card,
  CardContent,
  Typography,
  Alert,
  Chip,
  TextField,
  Divider,
  CircularProgress
} from '@mui/material'
import NfcIcon from '@mui/icons-material/Nfc'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import ErrorIcon from '@mui/icons-material/Error'
import EditIcon from '@mui/icons-material/Edit'
import { useState } from 'react'
import { useNFC } from '@/hooks/useNFC'
import { t } from '@/i18n'

interface NFCReaderProps {
  onTagConfirmed: (tagId: string) => void
  allowManualEntry?: boolean
}

export function NFCReader({ onTagConfirmed, allowManualEntry = false }: NFCReaderProps) {
  const { isScanning, isSupported, lastTag, error, startScan, stopScan } = useNFC()
  const [manualId, setManualId] = useState('')

  const handleManualSubmit = () => {
    const trimmed = manualId.trim()
    if (trimmed) onTagConfirmed(trimmed)
  }

  const handleTagConfirm = () => {
    if (lastTag?.serialNumber) onTagConfirmed(lastTag.serialNumber)
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* NFC scan area */}
      <Card>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
            <NfcIcon color="primary" />
            <Typography variant="h6">{t.nfc.title}</Typography>
          </Box>

          {!isSupported && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              {t.nfc.notSupported}
            </Alert>
          )}

          {error && (
            <Alert severity="error" icon={<ErrorIcon />} sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {isSupported && (
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                py: 4,
                gap: 2,
                bgcolor: isScanning ? 'primary.light' : 'grey.100',
                borderRadius: 2,
                transition: 'background-color 0.3s',
                cursor: isScanning ? 'default' : 'pointer',
                border: '2px dashed',
                borderColor: isScanning ? 'primary.main' : 'grey.300'
              }}
              onClick={isScanning ? undefined : () => void startScan()}
            >
              {isScanning ? (
                <>
                  <Box sx={{ position: 'relative', display: 'inline-flex' }}>
                    <CircularProgress size={64} sx={{ color: 'white' }} />
                    <Box
                      sx={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}
                    >
                      <NfcIcon sx={{ fontSize: 32, color: 'white' }} />
                    </Box>
                  </Box>
                  <Typography color="white" fontWeight={600}>
                    {t.nfc.waitingForTag}
                  </Typography>
                </>
              ) : lastTag ? (
                <>
                  <CheckCircleIcon sx={{ fontSize: 64, color: 'success.main' }} />
                  <Typography fontWeight={600} color="success.main">
                    {t.nfc.tagDetected}
                  </Typography>
                  <Chip
                    label={`${t.nfc.serialNumber}: ${lastTag.serialNumber}`}
                    variant="outlined"
                    color="success"
                  />
                </>
              ) : (
                <>
                  <NfcIcon sx={{ fontSize: 64, color: 'grey.400' }} />
                  <Typography color="text.secondary">
                    {t.nfc.startScan}
                  </Typography>
                </>
              )}
            </Box>
          )}

          <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
            {isSupported && !isScanning && (
              <Button
                variant="contained"
                startIcon={<NfcIcon />}
                onClick={() => void startScan()}
                fullWidth
              >
                {t.nfc.startScan}
              </Button>
            )}
            {isScanning && (
              <Button variant="outlined" color="error" onClick={stopScan} fullWidth>
                {t.nfc.stopScan}
              </Button>
            )}
            {lastTag && !isScanning && (
              <Button
                variant="contained"
                color="success"
                onClick={handleTagConfirm}
                fullWidth
              >
                {t.nfc.continueWithTag}
              </Button>
            )}
          </Box>
        </CardContent>
      </Card>

      {/* Manual entry — only shown if allowed in settings */}
      {allowManualEntry ? (
        <>
          <Divider>
            <Typography variant="body2" color="text.secondary">یا</Typography>
          </Divider>
          <Card variant="outlined">
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                <EditIcon fontSize="small" color="action" />
                <Typography variant="subtitle2" color="text.secondary">
                  {t.nfc.manualEntry}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', gap: 1 }}>
                <TextField
                  size="small"
                  fullWidth
                  placeholder="شناسه تگ را وارد کنید..."
                  value={manualId}
                  onChange={e => setManualId(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleManualSubmit()}
                  dir="ltr"
                />
                <Button
                  variant="outlined"
                  onClick={handleManualSubmit}
                  disabled={!manualId.trim()}
                  sx={{ minWidth: 80 }}
                >
                  تأیید
                </Button>
              </Box>
            </CardContent>
          </Card>
        </>
      ) : (
        !isSupported && (
          <Alert severity="error" icon={<ErrorIcon />}>
            {t.nfc.manualEntryDisabled}
          </Alert>
        )
      )}
    </Box>
  )
}
