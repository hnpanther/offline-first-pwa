import { Autocomplete, Box, Button, Chip, TextField } from '@mui/material'
import { useEffect, useMemo, useRef, useState, type HTMLAttributes } from 'react'
import { availability, searchList, type LookupAvailability } from '@/services/lookups/lookupStore'
import { refreshLookup } from '@/services/lookups/lookupSync'
import {
  COMBOBOX_POPPER_STRATEGY,
  showLookupAvailabilityHint,
  type LookupFieldMode
} from './comboboxLayout'
import type { LookupOption } from '@/services/lookups/lookupTypes'
import {
  lookupChoiceText,
  lookupChoices,
  MAX_LOOKUP_CHOICES,
  normalizeLookupCode,
  toLookupValue,
  unlistedCodeFor,
  type LookupChoiceValue
} from '@/utils/lookupValue'

/** Title, then the code in parentheses in its own left-to-right run so a number in the title stays distinct. */
function LookupChoiceLabel({ choice }: { choice: LookupChoiceValue }) {
  const hasLabel = Boolean(choice.label && choice.label !== choice.code)
  const note =
    choice.state === 'INACTIVE' ? ' · غیرفعال'
      : choice.state === 'UNKNOWN' ? ' · خارج از فهرست'
        : !choice.state && !choice.label ? ' · بررسی هنگام ارسال'
          : ''
  return (
    <span>
      {hasLabel ? choice.label : choice.code}
      {hasLabel ? <> <bdi dir="ltr">({choice.code})</bdi></> : null}
      {note}
    </span>
  )
}

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
 * Two additions (backend roadmap §31, «A code the device copy does not have yet»):
 * - **«use this code»** — with `acceptsUnlistedCode`, a search that finds nothing ends with one
 *   explicit row recording the typed code, resolved by the server like code-only entry. Off unless
 *   the field's definition says so.
 * - **«به‌روزرسانی فهرست»** — online, fetches this one list now, for an item added since the last
 *   inbox pull.
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
  /** `validation.lookupAcceptsUnlistedCode` — offer «use this code» when a search finds nothing. */
  acceptsUnlistedCode?: boolean
}

/** The «use this code» row — not an item of the list, so it carries a marker of its own. */
interface UnlistedOption {
  code: string
  unlisted: true
}

const AVAILABILITY_TEXT: Record<Exclude<LookupAvailability, 'ready'>, string> = {
  absent: 'فهرست مرجع روی این دستگاه نیست — کد را وارد کنید؛ هنگام ارسال بررسی می‌شود.',
  syncing: 'فهرست مرجع هنوز کامل دریافت نشده — کد را وارد کنید؛ هنگام ارسال بررسی می‌شود.',
  expired: 'مهلت نگهداری فهرست مرجع روی این دستگاه تمام شده و پاک شد — کد را وارد کنید.'
}

type Option = LookupOption | LookupChoiceValue | UnlistedOption

