/**
 * Whether a signature on the device still vouches for the answers it covers (backend roadmap §32)
 * — so the operator learns a signature is out of date while still at the equipment, and can sign
 * again.
 *
 * **Two sources, and neither is a second hash of the server's.** The server alone decides
 * whether a signature is valid (`SignatureValues`): two canonicalisations, one here and one in
 * Java, would drift, and every signature taken offline would then read as stale. So this module
 * never claims VALID on its own account. It combines:
 *
 * 1. **The server's verdict**, sent in the bundle (`signatureStates`) — authoritative, but only as
 *    fresh as the last sync;
 * 2. **A device-only fingerprint** of the covered answers, taken when this device either drew the
 *    signature (stored on the value as `localFingerprint`, which the server ignores) or received it
 *    from the server judged VALID (`signatureBaselines` on the sheet). A fingerprint is only ever
 *    compared with another fingerprint computed **here**, by this same function, so it cannot drift
 *    against anything — it answers one question: «has anything it covers changed on this tablet
 *    since?».
 *
 * Either one saying «changed» shows the warning. Nothing here blocks a save or a submit: an
 * out-of-date signature is information for the operator, not a refusal.
 */
import type { FieldDefinition } from '@/types/sync'
import type { LogSheetEntryData } from '@/types'

export type SignatureScope = 'NONE' | 'FORM' | 'ROUND'

/** What the operator should be told about one signature. */
export type SignatureVerdict = 'valid' | 'stale' | 'not-bound' | 'unknown'

/** Bundle key for a round-level question — `"sheet:<fieldKey>"`; an asset's is `"<assetId>:<fieldKey>"`. */
export const SHEET_OWNER = 'sheet'

export function signatureKey(owner: string, fieldKey: string): string {
  return `${owner}:${fieldKey}`
}

function asScope(raw: unknown): SignatureScope | null {
  const s = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
  return s === 'NONE' || s === 'FORM' || s === 'ROUND' ? s : null
}

/** The scope a field's definition declares; FORM when absent, as on the server. */
export function scopeOfField(def: Pick<FieldDefinition, 'validation'> | undefined): SignatureScope {
  return asScope((def?.validation as Record<string, unknown> | undefined)?.signatureScope) ?? 'FORM'
}

/**
 * The scope a stored signature was taken under (the server records it), falling back to the
 * field's declaration for a drawing still on its way.
 */
export function scopeOfValue(value: unknown, fallback: SignatureScope): SignatureScope {
  if (value && typeof value === 'object') {
    return asScope((value as { scope?: unknown }).scope) ?? fallback
  }
  return fallback
}

function isSignatureValue(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'signature'
}

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') {
    const ids = (value as { ids?: unknown }).ids
    if (Array.isArray(ids)) return ids.length === 0
  }
  return false
}

