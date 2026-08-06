import {
  Box,
  Typography,
  Card,
  CardContent,
  Button,
  Alert,
  Chip,
  Divider,
  Stack,
  CircularProgress,
  Snackbar
} from '@mui/material'
import NfcIcon from '@mui/icons-material/Nfc'
import StopIcon from '@mui/icons-material/Stop'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import LinkIcon from '@mui/icons-material/Link'
import { useCallback, useEffect, useState } from 'react'
import { useNFC } from '@/hooks/useNFC'
import { useAppStore } from '@/store'
import { resolveNfcTagId } from '@/services/nfc'
import { fetchAssetByNfcTag, saveAssetNfcSerial, type AssetLookupResponse } from '@/services/api'
import { ApiError } from '@/services/api/client'
import { t } from '@/i18n'
import type { NFCTagData } from '@/types'

/**
 * Admin-only NFC tag inspector.
 *
 * A standalone diagnostic surface: scan a tag, see exactly what came off it as
 * JSON, and — when the payload resolves to a tag id — look the asset up on the
 * server. Deliberately isolated from the log-sheet flow: it never writes to
 * IndexedDB, never queues anything for sync, and never touches a log sheet.
 *
 * Online-only by design. The point is to compare a physical tag against the
 * server's current registry, so a cached local answer would be misleading; when
 * the device is offline the scan controls are hidden rather than showing stale data.
 */

type AssetState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'found'; data: AssetLookupResponse }
  | { kind: 'notFound' }
  | { kind: 'error'; message: string }

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string }

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Box sx={{ display: 'flex', gap: 1, py: 0.6, flexWrap: 'wrap' }}>
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 130 }}>
        {label}
      </Typography>
      {/* component="div": `value` may be a Chip, and MUI's default <p> cannot legally contain one. */}
      <Typography component="div" variant="body2" fontWeight={600} sx={{ wordBreak: 'break-word' }}>
        {value}
      </Typography>
    </Box>
  )
}

