/**
 * A choice field as a combobox — search over a long list, and free entry where the field allows
 * it (backend roadmap §31, phase 1). Used by `DynamicFormField` only when `planChoiceControl`
 * says so; a short list without free entry keeps the plain select / column of checkboxes.
 *
 * The stored value keeps the shape it always had — a string for `select`, a string[] for
 * `multiselect` — so nothing in the queue, the merge, the revisions or the server changes. A
 * typed answer is simply a string that is not one of the options, which is how the panel and the
 * reports recognise it («دستی»). The server is the boundary: it accepts one only for a field
 * whose frozen definition says `allowCustom`.
 *
 * Search is local — the options are already on the device — and goes through the normaliser the
 * panel shares (`utils/persianSearch.ts`), so a search finds the same options on both.
 */
import { Autocomplete, Chip, TextField, createFilterOptions } from '@mui/material'
import { useState } from 'react'
import type { ControllerRenderProps } from 'react-hook-form'
import type { FormFieldOption } from '@/types'
import type { FieldValidation } from '@/types/sync'
import { matchesSearch } from '@/utils/persianSearch'
import { evaluateOptionSeverity, type FieldValidationSeverity } from '@/utils/fieldValidation'
import { customAnswerProblem, findListedOption, isListedOption } from './choiceControl'

/**
 * The «add what I typed» row. A control character cannot be part of a real option — the server
 * refuses them in any answer — so it cannot collide with one.
 */
const ADD_PREFIX = '\u0001add:'

const isAddRow = (o: string) => o.startsWith(ADD_PREFIX)
const addRowText = (o: string) => o.slice(ADD_PREFIX.length)

// MUI's own filter is used only for its limit and stringification; the match is ours.
const baseFilter = createFilterOptions<string>()

interface ChoiceAutocompleteProps {
  multiple: boolean
  label: string
  options: FormFieldOption[]
  freeEntry: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  f: ControllerRenderProps<any, string>
  error?: string
  helper: { text: string; color?: 'warning.main' | 'error.main' } | null
  rangeSeverity: FieldValidationSeverity
  validation?: FieldValidation
}

function chipColor(severity: FieldValidationSeverity): 'error' | 'warning' | 'default' {
  if (severity === 'danger') return 'error'
  if (severity === 'warning') return 'warning'
  return 'default'
}

export function ChoiceAutocomplete({
  multiple,
  label,
  options,
  freeEntry,
  f,
  error,
  helper,
  rangeSeverity,
  validation
}: ChoiceAutocompleteProps) {
  // A refused typed answer is said beside the field, and nothing is stored.
  const [typedProblem, setTypedProblem] = useState<string | null>(null)
  const values = options.map(o => o.value)

  const labelOf = (value: string): string => {
    if (isAddRow(value)) return `افزودن «${addRowText(value)}» به‌عنوان پاسخ دستی`
    const listed = options.find(o => o.value === value)
    if (listed) return listed.label
    return `${value} · دستی`
  }

  /** A typed text to the value to store: the listed option it means, or itself; null if refused. */
  const resolveTyped = (text: string): string | null => {
    const listed = findListedOption(options, text)
    if (listed) return listed.value
    if (!freeEntry) return null
    const problem = customAnswerProblem(text)
    if (problem) {
      setTypedProblem(problem)
      return null
    }
    return text.trim()
  }

  const normalizeOne = (raw: string): string | null => {
    if (isAddRow(raw)) return resolveTyped(addRowText(raw))
    if (values.includes(raw)) return raw
    // freeSolo hands back the raw input on Enter — the same path as the add row.
    return resolveTyped(raw)
  }

  const filterOptions = (opts: string[], state: { inputValue: string; getOptionLabel: (o: string) => string }) => {
    const query = state.inputValue
    const matched = opts.filter(o => matchesSearch(labelOf(o), query) || matchesSearch(o, query))
    const limited = baseFilter(matched, { ...state, inputValue: '' })
    const text = query.trim()
    if (freeEntry && text && !findListedOption(options, text)) {
      return [...limited, ADD_PREFIX + text]
    }
    return limited
  }

  const helperText = typedProblem ?? helper?.text ?? null
  const helperColor = typedProblem ? 'error.main' : helper?.color
  const noOptionsText = freeEntry
    ? 'در فهرست نیست — بنویسید و «افزودن» را بزنید.'
    : 'گزینه‌ای پیدا نشد.'

  if (multiple) {
    const current: string[] = Array.isArray(f.value) ? f.value.map(v => String(v)) : []
    return (
      <Autocomplete<string, true, false, boolean>
        multiple
        freeSolo={freeEntry}
        options={values}
        value={current}
        disableCloseOnSelect
        autoHighlight
        clearOnBlur
        filterOptions={filterOptions}
        getOptionLabel={labelOf}
        noOptionsText={noOptionsText}
        onChange={(_, next) => {
          setTypedProblem(null)
          const out: string[] = []
          for (const raw of next) {
            const v = normalizeOne(String(raw))
            if (v != null && !out.includes(v)) out.push(v)
          }
          f.onChange(out)
        }}
        onBlur={f.onBlur}
        renderTags={(tagValues, getTagProps) =>
          tagValues.map((v, index) => {
            const { key, ...tagProps } = getTagProps({ index })
            return (
              <Chip
                key={key}
                {...tagProps}
                size="small"
                label={labelOf(v)}
                // Per CHOICE, like the checkbox column it replaces: «one of these is the
                // dangerous one» is what the operator needs to see. A typed answer is never one.
                color={chipColor(evaluateOptionSeverity(v, validation))}
                variant={isListedOption(options, v) ? 'filled' : 'outlined'}
              />
            )
          })
        }
        renderInput={params => (
          <TextField
            {...params}
            inputRef={f.ref}
            name={f.name}
            label={label}
            placeholder={freeEntry ? 'جستجو یا نوشتن پاسخ…' : 'جستجو…'}
            error={!!error || !!typedProblem}
            helperText={helperText}
            FormHelperTextProps={helperColor ? { sx: { color: helperColor, fontWeight: 600 } } : undefined}
          />
        )}
      />
    )
  }

  const single = f.value === '' || f.value == null ? null : String(f.value)
  return (
    <Autocomplete<string, false, false, boolean>
      freeSolo={freeEntry}
      options={values}
      value={single}
      autoHighlight
      clearOnBlur
      filterOptions={filterOptions}
      getOptionLabel={labelOf}
      noOptionsText={noOptionsText}
      onChange={(_, next) => {
        setTypedProblem(null)
        if (next == null) {
          f.onChange('')
          return
        }
        const v = normalizeOne(String(next))
        if (v != null) f.onChange(v)
      }}
      onBlur={f.onBlur}
      renderInput={params => (
        <TextField
          {...params}
          inputRef={f.ref}
          name={f.name}
          label={label}
          placeholder={freeEntry ? 'جستجو یا نوشتن پاسخ…' : 'جستجو…'}
          error={!!error || !!typedProblem}
          helperText={helperText}
          FormHelperTextProps={helperColor ? { sx: { color: helperColor, fontWeight: 600 } } : undefined}
          sx={
            rangeSeverity === 'ok'
              ? undefined
              : {
                  '& .MuiOutlinedInput-notchedOutline': {
                    borderColor: rangeSeverity === 'danger' ? 'error.main' : 'warning.main',
                    borderWidth: 2
                  }
                }
          }
        />
      )}
    />
  )
}
