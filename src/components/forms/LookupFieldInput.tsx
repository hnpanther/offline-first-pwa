import { Autocomplete, Chip, TextField } from '@mui/material'
import { useEffect, useMemo, useRef, useState, type HTMLAttributes } from 'react'
import { availability, searchList, type LookupAvailability } from '@/services/lookups/lookupStore'
import type { LookupOption } from '@/services/lookups/lookupTypes'
import {
  lookupChoiceText,
  lookupChoices,
  MAX_LOOKUP_CHOICES,
  normalizeLookupCode,
  toLookupValue,
  type LookupChoiceValue
} from '@/utils/lookupValue'

/**
 * A field that draws from a reference list (backend roadmap §31 Phase 2).
 *
 * <h3>Two modes, and the field always says which</h3>
 *
 * - **Search** — the list is on the device and its lease is running: the operator types, the
 *   device searches its own copy (Persian-folded, utils/persianSearch), and only active items are
 *   offered.
 * - **Code only** — the list is absent, still syncing, or its lease ended: the operator types the
 *   code (a badge number, a personnel code) and the server resolves it at sync. A code the list
 *   does not know is still accepted there and flagged, never refused.
 *
 * Never a silent empty list: the helper line names the mode and why (backend AGENTS.md #177).
 *
 * The value is `{ code, label }` (one) or an array of them. A recorded answer — stamped by the
 * server with its label and state — is shown as it was recorded, including a retired or unknown
 * item, and re-sent as it is; the server keeps an unchanged answer byte for byte.
 */
export interface LookupFieldInputProps {
  label: string
  listCode: string | undefined
  multi: boolean
  value: unknown
  onChange: (value: unknown) => void
  error?: string
  disabled?: boolean
}

const AVAILABILITY_TEXT: Record<Exclude<LookupAvailability, 'ready'>, string> = {
  absent: 'فهرست مرجع روی این دستگاه نیست — کد را وارد کنید؛ هنگام ارسال بررسی می‌شود.',
  syncing: 'فهرست مرجع هنوز کامل دریافت نشده — کد را وارد کنید؛ هنگام ارسال بررسی می‌شود.',
  expired: 'مهلت نگهداری فهرست مرجع روی این دستگاه تمام شده و پاک شد — کد را وارد کنید.'
}

type Option = LookupOption | LookupChoiceValue

function optionCode(o: Option | string): string {
  return typeof o === 'string' ? o : o.code
}

export function LookupFieldInput({
  label,
  listCode,
  multi,
  value,
  onChange,
  error,
  disabled
}: LookupFieldInputProps) {
  const chosen = useMemo(() => lookupChoices(value), [value])
  const [mode, setMode] = useState<LookupAvailability>('absent')
  const [options, setOptions] = useState<LookupOption[]>([])
  const [input, setInput] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const latest = useRef(0)

  useEffect(() => {
    let cancelled = false
    if (!listCode) {
      setMode('absent')
      return
    }
    void availability(listCode).then(a => { if (!cancelled) setMode(a) })
    return () => { cancelled = true }
  }, [listCode])

  useEffect(() => {
    if (mode !== 'ready' || !listCode) {
      setOptions([])
      return
    }
    const ticket = ++latest.current
    const timer = setTimeout(() => {
      void searchList(listCode, input).then(found => {
        if (ticket !== latest.current) return
        if (found == null) {
          // The copy stopped being usable between the two reads — its lease ended just now.
          setMode('expired')
          setOptions([])
          return
        }
        setOptions(found)
      })
    }, 150)
    return () => clearTimeout(timer)
  }, [mode, listCode, input])

  const searching = mode === 'ready'

  const commit = (next: LookupChoiceValue[]) => {
    if (next.length > MAX_LOOKUP_CHOICES) {
      setProblem(`بیش از ${MAX_LOOKUP_CHOICES} مورد قابل انتخاب نیست.`)
      return
    }
    setProblem(null)
    onChange(toLookupValue(next, multi))
  }

  /** What the operator picked or typed, as choices — a typed string is a code to resolve. */
  const toChoices = (raw: Array<Option | string>): LookupChoiceValue[] | null => {
    const out: LookupChoiceValue[] = []
    for (const item of raw) {
      if (typeof item === 'string') {
        const code = normalizeLookupCode(item)
        if (!code) {
          setProblem('کد نامعتبر است: فاصله یا نویسهٔ کنترلی ندارد و حداکثر ۱۰۰ نویسه است.')
          return null
        }
        const listed = options.find(o => o.code.toLowerCase() === code.toLowerCase())
        out.push(listed ? { code: listed.code, label: listed.label } : { code })
      } else {
        const kept = chosen.find(c => c.code.toLowerCase() === item.code.toLowerCase())
        out.push(kept ?? { code: item.code, label: item.label })
      }
    }
    return out
  }

  const helper = error
    ?? problem
    ?? (searching ? undefined : AVAILABILITY_TEXT[mode as Exclude<LookupAvailability, 'ready'>])

  const sharedProps = {
    options: options as Option[],
    freeSolo: !searching,
    filterOptions: (o: Option[]) => o,
    getOptionLabel: (o: Option | string) => typeof o === 'string' ? o : lookupChoiceText(o),
    isOptionEqualToValue: (a: Option, b: Option) => optionCode(a).toLowerCase() === optionCode(b).toLowerCase(),
    inputValue: input,
    onInputChange: (_: unknown, v: string) => setInput(v),
    disabled,
    noOptionsText: searching ? 'موردی پیدا نشد' : 'کد را بنویسید و Enter بزنید',
    renderOption: (props: HTMLAttributes<HTMLLIElement> & { key?: string }, o: Option) => {
      const { key, ...rest } = props
      return (
        <li key={key ?? optionCode(o)} {...rest}>
          <div>
            <div>{lookupChoiceText(o)}</div>
            {'detail' in o && o.detail ? <small style={{ opacity: 0.7 }}>{o.detail}</small> : null}
          </div>
        </li>
      )
    },
    renderInput: (params: object) => (
      <TextField
        {...params}
        label={label}
        error={!!error || !!problem}
        helperText={helper}
        inputProps={{ ...(params as { inputProps?: object }).inputProps, dir: 'auto' }}
      />
    )
  }

  if (multi) {
    return (
      <Autocomplete<Option, true, false, boolean>
        multiple
        {...sharedProps}
        value={chosen}
        onChange={(_, next) => {
          const choices = toChoices(next as Array<Option | string>)
          if (choices) {
            commit(choices)
            setInput('')
          }
        }}
        renderTags={(tags, getTagProps) => tags.map((tag, index) => {
          const { key, ...tagProps } = getTagProps({ index })
          const choice = typeof tag === 'string' ? { code: tag } : tag
          return (
            <Chip
              key={key}
              {...tagProps}
              size="small"
              color={'state' in choice && choice.state && choice.state !== 'ACTIVE' ? 'warning' : 'default'}
              label={lookupChoiceText(choice)}
            />
          )
        })}
      />
    )
  }

  return (
    <Autocomplete<Option, false, false, boolean>
      {...sharedProps}
      value={chosen[0] ?? null}
      onChange={(_, next) => {
        if (next == null) {
          commit([])
          return
        }
        const choices = toChoices([next as Option | string])
        if (choices) commit(choices)
      }}
    />
  )
}
