/**
 * Minimal i18n without an external library.
 * We only support Persian, so a simple typed translation object is sufficient.
 * This can be extended to use i18next if multiple languages are needed later.
 */
import fa from './fa'

export const t = fa
export type { Translations } from './fa'
