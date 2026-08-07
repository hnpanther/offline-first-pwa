import { describe, expect, it } from 'vitest'
import {
  attachmentIdsOf,
  attachmentKindForDataType,
  buildAttachmentRef
} from '@/services/storage/attachments'

/**
 * The reference format is the contract between the PWA and the server: an attachment field's
 * value in `formData` carries ids, never bytes. Both sides parse it independently, so these
 * cases are mirrored by `AttachmentReferencesTest` on the backend — if the two ever disagree,
 * a photo silently stops resolving.
 */

describe('buildAttachmentRef', () => {
  it('produces the canonical object shape', () => {
    expect(buildAttachmentRef(['a', 'b'])).toEqual({ type: 'attachment', ids: ['a', 'b'] })
  })

  it('produces a valid empty reference when the last file is removed', () => {
    // Deliberately not `undefined`: keeping the shape means the field still round-trips and
    // the required-check has something well-formed to count.
    expect(buildAttachmentRef([])).toEqual({ type: 'attachment', ids: [] })
  })
})

describe('attachmentIdsOf', () => {
  it('reads the canonical shape', () => {
    expect(attachmentIdsOf({ type: 'attachment', ids: ['x', 'y'] })).toEqual(['x', 'y'])
  })

  it('reads a bare array, as an older client may have stored', () => {
    expect(attachmentIdsOf(['x', 'y'])).toEqual(['x', 'y'])
  })

  it('reads a single id held directly', () => {
    expect(attachmentIdsOf('x')).toEqual(['x'])
    expect(attachmentIdsOf({ type: 'attachment', ids: 'x' })).toEqual(['x'])
  })

  it('returns nothing for an unanswered field', () => {
    expect(attachmentIdsOf(undefined)).toEqual([])
    expect(attachmentIdsOf(null)).toEqual([])
    expect(attachmentIdsOf({ type: 'attachment', ids: [] })).toEqual([])
  })

  it('drops blank and literal-null entries', () => {
    // These come from client bugs. Keeping one would mint a reference that can never resolve,
    // and the UI would show a permanently broken thumbnail with no way to clear it.
    expect(attachmentIdsOf({ type: 'attachment', ids: ['a', '', '  ', null, 'null'] })).toEqual([
      'a'
    ])
  })

  it('de-duplicates', () => {
    expect(attachmentIdsOf(['a', 'a', 'b'])).toEqual(['a', 'b'])
  })

  it('trims incidental whitespace', () => {
    expect(attachmentIdsOf([' a '])).toEqual(['a'])
  })
})

describe('attachmentKindForDataType', () => {
  it('maps the media data types a class field can declare', () => {
    expect(attachmentKindForDataType('image')).toBe('IMAGE')
    expect(attachmentKindForDataType('audio')).toBe('AUDIO')
    expect(attachmentKindForDataType('video')).toBe('VIDEO')
  })

  it('is tolerant of casing and padding from hand-edited definitions', () => {
    expect(attachmentKindForDataType(' Image ')).toBe('IMAGE')
  })

  it('returns null for every ordinary field type', () => {
    // This is the switch that decides whether a field renders as a capture control. A false
    // positive here would replace a numeric reading input with a camera button.
    for (const type of ['number', 'text', 'select', 'multiselect', 'checkbox', 'date', '']) {
      expect(attachmentKindForDataType(type)).toBeNull()
    }
    expect(attachmentKindForDataType(undefined)).toBeNull()
  })
})
