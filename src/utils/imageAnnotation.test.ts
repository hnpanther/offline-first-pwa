import { describe, expect, it } from 'vitest'
import {
  ANNOTATION_COLORS,
  ANNOTATION_WIDTHS,
  EMPTY_ANNOTATION_STATE,
  MAX_HISTORY,
  addShape,
  arrowHeadPoints,
  canRedo,
  canUndo,
  clampTextAnchor,
  clearShapes,
  hasAnnotations,
  redo,
  renderAnnotations,
  strokeWidthPx,
  textSizePx,
  toImagePoint,
  undo,
  type AnnotationShape,
  type AnnotationState
} from '@/utils/imageAnnotation'

/**
 * The annotation model, tested without a DOM.
 *
 * Everything an operator can get wrong on a tablet — a mis-tap, a stroke that slid off the
 * edge, a label typed near the frame border, five undos in a row — is a pure function here, so
 * it can be pinned exactly rather than guessed at through a canvas.
 */

const stroke = (n: number): AnnotationShape => ({
  kind: 'free',
  color: '#e53935',
  width: 8,
  points: [{ x: n / 10, y: n / 10 }]
})

function withShapes(count: number): AnnotationState {
  let state = EMPTY_ANNOTATION_STATE
  for (let i = 0; i < count; i++) state = addShape(state, stroke(i))
  return state
}

describe('undo history', () => {
  it('starts empty, with nothing to undo or redo', () => {
    expect(hasAnnotations(EMPTY_ANNOTATION_STATE)).toBe(false)
    expect(canUndo(EMPTY_ANNOTATION_STATE)).toBe(false)
    expect(canRedo(EMPTY_ANNOTATION_STATE)).toBe(false)
  })

  it('takes back the last mark and puts it back again', () => {
    const state = withShapes(2)

    const undone = undo(state)
    expect(undone.present).toHaveLength(1)
    expect(canRedo(undone)).toBe(true)

    const redone = redo(undone)
    expect(redone.present).toHaveLength(2)
    expect(redone.present).toEqual(state.present)
  })

  it('undoes repeatedly back to a blank photo', () => {
    let state = withShapes(3)
    state = undo(undo(undo(state)))

    expect(state.present).toEqual([])
    expect(canUndo(state)).toBe(false)
  })

  it('does nothing at either end instead of throwing', () => {
    expect(undo(EMPTY_ANNOTATION_STATE)).toBe(EMPTY_ANNOTATION_STATE)
    expect(redo(EMPTY_ANNOTATION_STATE)).toBe(EMPTY_ANNOTATION_STATE)
  })

  it('drops the redo branch once a new mark is drawn', () => {
    // The standard rule, and the reason it matters here: keeping the branch would let redo
    // paste back a stroke from a history that no longer happened, over a photo the operator
    // has since marked differently.
    const state = undo(withShapes(2))
    expect(canRedo(state)).toBe(true)

    const afterNewShape = addShape(state, stroke(9))

    expect(canRedo(afterNewShape)).toBe(false)
    expect(afterNewShape.present).toHaveLength(2)
  })

  it('makes clear undoable — the whole point of snapshots over inverse operations', () => {
    // An operator who taps clear by mistake after ten marks gets all ten back.
    const state = withShapes(10)

    const cleared = clearShapes(state)
    expect(cleared.present).toEqual([])
    expect(hasAnnotations(cleared)).toBe(false)

    const restored = undo(cleared)
    expect(restored.present).toHaveLength(10)
  })

  it('treats clear on an empty canvas as a no-op, not a history entry', () => {
    const cleared = clearShapes(EMPTY_ANNOTATION_STATE)

    expect(cleared).toBe(EMPTY_ANNOTATION_STATE)
    expect(canUndo(cleared)).toBe(false)
  })

  it('caps how far back it remembers, so a long round cannot grow it without bound', () => {
    const state = withShapes(MAX_HISTORY + 20)

    expect(state.past.length).toBeLessThanOrEqual(MAX_HISTORY)
    // The newest steps are the ones kept — undo still works normally near the top.
    expect(undo(state).present).toHaveLength(MAX_HISTORY + 19)
  })

  it('never mutates the state it was handed', () => {
    // The whole model is shared with React state; an in-place edit would skip a re-render and
    // leave the canvas showing something the state no longer says.
    const original = withShapes(2)
    const snapshot = JSON.stringify(original)

    addShape(original, stroke(5))
    undo(original)
    clearShapes(original)

    expect(JSON.stringify(original)).toBe(snapshot)
  })
})

