/**
 * Marking up a photo before it is attached to a log sheet.
 *
 * An operator photographs a leak, a cracked mount, a gauge reading badly — and a reviewer
 * opening that photo a week later has no way to know which part of the frame mattered. A circle
 * and three words fix that, and they have to be applied on the tablet, at the equipment, while
 * the person who saw it is still standing there.
 *
 * **Shapes are kept as data, not as paint.** Nothing is drawn permanently until the operator
 * saves: the canvas is re-rendered from this list on every change. That single decision is what
 * makes undo, redo and clear trivial (move an array between three stacks) instead of expensive
 * (a full-canvas bitmap snapshot per step, megabytes each on a 1600px photo).
 *
 * **Coordinates are normalised to 0..1 of the image, never pixels.** The canvas is displayed at
 * whatever width the screen allows and baked at the image's real size, so a stroke recorded in
 * screen pixels would land somewhere else in the saved file — and would move again if the
 * tablet rotated mid-annotation.
 */

/** A point in image space: 0..1 on each axis, independent of how big the canvas is drawn. */
export interface AnnotationPoint {
  x: number
  y: number
}

export type AnnotationTool = 'free' | 'arrow' | 'rect' | 'text'

export type AnnotationShape =
  | { kind: 'free'; color: string; width: number; points: AnnotationPoint[] }
  | { kind: 'arrow'; color: string; width: number; from: AnnotationPoint; to: AnnotationPoint }
  | { kind: 'rect'; color: string; width: number; from: AnnotationPoint; to: AnnotationPoint }
  | { kind: 'text'; color: string; size: number; at: AnnotationPoint; text: string }

/**
 * Undo history as three stacks of whole shape lists.
 *
 * Snapshots rather than inverse operations, because `clear` has no cheap inverse and an
 * operator who taps it by mistake after ten marks must get all ten back. The snapshots share
 * their shape objects — the arrays are the only thing duplicated — so the memory cost is a
 * handful of pointers per step.
 */
export interface AnnotationState {
  past: AnnotationShape[][]
  present: AnnotationShape[]
  future: AnnotationShape[][]
}

/**
 * Depth cap for the undo stack.
 *
 * A round can involve a lot of small strokes and this state lives for as long as the dialog is
 * open; unbounded history on a device that is already tight on memory is a slow leak. Fifty
 * steps is far more than the "I mis-tapped, take that back" this exists for.
 */
export const MAX_HISTORY = 50

export const EMPTY_ANNOTATION_STATE: AnnotationState = { past: [], present: [], future: [] }

function pushPast(state: AnnotationState, next: AnnotationShape[]): AnnotationState {
  const past = [...state.past, state.present].slice(-MAX_HISTORY)
  // Any new edit invalidates the redo branch — this is the standard rule, and the alternative
  // (keeping it) would let redo resurrect a shape from a history that no longer happened.
  return { past, present: next, future: [] }
}

export function addShape(state: AnnotationState, shape: AnnotationShape): AnnotationState {
  return pushPast(state, [...state.present, shape])
}

export function clearShapes(state: AnnotationState): AnnotationState {
  if (state.present.length === 0) return state
  return pushPast(state, [])
}

export function undo(state: AnnotationState): AnnotationState {
  if (state.past.length === 0) return state
  const previous = state.past[state.past.length - 1]
  return {
    past: state.past.slice(0, -1),
    present: previous,
    future: [state.present, ...state.future]
  }
}

export function redo(state: AnnotationState): AnnotationState {
  if (state.future.length === 0) return state
  const [next, ...rest] = state.future
  return {
    past: [...state.past, state.present].slice(-MAX_HISTORY),
    present: next,
    future: rest
  }
}

export function canUndo(state: AnnotationState): boolean {
  return state.past.length > 0
}

export function canRedo(state: AnnotationState): boolean {
  return state.future.length > 0
}

export function hasAnnotations(state: AnnotationState): boolean {
  return state.present.length > 0
}