/** One value in a form that does not depend on how it was typed: «12», 12 and «12.0» agree. */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return '∅'
  if (typeof value === 'boolean') return value ? 'b:1' : 'b:0'
  if (typeof value === 'number') return Number.isFinite(value) ? `n:${value}` : `s:${value}`
  if (typeof value === 'string') {
    const t = value.trim()
    const n = t === '' ? NaN : Number(t)
    return Number.isFinite(n) && /^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(t) ? `n:${n}` : `s:${t}`
  }
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(',')}]`
  if (typeof value === 'object') {
    const ids = (value as { ids?: unknown }).ids
    if (Array.isArray(ids)) return `ids[${ids.map(String).sort().join(',')}]`
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([k]) => k !== 'localFingerprint')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${k}=${canonical(v)}`).join(';')}}`
  }
  return `s:${String(value)}`
}

/**
 * The answers of one form, canonical: answered keys only (so a blank and an absent key agree —
 * the live form holds every field, the stored copy only the answered ones), signatures left out.
 *
 * @param keys the keys this form owns — its definitions — so a live form's unrelated controls never
 *             enter the fingerprint; omitted for a stored entry, which holds nothing else
 */
function canonicalAnswers(answers: Record<string, unknown> | undefined, keys?: string[]): string {
  if (!answers) return ''
  const wanted = keys ? new Set(keys) : null
  return Object.keys(answers)
    .filter(k => (wanted ? wanted.has(k) : true))
    .filter(k => !isSignatureValue(answers[k]) && !isBlank(answers[k]))
    .sort()
    .map(k => `${k}\u001F${canonical(answers[k])}`)
    .join('\u001E')
}

/** cyrb53: a small, fast string hash. A UX hint only — collisions cost a missed warning, nothing more. */
function hash(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/**
 * The device-only fingerprint of what a signature covers.
 *
 * @param ownAnswers   the answers of the form the signature is on
 * @param ownKeys      that form's non-signature keys
 * @param roundEntries every asset's stored answers — read only for a ROUND signature
 */
export function coveredFingerprint(
  scope: SignatureScope,
  ownAnswers: Record<string, unknown> | undefined,
  ownKeys: string[] | undefined,
  roundEntries?: Pick<LogSheetEntryData, 'assetId' | 'formData'>[]
): string {
  let text = canonicalAnswers(ownAnswers, ownKeys)
  if (scope === 'ROUND') {
    const entries = [...(roundEntries ?? [])].sort((a, b) =>
      String(a.assetId).localeCompare(String(b.assetId), 'en', { numeric: true }))
    for (const e of entries) {
      text += `\u001Da${e.assetId}\u001F${canonicalAnswers(e.formData)}`
    }
  }
  return hash(text)
}

/**
 * The verdict to show.
 *
 * @param localFingerprint  on the value when this device drew it (dropped by the server)
 * @param baseline          taken when a VALID signature arrived from the server
 * @param current           the fingerprint of the covered answers right now
 */
export function signatureVerdict(input: {
  scope: SignatureScope
  serverState?: string
  localFingerprint?: string
  baseline?: string
  current: string
}): SignatureVerdict {
  if (input.scope === 'NONE' || input.serverState === 'NOT_BOUND') return 'not-bound'
  if (input.localFingerprint) {
    // Drawn here and not yet replaced by the server's copy: this device is the one that knows.
    return input.localFingerprint === input.current ? 'unknown' : 'stale'
  }
  if (input.serverState === 'STALE') return 'stale'
  if (input.baseline && input.baseline !== input.current) return 'stale'
  if (input.serverState === 'VALID') return 'valid'
  return 'unknown'
}

/**
 * Baselines for the signatures a bundle reports VALID, taken from the answers that bundle
 * delivered — and only where the device took the server's answers. Where this device's own edits
 * won the merge, the answers on the device are not the ones the server judged, so no baseline is
 * taken and the server's verdict stands alone until the next sync.
 */
export function signatureBaselines(input: {
  states: Record<string, string> | undefined
  sheetFormData: Record<string, unknown> | undefined
  sheetFields: FieldDefinition[] | undefined
  sheetFormFromServer: boolean
  entries: LogSheetEntryData[]
}): Record<string, string> {
  const out: Record<string, string> = {}
  const states = input.states ?? {}
  const entriesFromServer = input.entries.every(e => e.locallyEditedAt == null)
  for (const [key, state] of Object.entries(states)) {
    if (state !== 'VALID') continue
    const sep = key.indexOf(':')
    if (sep < 0) continue
    const owner = key.slice(0, sep)
    const fieldKey = key.slice(sep + 1)
    if (owner === SHEET_OWNER) {
      if (!input.sheetFormFromServer) continue
      const value = input.sheetFormData?.[fieldKey]
      const def = input.sheetFields?.find(f => f.key === fieldKey)
      const scope = scopeOfValue(value, scopeOfField(def))
      if (scope === 'ROUND' && !entriesFromServer) continue
      const keys = input.sheetFields?.filter(f => f.dataType !== 'signature').map(f => f.key)
      out[key] = coveredFingerprint(scope, input.sheetFormData, keys, input.entries)
    } else {
      const entry = input.entries.find(e => String(e.assetId) === owner)
      if (!entry || entry.locallyEditedAt != null) continue
      out[key] = coveredFingerprint('FORM', entry.formData, undefined)
    }
  }
  return out
}