describe('touch to image coordinates', () => {
  const rect = { left: 100, top: 50, width: 200, height: 100 }

  it('maps a touch to a fraction of the image, not to screen pixels', () => {
    expect(toImagePoint(200, 100, rect)).toEqual({ x: 0.5, y: 0.5 })
    expect(toImagePoint(100, 50, rect)).toEqual({ x: 0, y: 0 })
    expect(toImagePoint(300, 150, rect)).toEqual({ x: 1, y: 1 })
  })

  it('clamps a finger that slid off the canvas rather than recording a mark outside the photo', () => {
    // Routine on a small screen, and an unclamped point would simply be cropped away by the
    // bake — the operator would see their stroke vanish with no explanation.
    expect(toImagePoint(50, 20, rect)).toEqual({ x: 0, y: 0 })
    expect(toImagePoint(400, 300, rect)).toEqual({ x: 1, y: 1 })
  })

  it('survives a zero-sized canvas instead of producing NaN', () => {
    expect(toImagePoint(10, 10, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0 })
  })

  it('is independent of how large the canvas happens to be drawn', () => {
    // The same tap on a phone and on a tablet has to describe the same spot in the photo.
    const small = toImagePoint(150, 75, { left: 100, top: 50, width: 100, height: 50 })
    const large = toImagePoint(200, 100, { left: 100, top: 50, width: 200, height: 100 })

    expect(small).toEqual(large)
  })
})

describe('sizes scale with the image, not with the screen', () => {
  it('gives the same pen a proportional width on a small and a large photo', () => {
    // A fixed 3px line is invisible once a 1600px photo is opened full-screen in the panel.
    expect(strokeWidthPx(8, 1600, 1200)).toBeGreaterThan(strokeWidthPx(8, 640, 480))
  })

  it('keeps every pen at least one pixel wide', () => {
    expect(strokeWidthPx(1, 10, 10)).toBeGreaterThanOrEqual(1)
    expect(strokeWidthPx(0, 0, 0)).toBeGreaterThanOrEqual(1)
  })

  it('keeps text legible rather than sub-pixel on a small crop', () => {
    expect(textSizePx(45, 100, 100)).toBeGreaterThanOrEqual(8)
  })

  it('measures against the long edge, so portrait and landscape agree', () => {
    expect(strokeWidthPx(8, 1600, 900)).toBe(strokeWidthPx(8, 900, 1600))
  })
})

describe('arrow head geometry', () => {
  it('puts both barbs behind the tip', () => {
    const [left, right] = arrowHeadPoints({ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, 0.1)

    expect(left.x).toBeLessThan(1)
    expect(right.x).toBeLessThan(1)
    // Symmetric about the shaft.
    expect(left.y + right.y).toBeCloseTo(1, 6)
  })

  it('collapses to the tip for a tap that never moved, instead of producing NaN', () => {
    // A NaN coordinate poisons the whole path and the arrow disappears silently.
    const [left, right] = arrowHeadPoints({ x: 0.4, y: 0.4 }, { x: 0.4, y: 0.4 }, 0.1)

    expect(left).toEqual({ x: 0.4, y: 0.4 })
    expect(right).toEqual({ x: 0.4, y: 0.4 })
  })

  it('follows the direction the arrow points', () => {
    const [up] = arrowHeadPoints({ x: 0.5, y: 1 }, { x: 0.5, y: 0 }, 0.1)
    expect(up.y).toBeGreaterThan(0)
  })
})

describe('text anchoring', () => {
  it('centres the label on the tap when it fits', () => {
    expect(clampTextAnchor({ x: 0.5, y: 0.5 }, 100, 40, 1000, 800)).toEqual({ x: 0.5, y: 0.5 })
  })

  it('slides a label tapped near the edge back inside the frame', () => {
    // Anchoring by edge instead would place Persian and English labels on opposite sides of
    // the same tap; centring and clamping keeps both readable and inside the photo.
    const anchor = clampTextAnchor({ x: 0.99, y: 0.99 }, 200, 60, 1000, 800)

    expect(anchor.x).toBeLessThan(0.99)
    expect(anchor.y).toBeLessThan(0.99)
    expect(anchor.x + 100 / 1000).toBeLessThanOrEqual(1.000001)
  })

  it('centres a label too wide for the image rather than pushing it off one side', () => {
    expect(clampTextAnchor({ x: 0.1, y: 0.5 }, 2000, 40, 1000, 800).x).toBe(0.5)
  })
})

/**
 * Rendering, checked through a recording stub. Not a pixel test — those need a real canvas and
 * break on font metrics — but enough to pin that every shape kind reaches the context, that the
 * normalised coordinates are scaled up by the image size, and that a mis-tap still draws.
 */
type Call = [string, ...unknown[]]

function recordingContext(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = []
  const record = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args])
  }
  const ctx = {
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    stroke: record('stroke'),
    strokeRect: record('strokeRect'),
    fillText: record('fillText'),
    strokeText: record('strokeText'),
    measureText: () => ({ width: 50 }),
    lineCap: '',
    lineJoin: '',
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: '',
    font: '',
    direction: '',
    textAlign: '',
    textBaseline: ''
  } as unknown as CanvasRenderingContext2D
  return { ctx, calls }
}

