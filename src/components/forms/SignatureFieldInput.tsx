/**
 * The `signature` field on the tablet (backend roadmap §32): a pad, not a camera.
 *
 * The drawing is a PNG stored in the device's attachment table and uploaded by the ordinary
 * attachment queue after the round syncs — the same path, retries and ownership rules a photo
 * has. The form value is `{ type: 'signature', ids: [id], signedAt }`: who signed and the hash of
 * the answers it covers are stamped by the SERVER on sync (see `utils/signatureValue.ts`).
 *
 * Re-signing writes a new drawing and leaves the previous row alone: once the earlier signature
 * reached the server it is kept in the round's history, and its file must still arrive.
 * «حذف امضا» clears the value; it deletes no file for the same reason.
 *
 * Pointer events, so a finger and a pen both draw; `touch-action: none` keeps the page from
 * scrolling under the stroke. The canvas is filled white first, so the stored image reads the
 * same on any background a reviewer puts it on.
 */
import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Stack, Typography } from '@mui/material'
import { v4 as uuidv4 } from 'uuid'
import { getAttachment, saveAttachment } from '@/services/storage/attachments'
import { downloadAttachment } from '@/services/api'
import { getSessionUserId } from '@/services/auth/sessionContext'
import { t } from '@/i18n'
import { formatJalaliDateTime } from '@/utils/formatDate'
import { buildSignatureValue, signatureIdOf, signedAtOf, type SignatureValue } from '@/utils/signatureValue'
import type { SignatureScope, SignatureVerdict } from '@/utils/signatureVerdict'

interface Props {
  label: string
  value: unknown
  readOnly?: boolean
  logSheetLocalId: string
  logSheetServerId?: string
  /** Absent for a round-level question: the drawing then belongs to the sheet, not to an asset. */
  assetId?: string
  fieldKey: string
  onChange: (value: SignatureValue | null) => void
  /**
   * What the signature vouches for — from the field's definition, or the scope the server recorded
   * on the value. Decides the wording of the out-of-date warning; NONE shows none.
   */
  scope?: SignatureScope
  /** The verdict to show — see `utils/signatureVerdict.ts`. Absent means nothing is known. */
  verdict?: SignatureVerdict
  /**
   * The fingerprint of what the signature covers right now, recorded on a fresh drawing so this
   * device can tell when a covered answer changes before the server has judged it.
   */
  coveredFingerprint?: () => string
}

const WIDTH = 640
const HEIGHT = 320

