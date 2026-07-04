import {
  getLocation,
  getPlantSystem,
  getMainFunction,
  getAssetClass,
  getLogSheetTemplate
} from '@/services/storage'

const TYPE_FA: Record<string, string> = {
  location: 'مکان',
  system: 'سیستم',
  mainFunction: 'تابع اصلی'
}

function entityLabel(name: string | undefined, code: string | undefined, id: string): string {
  const n = name?.trim()
  const c = code?.trim()
  if (n && c) return `${n} (${c})`
  if (n) return n
  if (c) return c
  return id
}

/** Parses stored scopeSummary (e.g. location:5) into a readable Persian label. */
export async function formatScopeSummary(
  scopeSummary: string,
  templateId?: string
): Promise<string> {
  if (!scopeSummary?.trim()) return '—'

  const colon = scopeSummary.indexOf(':')
  if (colon <= 0) return scopeSummary

  const type = scopeSummary.substring(0, colon).trim()
  const id = scopeSummary.substring(colon + 1).trim()
  const typeFa = TYPE_FA[type] ?? type

  let label = `${typeFa}: ${id}`

  if (type === 'location') {
    const loc = await getLocation(id)
    if (loc) label = `${typeFa}: ${entityLabel(loc.name, loc.code, id)}`
  } else if (type === 'system') {
    const sys = await getPlantSystem(id)
    if (sys) label = `${typeFa}: ${entityLabel(sys.name, sys.code, id)}`
  } else if (type === 'mainFunction') {
    const mf = await getMainFunction(id)
    if (mf) label = `${typeFa}: ${entityLabel(mf.name, mf.code, id)}`
  }

  if (templateId) {
    const tmpl = await getLogSheetTemplate(templateId)
    const classId = tmpl?.classId
    if (classId) {
      const cls = await getAssetClass(classId)
      if (cls?.name) label += ` · کلاس: ${cls.name}`
    }
  }

  return label
}