describe('rendering', () => {
  it('scales normalised points up to the image size', () => {
    const { ctx, calls } = recordingContext()

    renderAnnotations(
      ctx,
      [{ kind: 'free', color: '#fff', width: 8, points: [{ x: 0.5, y: 0.25 }, { x: 1, y: 1 }] }],
      800,
      400
    )

    expect(calls).toContainEqual(['moveTo', 400, 100])
    expect(calls).toContainEqual(['lineTo', 800, 400])
  })

  it('draws a dot for a single tap rather than nothing', () => {
    const { ctx, calls } = recordingContext()

    renderAnnotations(ctx, [{ kind: 'free', color: '#fff', width: 8, points: [{ x: 0.5, y: 0.5 }] }], 100, 100)

    expect(calls.filter(c => c[0] === 'lineTo')).toHaveLength(1)
    expect(calls.some(c => c[0] === 'stroke')).toBe(true)
  })

  it('draws each shape kind', () => {
    const { ctx, calls } = recordingContext()

    renderAnnotations(
      ctx,
      [
        { kind: 'rect', color: '#fff', width: 8, from: { x: 0, y: 0 }, to: { x: 0.5, y: 0.5 } },
        { kind: 'arrow', color: '#fff', width: 8, from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
        { kind: 'text', color: '#fff', size: 45, at: { x: 0.5, y: 0.5 }, text: 'نشتی' }
      ],
      200,
      200
    )

    expect(calls).toContainEqual(['strokeRect', 0, 0, 100, 100])
    expect(calls.some(c => c[0] === 'stroke')).toBe(true)
    // Outline first, then fill — a label with no outline is unreadable on about half the photos
    // a plant produces.
    const strokeTextAt = calls.findIndex(c => c[0] === 'strokeText')
    const fillTextAt = calls.findIndex(c => c[0] === 'fillText')
    expect(strokeTextAt).toBeGreaterThanOrEqual(0)
    expect(fillTextAt).toBeGreaterThan(strokeTextAt)
  })

  it('renders Persian text right-to-left', () => {
    // Left at the default, a mixed Persian/English label comes out in the wrong order.
    const { ctx } = recordingContext()

    renderAnnotations(ctx, [{ kind: 'text', color: '#fff', size: 45, at: { x: 0.5, y: 0.5 }, text: 'پمپ ۱' }], 200, 200)

    expect(ctx.direction).toBe('rtl')
  })

  it('draws nothing at all for an empty list', () => {
    const { ctx, calls } = recordingContext()

    renderAnnotations(ctx, [], 100, 100)

    expect(calls.map(c => c[0])).toEqual(['save', 'restore'])
  })
})

describe('shipped palette', () => {
  it('offers both a light and a dark pen, because plant surfaces are neither', () => {
    expect(ANNOTATION_COLORS).toContain('#ffffff')
    expect(ANNOTATION_COLORS).toContain('#000000')
  })

  it('offers widths in increasing order, so the picker reads left to right', () => {
    expect([...ANNOTATION_WIDTHS].sort((a, b) => a - b)).toEqual(ANNOTATION_WIDTHS)
  })
})