export function SignatureFieldInput({
  label,
  value,
  readOnly,
  logSheetLocalId,
  logSheetServerId,
  assetId,
  fieldKey,
  onChange,
  scope = 'FORM',
  verdict,
  coveredFingerprint
}: Props) {
  const id = signatureIdOf(value)
  const signedAt = signedAtOf(value)
  const [src, setSrc] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const [drawing, setDrawing] = useState(false)
  const [hasInk, setHasInk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const last = useRef<{ x: number; y: number } | null>(null)
  const pen = useRef(false)

  // The drawing's preview: from the device when it holds the bytes, from the server when it does
  // not (a round signed on another tablet, or bytes purged after upload). Revoked on change.
  useEffect(() => {
    let url: string | null = null
    let cancelled = false
    setSrc(null)
    setMissing(false)
    if (!id) return
    void (async () => {
      try {
        const row = await getAttachment(id)
        let blob = row?.blob
        if (!blob) blob = await downloadAttachment(id)
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setSrc(url)
      } catch {
        if (!cancelled) setMissing(true)
      }
    })()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [id])

  const blank = () => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = '#111827'
    ctx.fillStyle = '#111827'
    ctx.lineWidth = 2.6
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    setHasInk(false)
  }

  useEffect(() => {
    if (drawing) blank()
  }, [drawing])

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget
    const rect = canvas.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height)
    }
  }

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const ctx = e.currentTarget.getContext('2d')
    if (!ctx) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    pen.current = true
    const p = point(e)
    last.current = p
    ctx.beginPath()
    ctx.arc(p.x, p.y, ctx.lineWidth / 2, 0, Math.PI * 2)
    ctx.fill()
    setHasInk(true)
  }

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pen.current || !last.current) return
    e.preventDefault()
    const ctx = e.currentTarget.getContext('2d')
    if (!ctx) return
    const p = point(e)
    ctx.beginPath()
    ctx.moveTo(last.current.x, last.current.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    last.current = p
  }

  const onUp = () => {
    pen.current = false
    last.current = null
  }

  const accept = async () => {
    const canvas = canvasRef.current
    if (!canvas || !hasInk) return
    setBusy(true)
    setError(null)
    try {
      const blob: Blob | null = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error(t.signature.saveFailed)
      const attachmentId = uuidv4()
      const capturedBy = await getSessionUserId()
      await saveAttachment({
        id: attachmentId,
        ...(capturedBy ? { createdByUserId: capturedBy } : {}),
        logSheetLocalId,
        logSheetServerId,
        assetId,
        fieldKey,
        // An image as far as storage, upload and the server's sniffing are concerned.
        kind: 'IMAGE',
        mimeType: 'image/png',
        sizeBytes: blob.size,
        width: canvas.width,
        height: canvas.height,
        blob,
        syncStatus: 'pending',
        createdAt: Date.now()
      })
      onChange(buildSignatureValue(attachmentId, Date.now(), coveredFingerprint?.()))
      setDrawing(false)
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t.signature.saveFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Box>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.75 }}>
        {label}
      </Typography>

      {id && !drawing && (
        <Box sx={{ maxWidth: 320, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: '#fff', p: 0.5 }}>
          {src ? (
            <Box component="img" src={src} alt={t.signature.signed} sx={{ display: 'block', width: '100%', height: 'auto' }} />
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
              {missing ? t.signature.notOnDevice : '…'}
            </Typography>
          )}
        </Box>
      )}
      {id && !drawing && signedAt != null && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
          {t.signature.signedAt}: {formatJalaliDateTime(signedAt)}
        </Typography>
      )}
      {!id && readOnly && (
        <Typography variant="body2" color="text.secondary">{t.signature.unsigned}</Typography>
      )}
      {/* The out-of-date warning, so the operator can sign again while still at the equipment.
          Never a refusal: a save and a submit go through regardless. */}
      {id && !drawing && verdict === 'stale' && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          {scope === 'ROUND' ? t.signature.staleRound : t.signature.staleForm}
          {!readOnly && ` ${t.signature.resignHint}`}
        </Alert>
      )}
      {id && !drawing && verdict === 'valid' && (
        <Typography variant="caption" color="success.main" display="block" sx={{ mt: 0.5 }}>
          {t.signature.valid}
        </Typography>
      )}

      {drawing && (
        <Box sx={{ border: '1px dashed', borderColor: 'text.disabled', borderRadius: 1, bgcolor: '#fff', maxWidth: WIDTH }}>
          <canvas
            ref={canvasRef}
            width={WIDTH}
            height={HEIGHT}
            aria-label={t.signature.drawHere}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onPointerLeave={onUp}
            style={{ display: 'block', width: '100%', height: 'auto', aspectRatio: `${WIDTH} / ${HEIGHT}`, touchAction: 'none' }}
          />
        </Box>
      )}

      {!readOnly && (
        <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 1 }}>
          {!drawing && (
            <Button variant="outlined" size="small" onClick={() => setDrawing(true)}>
              {id ? t.signature.resign : t.signature.sign}
            </Button>
          )}
          {!drawing && id && (
            <Button color="error" size="small" onClick={() => onChange(null)}>
              {t.signature.remove}
            </Button>
          )}
          {drawing && (
            <>
              <Button variant="contained" size="small" disabled={!hasInk || busy} onClick={() => void accept()}>
                {t.signature.accept}
              </Button>
              <Button size="small" onClick={blank} disabled={busy}>{t.signature.clear}</Button>
              <Button size="small" onClick={() => setDrawing(false)} disabled={busy}>{t.signature.cancel}</Button>
            </>
          )}
        </Stack>
      )}
      {drawing && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
          {t.signature.drawHere} {t.signature.hint}
        </Typography>
      )}
      {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
    </Box>
  )
}
