import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import GestureIcon from '@mui/icons-material/Gesture'
import ArrowOutwardIcon from '@mui/icons-material/ArrowOutward'
import CropSquareIcon from '@mui/icons-material/CropSquare'
import TitleIcon from '@mui/icons-material/Title'
import UndoIcon from '@mui/icons-material/Undo'
import RedoIcon from '@mui/icons-material/Redo'
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep'
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera'
import {
  ANNOTATION_COLORS,
  ANNOTATION_TEXT_SIZE,
  ANNOTATION_WIDTHS,
  EMPTY_ANNOTATION_STATE,
  addShape,
  bakeAnnotations,
  canRedo,
  canUndo,
  clearShapes,
  hasAnnotations,
  redo,
  renderAnnotations,
  toImagePoint,
  undo,
  type AnnotationPoint,
  type AnnotationShape,
  type AnnotationState,
  type AnnotationTool
} from '@/utils/imageAnnotation'
import { encodeCanvasImage } from '@/utils/mediaCapture'
import { t } from '@/i18n'

export interface AnnotatedImage {
  blob: Blob
  width: number
  height: number
  annotated: boolean
}

interface Props {
  open: boolean
  /** The already-compressed capture. Annotating the stored image, never the raw camera file. */
  source: Blob | null
  onCancel: () => void
  onRetake: () => void
  onConfirm: (result: AnnotatedImage) => void
}

/**
 * Review-and-mark step between taking a photo and storing it.
 *
 * Deliberately built on the **compressed** capture rather than the camera's original file. The
 * compressed bitmap is what gets stored either way, so drawing on it guarantees a mark lands in
 * the saved file exactly where the operator put it — with the raw file, EXIF orientation can
 * differ between what a preview shows and what a re-decode produces, and every mark would be
 * rotated off its target. It also means confirming *without* marks returns the original blob
 * untouched: no second encode, no quality loss, byte-for-byte the photo the app has always
 * saved.
 */
