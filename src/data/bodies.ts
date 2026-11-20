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
  /** 卫星的母行星 id（只有 kind === 'moon' 时存在）。 */
  parent?: string
}

const RAW = planetsData as unknown as BodyDef[]

/**
 * 列表顺序：卫星紧跟在自己的母行星后面，方便图鉴成组浏览。
 * 所以 JSON 里卫星写在数组末尾也不会错位。
 */
export const BODIES: BodyDef[] = RAW.filter((b) => b.kind !== 'moon').flatMap((p) => [
  p,
  ...RAW.filter((m) => m.parent === p.id),
])

/** 按 id 查找天体。 */
export function bodyById(id: string): BodyDef | undefined {
  return BODIES.find((b) => b.id === id)
}