export function NfcInspectPage() {
  const { isScanning, isSupported, lastTag, error: nfcError, startScan, stopScan } = useNFC()
  const isOnline = useAppStore(s => s.isOnline)
  const setLastScannedTag = useAppStore(s => s.setLastScannedTag)
  const setNFCError = useAppStore(s => s.setNFCError)

  const [tag, setTag] = useState<NFCTagData | null>(null)
  const [asset, setAsset] = useState<AssetState>({ kind: 'idle' })
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)

  // `lastScannedTag` is global Zustand state shared with the log-sheet fill page.
  // Clear it on the way in and on the way out so a tag scanned here can never be
  // mistaken for one scanned against a log sheet (and vice versa).
  useEffect(() => {
    setLastScannedTag(null)
    setNFCError(null)
    return () => {
      stopScan()
      setLastScannedTag(null)
      setNFCError(null)
    }
  }, [setLastScannedTag, setNFCError, stopScan])

  const lookupAsset = useCallback(async (tagId: string) => {
    setAsset({ kind: 'loading' })
    try {
      const result = await fetchAssetByNfcTag(tagId)
      setAsset(result ? { kind: 'found', data: result } : { kind: 'notFound' })
    } catch {
      setAsset({ kind: 'error', message: t.nfcInspect.assetError })
    }
  }, [])

  // A scan landed: freeze it locally, stop the reader, then resolve the asset.
  useEffect(() => {
    if (!lastTag) return
    setTag(lastTag)
    setSaveState({ kind: 'idle' })
    setLastScannedTag(null)
    stopScan()

    const tagId = resolveNfcTagId(lastTag)
    if (tagId) {
      void lookupAsset(tagId)
    } else {
      setAsset({ kind: 'idle' })
    }
  }, [lastTag, lookupAsset, setLastScannedTag, stopScan])

  const resolvedTagId = tag ? resolveNfcTagId(tag) : ''
  const tagJson = tag ? JSON.stringify(tag, null, 2) : ''

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(tagJson)
      setCopied(true)
    } catch {
      /* clipboard unavailable (insecure context) — silently ignore */
    }
  }

  const handleReset = () => {
    stopScan()
    setTag(null)
    setAsset({ kind: 'idle' })
    setLastScannedTag(null)
    setNFCError(null)
    setSaveState({ kind: 'idle' })
  }

  // The hardware UID off the chip (ISO 14443-3A), not the NDEF payload — this is what gets
  // written to the asset's nfcSerial so a later scan can prove it is the same physical tag.
  const scannedSerial = tag?.serialNumber?.trim() ?? ''
  const boundAsset = asset.kind === 'found' ? asset.data.entry : null
  const storedSerial = boundAsset?.nfcSerial?.trim() ?? ''
  const alreadyBound = !!scannedSerial && storedSerial === scannedSerial

  const handleSaveSerial = async () => {
    if (!boundAsset || !scannedSerial) return
    setSaveState({ kind: 'saving' })
    try {
      const updated = await saveAssetNfcSerial(boundAsset.id, scannedSerial)
      // Reflect the server's own copy so the "already bound" state below is never a guess.
      setAsset(prev =>
        prev.kind === 'found'
          ? { kind: 'found', data: { ...prev.data, entry: { ...prev.data.entry, ...updated } } }
          : prev
      )
      setSaveState({ kind: 'saved' })
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0
      setSaveState({
        kind: 'error',
        message:
          status === 403
            ? t.nfcInspect.saveForbidden
            : err instanceof ApiError && err.message
              ? err.message
              : t.nfcInspect.saveError
      })
    }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box>
        <Typography variant="h5" fontWeight={700}>
          {t.nfcInspect.title}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {t.nfcInspect.subtitle}
        </Typography>
      </Box>

      {!isOnline && <Alert severity="warning">{t.nfcInspect.onlineOnly}</Alert>}
      {isOnline && !isSupported && <Alert severity="info">{t.nfcInspect.unsupported}</Alert>}
      {nfcError && <Alert severity="error">{nfcError}</Alert>}

      {isOnline && isSupported && (
        <Card>
          <CardContent>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Button
                variant={isScanning ? 'outlined' : 'contained'}
                color={isScanning ? 'error' : 'primary'}
                startIcon={isScanning ? <StopIcon /> : <NfcIcon />}
                onClick={() => (isScanning ? stopScan() : void startScan())}
              >
                {isScanning ? t.nfcInspect.stopScan : t.nfcInspect.startScan}
              </Button>
              {(tag || asset.kind !== 'idle') && (
                <Button variant="text" startIcon={<RestartAltIcon />} onClick={handleReset}>
                  {t.nfcInspect.clear}
                </Button>
              )}
            </Stack>
            {isScanning && (
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2 }}>
                <CircularProgress size={18} />
                <Typography variant="body2" color="text.secondary">
                  {t.nfcInspect.scanning}
                </Typography>
              </Stack>
            )}
          </CardContent>
        </Card>
      )}

      {tag && (
        <Card>
          <CardContent>
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              flexWrap="wrap"
              useFlexGap
            >
              <Box>
                <Typography variant="subtitle1" fontWeight={700}>
                  {t.nfcInspect.rawTitle}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {t.nfcInspect.rawHint}
                </Typography>
              </Box>
              <Button size="small" startIcon={<ContentCopyIcon />} onClick={handleCopy}>
                {t.nfcInspect.copy}
              </Button>
            </Stack>

            <Box
              component="pre"
              dir="ltr"
              sx={{
                mt: 1.5,
                p: 1.5,
                m: 0,
                bgcolor: 'grey.900',
                color: 'grey.100',
                borderRadius: 1,
                fontSize: '0.75rem',
                lineHeight: 1.7,
                overflowX: 'auto',
                maxHeight: 360,
                textAlign: 'left'
              }}
            >
              {tagJson}
            </Box>

            <Divider sx={{ my: 2 }} />

            <Typography variant="caption" color="text.secondary">
              {t.nfcInspect.resolvedTagId}
            </Typography>
            <Box sx={{ mt: 0.5 }}>
              {resolvedTagId ? (
                <Chip label={resolvedTagId} dir="ltr" size="small" color="primary" variant="outlined" />
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {t.nfcInspect.noTagId}
                </Typography>
              )}
            </Box>
          </CardContent>
        </Card>
      )}

      {asset.kind !== 'idle' && (
        <Card>
          <CardContent>
            <Typography variant="subtitle1" fontWeight={700} gutterBottom>
              {t.nfcInspect.assetTitle}
            </Typography>

            {asset.kind === 'loading' && (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size={18} />
                <Typography variant="body2" color="text.secondary">
                  {t.nfcInspect.assetLoading}
                </Typography>
              </Stack>
            )}

            {asset.kind === 'notFound' && (
              <Alert severity="info">{t.nfcInspect.assetNotFound}</Alert>
            )}

            {asset.kind === 'error' && <Alert severity="error">{asset.message}</Alert>}

            {asset.kind === 'found' && (
              <Box>
                <InfoRow label={t.nfcInspect.assetCode} value={asset.data.entry.assetCode ?? '—'} />
                <InfoRow label={t.nfcInspect.assetName} value={asset.data.entry.assetName ?? '—'} />
                <InfoRow
                  label={t.nfcInspect.assetNameFa}
                  value={asset.data.entry.assetNameFa ?? '—'}
                />
                <InfoRow label={t.nfcInspect.nfcTagId} value={asset.data.entry.nfcTagId ?? '—'} />
                <InfoRow label={t.nfcInspect.nfcSerial} value={asset.data.entry.nfcSerial ?? '—'} />
                <InfoRow
                  label={t.nfcInspect.assetClass}
                  value={asset.data.assetClass?.name ?? '—'}
                />
                <InfoRow
                  label={t.nfcInspect.active}
                  value={
                    <Chip
                      size="small"
                      label={
                        asset.data.entry.active === false
                          ? t.nfcInspect.activeNo
                          : t.nfcInspect.activeYes
                      }
                      color={asset.data.entry.active === false ? 'default' : 'success'}
                    />
                  }
                />
                <InfoRow
                  label={t.nfcInspect.description}
                  value={asset.data.entry.description ?? '—'}
                />

                <Divider sx={{ my: 2 }} />

                {/* Bind this physical chip to the asset. */}
                <Typography variant="subtitle2" fontWeight={700} gutterBottom>
                  {t.nfcInspect.bindTitle}
                </Typography>

                {!scannedSerial ? (
                  <Alert severity="info">{t.nfcInspect.bindNoSerial}</Alert>
                ) : (
                  <Box>
                    <Stack
                      direction="row"
                      spacing={1}
                      alignItems="center"
                      flexWrap="wrap"
                      useFlexGap
                      sx={{ mb: 1 }}
                    >
                      <Typography variant="body2" color="text.secondary">
                        {t.nfcInspect.bindScanned}
                      </Typography>
                      <Chip label={scannedSerial} dir="ltr" size="small" color="primary" variant="outlined" />
                    </Stack>

                    {alreadyBound ? (
                      <Alert severity="success">{t.nfcInspect.bindAlready}</Alert>
                    ) : (
                      <>
                        {storedSerial && (
                          <Alert severity="warning" sx={{ mb: 1 }}>
                            {t.nfcInspect.bindReplaceWarning}{' '}
                            <Box component="span" dir="ltr" sx={{ fontWeight: 700 }}>
                              {storedSerial}
                            </Box>
                          </Alert>
                        )}
                        <Button
                          variant="contained"
                          startIcon={<LinkIcon />}
                          disabled={saveState.kind === 'saving'}
                          onClick={() => void handleSaveSerial()}
                        >
                          {saveState.kind === 'saving'
                            ? t.nfcInspect.bindSaving
                            : storedSerial
                              ? t.nfcInspect.bindReplace
                              : t.nfcInspect.bindSave}
                        </Button>
                      </>
                    )}

                    {saveState.kind === 'saved' && (
                      <Alert severity="success" sx={{ mt: 1 }}>
                        {t.nfcInspect.bindSaved}
                      </Alert>
                    )}
                    {saveState.kind === 'error' && (
                      <Alert severity="error" sx={{ mt: 1 }}>
                        {saveState.message}
                      </Alert>
                    )}
                  </Box>
                )}
              </Box>
            )}
          </CardContent>
        </Card>
      )}

      <Snackbar
        open={copied}
        autoHideDuration={2000}
        onClose={() => setCopied(false)}
        message={t.nfcInspect.copied}
      />
    </Box>
  )
}
