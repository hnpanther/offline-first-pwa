/**
 * «Does this option match what the operator typed?» — for searching a long choice list
 * (backend roadmap §31, phase 1).
 *
 * **Matching only, never storage.** The stored answer is the option exactly as the server sent
 * it; normalising it would make a reading fail its own field's allow-list, which compares
 * case-sensitively and only trims.
 *
 * What is folded, and why each one matters on a plant tablet:
 *   - «ي» / «ى» → «ی» and «ك» → «ک»: an Arabic keyboard layout, or text pasted from an older
 *     system, types a different code point for the same letter;
 *   - ZWNJ, ZWJ and tatweel removed: «آب‌بند» and «آببند» are one word to a reader;
 *   - harakat removed: nobody types the diacritics an option may have been written with;
 *   - Persian and Arabic-Indic digits → Latin: «پمپ ۱۲» is found by «12», and the reverse;
 *   - lower case, and runs of whitespace collapsed.
 *
 * The panel has the same function (backend `static/js/choice-search.js`), and both run ONE table
 * of cases — `persianSearch.cases.json` here, `src/test/js/persian-search-cases.json` there, kept
 * byte-identical. Two implementations of «does this match» drift the first time either is fixed,
 * and the symptom is an option the tablet finds and the panel does not.
 */
export function normalizeForSearch(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u064A\u0649]/g, '\u06CC') // Arabic yeh, alef maksura -> Persian yeh
    .replace(/\u0643/g, '\u06A9') // Arabic kaf -> Persian keheh
    // Alternation, not a character class: a class holding ZWJ reads as a joined sequence.
    .replace(/\u200C|\u200D|\u0640/g, '') // ZWNJ, ZWJ, tatweel
    .replace(/[\u064B-\u065F\u0670]/g, '') // harakat and the superscript alef
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Whether `option` contains `query` once both are normalised; an empty query matches all. */
export function matchesSearch(option: unknown, query: unknown): boolean {
  const q = normalizeForSearch(query)
  return q === '' || normalizeForSearch(option).includes(q)
}