/**
 * Where a touch landed, in image space.
 *
 * Clamped because a finger that slides off the edge of the canvas still reports coordinates,
 * and a stroke escaping the image would be silently cropped away by the bake.
 */
export function toImagePoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number }
): AnnotationPoint {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 }
  return {
    x: clamp01((clientX - rect.left) / rect.width),
    y: clamp01((clientY - rect.top) / rect.height)
  }
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * Stroke width in real pixels for a given image.
 *
 * Relative to the image's long edge, not a fixed pixel count: the same "medium" pen has to read
 * the same on a 640px crop and a 1600px photo, and a 3px line on the latter is invisible once
 * the photo is opened full-screen in the web panel.
 */
export function strokeWidthPx(width: number, imageWidth: number, imageHeight: number): number {
  const longest = Math.max(imageWidth, imageHeight, 1)
  return Math.max(1, Math.round((width / 1000) * longest))
}

/** Text size in real pixels, same relative reasoning as the stroke width. */
export function textSizePx(size: number, imageWidth: number, imageHeight: number): number {
  const longest = Math.max(imageWidth, imageHeight, 1)
  return Math.max(8, Math.round((size / 1000) * longest))
}

/**
 * The two barbs of an arrow head, in image space.
 *
 * Pure geometry so it can be tested without a canvas. A zero-length arrow (a tap that never
 * moved) has no direction to point in, so both barbs collapse onto the tip and the head simply
 * does not render — which is what should happen rather than a NaN that poisons the whole path.
 */
export function arrowHeadPoints(
  from: AnnotationPoint,
  to: AnnotationPoint,
  headLength: number
): [AnnotationPoint, AnnotationPoint] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  if (length === 0) return [{ ...to }, { ...to }]

  const angle = Math.atan2(dy, dx)
  const spread = Math.PI / 7
  return [
    {
      x: to.x - headLength * Math.cos(angle - spread),
      y: to.y - headLength * Math.sin(angle - spread)
    },
    {
      x: to.x - headLength * Math.cos(angle + spread),
      y: to.y - headLength * Math.sin(angle + spread)
    }
  ]
}

/**
 * Keeps a centred label inside the frame.
 *
 * Text is anchored on the point the operator tapped, which is the only predictable behaviour in
 * a bidirectional UI — anchoring by edge would place Persian and English labels on opposite
 * sides of the same tap. Tapping near an edge would then push half the label outside the image,
 * so the anchor slides back in by whatever the overflow was.
 */
export function clampTextAnchor(
  at: AnnotationPoint,
  textWidthPx: number,
  textHeightPx: number,
  imageWidth: number,
  imageHeight: number
): AnnotationPoint {
  const halfWidth = imageWidth > 0 ? textWidthPx / 2 / imageWidth : 0
  const halfHeight = imageHeight > 0 ? textHeightPx / 2 / imageHeight : 0
  // A label wider than the image cannot be fitted; centring it is the least-bad answer.
  const x = halfWidth * 2 >= 1 ? 0.5 : Math.min(1 - halfWidth, Math.max(halfWidth, at.x))
  const y = halfHeight * 2 >= 1 ? 0.5 : Math.min(1 - halfHeight, Math.max(halfHeight, at.y))
  return { x, y }
}

/** Available pen colours. High-contrast against industrial greys, rust and steel. */
export const ANNOTATION_COLORS = ['#e53935', '#fdd835', '#1e88e5', '#43a047', '#ffffff', '#000000']

/** Pen widths, in thousandths of the image's long edge (see strokeWidthPx). */
export const ANNOTATION_WIDTHS = [4, 8, 16]

/** Text size, same unit as the widths. */
export const ANNOTATION_TEXT_SIZE = 45

/**
 * Draws the shapes onto a context already scaled to `width` × `height` pixels.
 *
 * Takes the context rather than a canvas so the same code serves the live preview and the bake,
 * and so it can be exercised in tests against a recording stub with no DOM at all.
 */
