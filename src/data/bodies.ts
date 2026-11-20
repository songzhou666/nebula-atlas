import planetsData from './planets.json'

/** 天体完整定义（数值来自 NSSDC 行星事实表，文案为科普描述）。 */
export interface BodyDef {
  id: string
  name: string
  en: string
  kind: 'star' | 'planet' | 'moon'
  color: string
  radiusKm: number
  massKg: number
  earthMasses: number
  distanceMillionKm: number
  au: number
  rotationDays: number
  retrograde: boolean
  orbitalDays: number
  meanTempC: number
  tempRangeC?: number[]
  moons: number
  gravity: number
  texture: string
  blurb: string
  fact: string
}

export const BODIES = planetsData as unknown as BodyDef[]

/** 按 id 查找天体。 */
export function bodyById(id: string): BodyDef | undefined {
  return BODIES.find((b) => b.id === id)
}

/** 判断一段文字是否在指名某个天体（中文名或英文名包含即命中）。 */
export function matchBody(text: string): BodyDef | undefined {
  const normalized = text.trim().toLowerCase()
  if (normalized.length === 0) return undefined
  return BODIES.find(
    (b) => normalized.includes(b.name.toLowerCase()) || normalized.includes(b.en.toLowerCase()),
  )
}

/** 按与输入文字的相关度排序天体，用于"猜你想看"推荐。 */
export function suggestBodies(text: string, limit = 3): BodyDef[] {
  const hit = matchBody(text)
  if (hit) return [hit, ...BODIES.filter((b) => b.id !== hit.id).slice(0, limit - 1)]
  return BODIES.filter((b) => b.kind !== 'star').slice(0, limit)
}
