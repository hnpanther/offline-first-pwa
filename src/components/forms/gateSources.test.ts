import { describe, it, expect } from 'vitest'
import { resolveGateSources } from './gateSources'
import type { FieldDefinition, FieldValidation } from '@/types/sync'

/**
 * Which siblings a gated parameter watches — the decision that was wrong once, invisibly.
 *
 * The first version of the live colouring keyed its subscription off the form's `fieldPrefix`.
 * **Neither of this app's two forms passes one** — `LogSheetFillPage` and `SheetQuestionsCard`
 * both name their fields at the root — so every gated field resolved to «no siblings available»
 * and was silently suppressed: the band never coloured, the hint never changed, and the server
 * meanwhile judged the same reading correctly. Nothing in the suite could see it, because the
 * subscription lived inside a component and this project has no render tests.
 *
 * So the decision is a pure function now, and these are its cases. The first one is the
 * regression.
 */

const GATED: FieldValidation = {
  danger: { min: 4.5 },
  conditions: [{ when: { field: 'status', op: 'in', values: ['روشن'] } }]
}

function def(key: string, validation?: FieldValidation): FieldDefinition {
  return { key, validation } as unknown as FieldDefinition
}

describe('resolveGateSources', () => {
  it('REGRESSION: a form with no prefix still resolves its siblings', () => {
    // The bug: this returned nothing, so the subscription was disabled and the gate could
    // never hold. Both real callers are this shape.
    const plan = resolveGateSources(def('ampere', GATED), [def('status'), def('ampere', GATED)])

    expect(plan).toEqual({ names: ['status'], keys: ['status'] })
  })

  it('prefixes the watch name when the form namespaces its fields', () => {
    const plan = resolveGateSources(
      def('ampere', GATED),
      [def('status'), def('ampere', GATED)],
      'asset-7'
    )

    expect(plan).toEqual({ names: ['asset-7.status'], keys: ['status'] })
  })

  it('matches the gate key case-insensitively, as the server folds it', () => {
    // ux_field_definitions_class_key_lower already makes Status and status one field. An exact
    // match here would leave the gate pointing at nothing — and a gate that cannot hold
    // SUPPRESSES the field, so a configured danger band would never colour.
    const gated: FieldValidation = {
      danger: { min: 4.5 },
      conditions: [{ when: { field: 'Status', op: 'in', values: ['روشن'] } }]
    }
    const plan = resolveGateSources(def('ampere', gated), [def('status'), def('ampere', gated)])

    // Reported under the key the form actually has, so the evaluation finds the value.
    expect(plan).toEqual({ names: ['status'], keys: ['status'] })
  })

  it('an ungated field asks for nothing at all', () => {
    expect(resolveGateSources(def('ampere', { danger: { min: 4.5 } }), [def('status')]))
      .toBeUndefined()
    expect(resolveGateSources(def('ampere'), [def('status')])).toBeUndefined()
  })

  it('a gate whose parameter is not on this form resolves to nothing, not a partial list', () => {
    // The server refuses such a gate on save, so reaching it means this form is a slice that
    // does not hold the sibling. «Cannot judge here» beats judging against a missing answer.
    expect(resolveGateSources(def('ampere', GATED), [def('ampere', GATED)])).toBeUndefined()
  })

  it('several conditions naming several siblings are all watched, in order', () => {
    const multi: FieldValidation = {
      conditions: [
        { when: { field: 'status', op: 'in', values: ['روشن'] }, danger: { min: 4.5 } },
        { when: { field: 'mode', op: 'notIn', values: ['LOCAL'] }, danger: { min: 1 } }
      ]
    }
    const plan = resolveGateSources(
      def('ampere', multi),
      [def('status'), def('mode'), def('ampere', multi)]
    )

    expect(plan).toEqual({ names: ['status', 'mode'], keys: ['status', 'mode'] })
  })

  it('one sibling named by two conditions is watched once', () => {
    const twice: FieldValidation = {
      conditions: [
        { when: { field: 'status', op: 'in', values: ['روشن'] }, danger: { min: 4.5 } },
        { when: { field: 'status', op: 'in', values: ['راه‌اندازی'] }, danger: { min: 1 } }
      ]
    }
    const plan = resolveGateSources(def('ampere', twice), [def('status'), def('ampere', twice)])

    expect(plan?.names).toEqual(['status'])
  })

  it('a malformed gate asks for nothing rather than throwing mid-render', () => {
    const broken = { conditions: [{ when: {} }, { when: { op: 'in' } }, {}] } as FieldValidation
    expect(resolveGateSources(def('ampere', broken), [def('status')])).toBeUndefined()
  })
})
