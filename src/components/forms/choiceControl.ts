/**
 * How a choice field is drawn, and what a typed answer must look like (backend roadmap §31,
 * phase 1). Pure functions, in their own module for the reason `gateSources.ts` is: this project
 * has no React render tests (vitest runs on `node`, there is no jsdom), so a decision left
 * inside a component cannot be pinned by a test.
 */
import type { FormFieldOption } from '@/types'
import { normalizeForSearch } from '@/utils/persianSearch'

/**
 * Above this many options a list is searched rather than scrolled. The panel uses the same
 * number (`choice-search.js`), so one field behaves the same on both.
 */
export const CHOICE_SEARCH_THRESHOLD = 8

/** Mirrors the server's `FieldValidationSupport.MAX_CUSTOM_OPTION_LENGTH`. */
export const MAX_CUSTOM_ANSWER_LENGTH = 200

export interface ChoiceControlPlan {
  /** A combobox (search box over the list) instead of a plain select / column of checkboxes. */
  searchable: boolean
  /** The operator may write an answer that is not one of the options. */
  freeEntry: boolean
}

/**
 * - **Search is automatic** above the threshold and absent below it: a three-option list is
 *   faster read than searched, and nobody should have to configure a combobox.
 * - **Free entry is the field's own permission** (`validation.allowCustom`), and only with a
 *   vocabulary to step outside of — a choice field with no options already accepts anything.
 *   A free-entry field is always a combobox, because the text box is where the answer is written.
 *
 * An older build of this app ignores `allowCustom` and draws the list alone: a missing
 * convenience, never a refused reading, because the server decides what is accepted.
 */
export function planChoiceControl(optionCount: number, allowCustom: boolean | undefined): ChoiceControlPlan {
  const freeEntry = allowCustom === true && optionCount > 0
  return {
    searchable: freeEntry || optionCount > CHOICE_SEARCH_THRESHOLD,
    freeEntry
  }
}

/** Whether `value` is one of the options — the read-time test for «was this typed?». */
export function isListedOption(options: FormFieldOption[], value: unknown): boolean {
  if (value === undefined || value === null) return false
  const text = String(value).trim()
  return options.some(o => o.value === text)
}

/**
 * The option a typed text means, when it means one: «كمپرسور» typed with an Arabic kaf is the
 * listed «کمپرسور», and storing the typed spelling as a separate «دستی» answer would split one
 * answer into two in every report.
 */
export function findListedOption(options: FormFieldOption[], text: string): FormFieldOption | null {
  const wanted = normalizeForSearch(text)
  if (!wanted) return null
  return options.find(o => normalizeForSearch(o.value) === wanted || normalizeForSearch(o.label) === wanted) ?? null
}

/**
 * Why a typed answer cannot be stored, or null when it can. The same three rules the server
 * enforces — so the operator hears it while still at the equipment, not as a refused sync.
 */
export function customAnswerProblem(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return 'پاسخ خالی است.'
  if (Array.from(trimmed).length > MAX_CUSTOM_ANSWER_LENGTH) {
    return `پاسخ دستی حداکثر ${MAX_CUSTOM_ANSWER_LENGTH} نویسه است.`
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F-\u009F]/.test(trimmed)) {
    return 'پاسخ دستی نباید شکست خط یا نویسهٔ کنترلی داشته باشد.'
  }
  return null
}