export function renderAnnotations(
  ctx: CanvasRenderingContext2D,
  shapes: AnnotationShape[],
  width: number,
  height: number
): void {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (const shape of shapes) {
    if (shape.kind === 'text') {
      drawText(ctx, shape, width, height)
      continue
    }

    ctx.strokeStyle = shape.color
    ctx.lineWidth = strokeWidthPx(shape.width, width, height)

    if (shape.kind === 'free') {
      drawFreehand(ctx, shape.points, width, height)
    } else if (shape.kind === 'rect') {
      const x = shape.from.x * width
      const y = shape.from.y * height
      ctx.strokeRect(x, y, (shape.to.x - shape.from.x) * width, (shape.to.y - shape.from.y) * height)
    } else {
      drawArrow(ctx, shape.from, shape.to, width, height)
    }
  }

  ctx.restore()
}

function drawFreehand(
  ctx: CanvasRenderingContext2D,
  points: AnnotationPoint[],
  width: number,
  height: number
): void {
  if (points.length === 0) return
  ctx.beginPath()
  // A single tap is a dot, not a nothing: lineTo on itself with a round cap paints one.
  ctx.moveTo(points[0].x * width, points[0].y * height)
  if (points.length === 1) {
    ctx.lineTo(points[0].x * width, points[0].y * height)
  }
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x * width, points[i].y * height)
  }
  ctx.stroke()
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  from: AnnotationPoint,
  to: AnnotationPoint,
  width: number,
  height: number
): void {
  ctx.beginPath()
  ctx.moveTo(from.x * width, from.y * height)
  ctx.lineTo(to.x * width, to.y * height)
  ctx.stroke()

  // Head length scales with the arrow so a short arrow does not get a head bigger than itself.
  const shaft = Math.hypot(to.x - from.x, to.y - from.y)
  if (shaft === 0) return
  const [left, right] = arrowHeadPoints(from, to, Math.min(shaft * 0.35, 0.06))

  ctx.beginPath()
  ctx.moveTo(left.x * width, left.y * height)
  ctx.lineTo(to.x * width, to.y * height)
  ctx.lineTo(right.x * width, right.y * height)
  ctx.stroke()
}

function drawText(
  ctx: CanvasRenderingContext2D,
  shape: Extract<AnnotationShape, { kind: 'text' }>,
  width: number,
  height: number
): void {
  const size = textSizePx(shape.size, width, height)
  ctx.font = `700 ${size}px Vazirmatn, sans-serif`
  // Persian shapes and orders itself through the platform text stack, but only when the
  // context is told the run is right-to-left; left as the default, mixed Persian/English
  // labels come out in the wrong order.
  ctx.direction = 'rtl'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  const measured = ctx.measureText(shape.text)
  const anchor = clampTextAnchor(shape.at, measured.width, size, width, height)
  const x = anchor.x * width
  const y = anchor.y * height

  // A dark outline under the fill. Without it a label is unreadable on roughly half the photos
  // a plant produces — yellow text on a bright steel surface, black on a shadowed pump.
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(2, size / 6)
  ctx.strokeStyle = shape.color === '#000000' ? '#ffffff' : '#000000'
  ctx.strokeText(shape.text, x, y)
  ctx.fillStyle = shape.color
  ctx.fillText(shape.text, x, y)
}

/**
 * Burns the shapes into the photo and hands back the canvas to encode.
 *
 * Drawn at the image's own pixel size, not the size it happened to be displayed at, so a mark
 * made on a phone-width preview is as sharp in the saved file as the photo underneath it.
 */
export function bakeAnnotations(
  source: CanvasImageSource,
  shapes: AnnotationShape[],
  width: number,
  height: number
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')
  ctx.drawImage(source, 0, 0, width, height)
  renderAnnotations(ctx, shapes, width, height)
  return canvas
}
