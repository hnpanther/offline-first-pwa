import type { OperationalUnit } from '@/types'

/** Cached units only: a form link and caller scope must both permit filing. */
export function formFilingUnits(
  units: OperationalUnit[], linkedIds: string[], accessibleIds: string[], plantWide: boolean
): OperationalUnit[] {
  const linked = new Set(linkedIds)
  const accessible = new Set(accessibleIds)
  return units.filter(unit => linked.has(unit.id) && (plantWide || accessible.has(unit.id)))
}

export function defaultFilingUnit(units: OperationalUnit[], primary: string | null): string {
  return units.find(unit => unit.id === primary)?.id ?? units[0]?.id ?? ''
}