export function ImageAnnotationDialog({ open, source, onCancel, onRetake, onConfirm }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bitmapRef = useRef<ImageBitmap | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [state, setState] = useState<AnnotationState>(EMPTY_ANNOTATION_STATE)
  const [tool, setTool] = useState<AnnotationTool>('free')
  const [color, setColor] = useState(ANNOTATION_COLORS[0])
  const [width, setWidth] = useState(ANNOTATION_WIDTHS[1])
  const [draft, setDraft] = useState<AnnotationShape | null>(null)
  const [textAt, setTextAt] = useState<AnnotationPoint | null>(null)
  const [textValue, setTextValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const drawing = useRef(false)

  // Decode once per photo. The bitmap holds the decoded pixels, so it is released on every
  // change of source and on unmount — a 1600px photo is several megabytes of them.
  useEffect(() => {
    let cancelled = false
    setState(EMPTY_ANNOTATION_STATE)
    setDraft(null)
    setTextAt(null)
    setError(null)
    if (!source) {
      setSize(null)
      return
    }
    void createImageBitmap(source)
      .then(bitmap => {
        if (cancelled) {
          bitmap.close?.()
          return
        }
        bitmapRef.current?.close?.()
        bitmapRef.current = bitmap
        setSize({ width: bitmap.width, height: bitmap.height })
      })
      .catch(() => {
        if (!cancelled) setError(t.attachments.annotateLoadFailed)
      })
    return () => {
      cancelled = true
    }
  }, [source])

  useEffect(() => {
    return () => {
      bitmapRef.current?.close?.()
      bitmapRef.current = null
    }
  }, [])

  /** Full repaint from the shape list — see imageAnnotation.ts for why this is the cheap path. */
  const repaint = useCallback(() => {
    const canvas = canvasRef.current
    const bitmap = bitmapRef.current
    if (!canvas || !bitmap || !size) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, size.width, size.height)
    ctx.drawImage(bitmap, 0, 0, size.width, size.height)
    const shapes = draft ? [...state.present, draft] : state.present
    renderAnnotations(ctx, shapes, size.width, size.height)
  }, [size, state.present, draft])

  useEffect(() => {
    repaint()
  }, [repaint])

  const pointFrom = (e: React.PointerEvent<HTMLCanvasElement>): AnnotationPoint => {
    const rect = e.currentTarget.getBoundingClientRect()
    return toImagePoint(e.clientX, e.clientY, rect)
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (saving || !size) return
    const at = pointFrom(e)
    if (tool === 'text') {
      setTextAt(at)
      setTextValue('')
      return
    }
    // Capture keeps the stroke following the finger even when it leaves the canvas, which is
    // routine on a small screen — without it a stroke ends the moment the finger crosses the
    // edge and the operator gets half a circle.
    e.currentTarget.setPointerCapture(e.pointerId)
    drawing.current = true
    setDraft(
      tool === 'free'
        ? { kind: 'free', color, width, points: [at] }
        : { kind: tool, color, width, from: at, to: at }
    )
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return
    const at = pointFrom(e)
    setDraft(current => {
      if (!current) return current
      if (current.kind === 'free') return { ...current, points: [...current.points, at] }
      if (current.kind === 'text') return current
      return { ...current, to: at }
    })
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return
    drawing.current = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    setDraft(current => {
      if (current) setState(s => addShape(s, current))
      return null
    })
  }

  const commitText = () => {
    const text = textValue.trim()
    if (text && textAt) {
      setState(s => addShape(s, { kind: 'text', color, size: ANNOTATION_TEXT_SIZE, at: textAt, text }))
    }
    setTextAt(null)
    setTextValue('')
  }

  const handleConfirm = async () => {
    const bitmap = bitmapRef.current
    if (!source || !bitmap || !size) return
    setSaving(true)
    setError(null)
    try {
      // Nothing drawn — hand back exactly what came in. Re-encoding an untouched photo would
      // cost a second generation of lossy compression for no reason at all.
      if (!hasAnnotations(state)) {
        onConfirm({ blob: source, width: size.width, height: size.height, annotated: false })
        return
      }
      // Wait for the app font before burning text in: an unresolved font renders the label in
      // whatever fallback the browser has at that instant, and unlike the live preview the
      // baked pixels cannot be repainted afterwards.
      if (typeof document !== 'undefined' && document.fonts?.ready) {
        await document.fonts.ready
      }
      const canvas = bakeAnnotations(bitmap, state.present, size.width, size.height)
      const blob = await encodeCanvasImage(canvas)
      onConfirm({ blob, width: size.width, height: size.height, annotated: true })
    } catch {
      setError(t.attachments.annotateSaveFailed)
    } finally {
      setSaving(false)
    }
  }

  const tools: Array<{ id: AnnotationTool; icon: JSX.Element; label: string }> = [
    { id: 'free', icon: <GestureIcon />, label: t.attachments.annotateFree },
    { id: 'arrow', icon: <ArrowOutwardIcon />, label: t.attachments.annotateArrow },
    { id: 'rect', icon: <CropSquareIcon />, label: t.attachments.annotateRect },
    { id: 'text', icon: <TitleIcon />, label: t.attachments.annotateText }
  ]

  return (
    <Dialog open={open} onClose={saving ? undefined : onCancel} fullScreen>
      <DialogTitle sx={{ pb: 1 }}>{t.attachments.annotateTitle}</DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {error && (
          <Typography variant="body2" color="error">
            {error}
          </Typography>
        )}

        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
          {tools.map(item => (
            <Tooltip key={item.id} title={item.label} arrow>
              <span>
                <IconButton
                  color={tool === item.id ? 'primary' : 'default'}
                  onClick={() => setTool(item.id)}
                  disabled={saving}
                  aria-label={item.label}
                  aria-pressed={tool === item.id}
                >
                  {item.icon}
                </IconButton>
              </span>
            </Tooltip>
          ))}

          <Box sx={{ flex: 1 }} />

          <Tooltip title={t.attachments.annotateUndo} arrow>
            <span>
              <IconButton
                onClick={() => setState(undo)}
                disabled={saving || !canUndo(state)}
                aria-label={t.attachments.annotateUndo}
              >
                <UndoIcon />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t.attachments.annotateRedo} arrow>
            <span>
              <IconButton
                onClick={() => setState(redo)}
                disabled={saving || !canRedo(state)}
                aria-label={t.attachments.annotateRedo}
              >
                <RedoIcon />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t.attachments.annotateClear} arrow>
            <span>
              <IconButton
                onClick={() => setState(clearShapes)}
                disabled={saving || !hasAnnotations(state)}
                aria-label={t.attachments.annotateClear}
              >
                <DeleteSweepIcon />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>

        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          {ANNOTATION_COLORS.map(value => (
            <Box
              key={value}
              component="button"
              type="button"
              aria-label={value}
              aria-pressed={color === value}
              onClick={() => setColor(value)}
              disabled={saving}
              sx={{
                width: 32,
                height: 32,
                p: 0,
                borderRadius: '50%',
                bgcolor: value,
                cursor: 'pointer',
                border: theme =>
                  color === value
                    ? `3px solid ${theme.palette.primary.main}`
                    : `1px solid ${theme.palette.divider}`
              }}
            />
          ))}
          <Box sx={{ width: 8 }} />
          {ANNOTATION_WIDTHS.map((value, index) => (
            <Box
              key={value}
              component="button"
              type="button"
              aria-label={`${t.attachments.annotateWidth} ${index + 1}`}
              aria-pressed={width === value}
              onClick={() => setWidth(value)}
              disabled={saving}
              sx={{
                width: 36,
                height: 32,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 1,
                bgcolor: 'transparent',
                cursor: 'pointer',
                border: theme =>
                  width === value
                    ? `2px solid ${theme.palette.primary.main}`
                    : `1px solid ${theme.palette.divider}`
              }}
            >
              <Box sx={{ width: 22, height: value / 2, borderRadius: 4, bgcolor: 'text.primary' }} />
            </Box>
          ))}
        </Stack>

        <Box
          sx={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'common.black',
            borderRadius: 1,
            overflow: 'hidden',
            minHeight: 240
          }}
        >
          <canvas
            ref={canvasRef}
            width={size?.width ?? 0}
            height={size?.height ?? 0}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            style={{
              maxWidth: '100%',
              maxHeight: '60vh',
              // Without this the browser claims the gesture for scrolling and the first stroke
              // of every session scrolls the dialog instead of drawing.
              touchAction: 'none'
            }}
          />
        </Box>

        {textAt && (
          <Stack direction="row" spacing={1} alignItems="center">
            {/* A real input rather than typing onto the canvas: the Android keyboard, Persian
                shaping and text selection all come free, and none of them are worth
                re-implementing on a 2D context. */}
            <TextField
              autoFocus
              fullWidth
              size="small"
              value={textValue}
              onChange={e => setTextValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitText()
                }
              }}
              label={t.attachments.annotateTextLabel}
              inputProps={{ maxLength: 60 }}
            />
            <Button onClick={commitText} variant="contained" disabled={!textValue.trim()}>
              {t.attachments.annotateTextAdd}
            </Button>
            <Button onClick={() => setTextAt(null)}>{t.form.cancel}</Button>
          </Stack>
        )}
      </DialogContent>

      <DialogActions sx={{ flexWrap: 'wrap', gap: 1, justifyContent: 'space-between' }}>
        <Button onClick={onCancel} disabled={saving} color="inherit">
          {t.form.cancel}
        </Button>
        <Stack direction="row" spacing={1}>
          <Button onClick={onRetake} disabled={saving} startIcon={<PhotoCameraIcon />}>
            {t.attachments.annotateRetake}
          </Button>
          <Button onClick={() => void handleConfirm()} variant="contained" disabled={saving || !size}>
            {hasAnnotations(state) ? t.attachments.annotateSave : t.attachments.annotateSavePlain}
          </Button>
        </Stack>
      </DialogActions>
    </Dialog>
  )
}
