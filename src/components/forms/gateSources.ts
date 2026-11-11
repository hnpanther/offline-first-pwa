import type { FieldDefinition } from '@/types/sync'
import { stateConditionFieldKeys } from '@/utils/fieldValidation'

/**
 * Which react-hook-form fields a gated parameter has to watch, and under which keys.
 *
 * <h2>Why this is its own module</h2>
 *
 * <p>It is the whole of the decision «does this field subscribe, and to what», and that decision
 * was wrong once in a way nothing could see. The first version keyed the subscription off the
 * form's `fieldPrefix`, which **neither** of this app's two forms passes — both name their fields
 * at the root — so every gated field resolved to «no siblings available» and was silently
 * suppressed: no colour, ever, while the server judged the same reading correctly. The feature
 * read as built and did nothing.
 *
 * <p>This project has no React render tests (vitest runs on `node`, there is no jsdom), so the
 * only way to pin that is to make the decision a pure function and test it. The component now
 * enables the subscription from **this** result rather than from a prefix, so the original
 * mistake is not expressible there any more.
 *
 * <h2>The two rules</h2>
 *
 * <ul>
 *   <li><b>Case-insensitive matching.</b> The server's key uniqueness is case-folded
 *       (`ux_field_definitions_class_key_lower`), so a gate written as `Status` must find the
 *       `status` parameter. Matching exactly would leave the gate pointing at nothing — and a
 *       gate that cannot match <em>suppresses</em> the field, so a danger band somebody
 *       configured would never colour and never alert on the device.</li>
 *   <li><b>All or nothing.</b> A gate naming a parameter this form does not have yields
 *       `undefined`, never a half-filled list: the server refuses such a gate on save, so
 *       reaching it means this form is a slice that does not contain the sibling, and the honest
 *       answer is «cannot judge here» rather than «judge against a missing answer».</li>
 * </ul>
 */
export interface GateWatchPlan {
  /** react-hook-form names, in gate order. */
  names: string[]
  /** The definition keys to report those values under, same order. */
  keys: string[]
}

export function resolveGateSources(
  def: Pick<FieldDefinition, 'validation'>,
  fields: Array<Pick<FieldDefinition, 'key'>>,
  fieldPrefix?: string
): GateWatchPlan | undefined {
  const wanted = stateConditionFieldKeys(def.validation)
  if (wanted.length === 0) return undefined

  const names: string[] = []
  const keys: string[] = []
  for (const key of wanted) {
    const target = fields.find(
      candidate => candidate.key?.toLowerCase() === key.toLowerCase()
    )
    if (!target?.key) return undefined
    keys.push(target.key)
    names.push(fieldPrefix ? `${fieldPrefix}.${target.key}` : target.key)
  }
  return { names, keys }
}