function isUnlisted(o: Option | string): o is UnlistedOption {
  return typeof o !== 'string' && 'unlisted' in o
}

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
  disabled,
  acceptsUnlistedCode = false
}: LookupFieldInputProps) {
  const chosen = useMemo(() => lookupChoices(value), [value])
  // `pending` until the lease read returns. Starting at `absent` painted the long hint and then
  // removed it for every list that was actually ready — the field shortened, and a window
  // scrolled to the end of the form jumped. See comboboxLayout.ts.
  const [mode, setMode] = useState<LookupFieldMode>('pending')
  const [options, setOptions] = useState<LookupOption[]>([])
  const [input, setInput] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshNote, setRefreshNote] = useState<string | null>(null)
  // Bumped after a refresh, so the availability and the search are read again.
  const [generation, setGeneration] = useState(0)
  const latest = useRef(0)

  useEffect(() => {
    let cancelled = false
    if (!listCode) {
      setMode('absent')
      return
    }
    void availability(listCode).then(a => { if (!cancelled) setMode(a) })
    return () => { cancelled = true }
  }, [listCode, generation])

  const refresh = async () => {
    if (!listCode || refreshing) return
    setRefreshing(true)
    setRefreshNote(null)
    const outcome = await refreshLookup(listCode)
    setRefreshing(false)
    setRefreshNote(
      outcome === 'fetched' ? 'فهرست به‌روز شد.'
        : outcome === 'dropped' ? 'این فهرست دیگر برای لاگ‌شیت بازی از شما لازم نیست و از دستگاه پاک شد.'
          : 'به‌روزرسانی ممکن نشد؛ اتصال را بررسی کنید.'
    )
    setGeneration(g => g + 1)
  }

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
  }, [mode, listCode, input, generation])

  const searching = mode === 'ready'
  const unlistedCode = searching ? unlistedCodeFor(input, options.length, acceptsUnlistedCode) : null
  const shownOptions: Option[] = unlistedCode ? [{ code: unlistedCode, unlisted: true }] : options

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
      } else if (isUnlisted(item)) {
        // A code nobody has checked: no label, and the chip says the server will look it up.
        out.push({ code: item.code })
      } else {
        const kept = chosen.find(c => c.code.toLowerCase() === item.code.toLowerCase())
        out.push(kept ?? { code: item.code, label: item.label })
      }
    }
    return out
  }

  const helper = error
    ?? problem
    ?? refreshNote
    ?? (showLookupAvailabilityHint(mode)
      ? AVAILABILITY_TEXT[mode as Exclude<LookupAvailability, 'ready'>]
      : undefined)

  const sharedProps = {
    options: shownOptions,
    freeSolo: !searching,
    filterOptions: (o: Option[]) => o,
    getOptionLabel: (o: Option | string) =>
      typeof o === 'string' ? o : isUnlisted(o) ? o.code : lookupChoiceText(o),
    isOptionEqualToValue: (a: Option, b: Option) => optionCode(a).toLowerCase() === optionCode(b).toLowerCase(),
    inputValue: input,
    onInputChange: (_: unknown, v: string) => setInput(v),
    disabled,
    noOptionsText: searching ? 'موردی پیدا نشد' : 'کد را بنویسید و Enter بزنید',
    renderOption: (props: HTMLAttributes<HTMLLIElement> & { key?: string }, o: Option) => {
      const { key, ...rest } = props
      if (isUnlisted(o)) {
        return (
          <li key={key ?? `unlisted:${o.code}`} {...rest}>
            <div>استفاده از کد «{o.code}» — هنگام ارسال بررسی می‌شود</div>
          </li>
        )
      }
      return (
        <li key={key ?? optionCode(o)} {...rest}>
          <div>
            <div><LookupChoiceLabel choice={o} /></div>
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
    ),
    // Absolute popper hangs past the end of a window-scrolled form and the page jumps when it
    // flips. Fixed does not change scroll height. Same anchor inside the log-sheet dialog.
    slotProps: { popper: { popperOptions: { strategy: COMBOBOX_POPPER_STRATEGY } } }
  }

  // Online only, and only when there is a list to ask for. Offline the field already says why it
  // has nothing and takes a code.
  const refreshButton = listCode && typeof navigator !== 'undefined' && navigator.onLine ? (
    <Button size="small" variant="text" onClick={() => void refresh()} disabled={refreshing || disabled}
      sx={{ mt: 0.5, alignSelf: 'flex-start' }}>
      {refreshing ? 'در حال به‌روزرسانی فهرست…' : 'به‌روزرسانی فهرست'}
    </Button>
  ) : null

  if (multi) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column' }}>
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
              label={<LookupChoiceLabel choice={choice} />}
            />
          )
        })}
      />
      {refreshButton}
      </Box>
    )
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
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
    {refreshButton}
    </Box>
  )
}
