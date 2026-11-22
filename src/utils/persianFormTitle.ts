const PERSIAN = /[\u0600-\u06FF]/

function hasPersian(value: string): boolean {
  return PERSIAN.test(value)
}

/**
 * The form name shown on the tablet: the Persian title, fully, with no code and no English.
 *
 * Definitions are often stored as `CODE / English / عنوان فارسی` or `CODE - عنوان`. The fill
 * screen used to show the whole string on one truncated line plus the code underneath.
 */
export function persianFormTitle(title?: string | null): string {
  const raw = (title ?? '').replace(/\s+/g, ' ').trim()
  if (!raw || !hasPersian(raw)) return ''
  const parts = raw
    .split(/\s*(?:\/|\||—|–)\s*/)
    .map(part => part.trim())
    .filter(Boolean)
  const persianParts = parts.filter(hasPersian)
  if (persianParts.length > 0 && persianParts.length < parts.length) {
    return persianParts.join(' — ')
  }
  const stripped = raw.replace(/^[A-Za-z0-9][A-Za-z0-9_./ -]*\s*[-–—|/]\s*/, '').trim()
  if (stripped && hasPersian(stripped) && stripped.length < raw.length) return stripped
  return raw
}

/** English-only blurbs stay off the card. A Persian description is kept. */
export function persianFormDescription(description?: string | null): string {
  const raw = (description ?? '').replace(/\s+/g, ' ').trim()
  if (!raw || !hasPersian(raw)) return ''
  return raw
}
