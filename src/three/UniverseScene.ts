import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import starsData from '../data/stars.json'
import { BODIES, type BodyDef } from '../data/bodies'
import { fallbackTexture, textureUrl } from '../data/textures'

export type { BodyDef }

interface StarDef {
  name: string
  con: string
  mag: number
  xyz: number[]
  rgb: number[]
}

interface SceneCallbacks {
  onSelect?: (id: string | null) => void
  onHover?: (id: string | null, x: number, y: number) => void
}

interface BodyNode {
  def: BodyDef
  mesh: THREE.Mesh
  orbitRadius: number
  displayRadius: number
  /** 当前公转相位（弧度）。 */
  angle: number
  /** 自转角速度（弧度/秒，已含速度倍率）。 */
  spin: number
  /** 公转角速度（弧度/秒）。 */
  orbitSpeed: number
  /** 卫星节点（月球挂到地球下）。 */
  parent?: BodyNode
  /** 行星环：独立于行星网格，避免跟着行星自转一起飞转。 */
  ring?: THREE.Mesh
  /** 云层壳：独立自转，比本体略快，制造巨行星的大气流动感。 */
  cloud?: THREE.Mesh
  /** 云层自转累计角。 */
  cloudAngle?: number
  /** 夜半球城市灯光叠加层（ShaderMaterial + AdditiveBlending）。 */
  night?: THREE.Mesh
  /** 卫星轨道导引线：仅在聚焦母行星系统时显示，远景下不显示，避免画面杂乱。 */
  moonOrbit?: THREE.Line
}

/**
 * 单个尾迹粒子：从彗头释放后独立运动、随时间变暗消散。
 * 正因为粒子不跟随彗头，尾巴才会像飞机尾迹一样“留在身后”。
 */
interface TailParticle {
  age: number
  life: number
  px: number
  py: number
  pz: number
  vx: number
  vy: number
  vz: number
  r: number
  g: number
  b: number
}

/**
 * 彗星：彗头光点 + 两条粒子池尾巴。
 * 离子尾细、直、严格背向太阳；尘埃尾宽、沿轨道后方弯曲。
 * 轨道为椭圆，越靠近太阳（近日点）尾巴越长越亮。
 */
interface Comet {
  head: THREE.Sprite
  ion: THREE.Points
  dust: THREE.Points
  ionGeo: THREE.BufferGeometry
  dustGeo: THREE.BufferGeometry
  ionPos: Float32Array
  ionCol: Float32Array
  dustPos: Float32Array
  dustCol: Float32Array
  ionPool: TailParticle[]
  dustPool: TailParticle[]
  cursorIon: number
  cursorDust: number
  emitIon: number
  emitDust: number
  orbitRadius: number
  /** 轨道偏心率（0 为圆）。 */
  ecc: number
  angle: number
  speed: number
  tilt: number
  prev: THREE.Vector3
}

const STARS = starsData as unknown as StarDef[]

/**
 * 显示半径：幂律压缩（指数 0.82，地球基准 1.85）。
 * 指数越接近 1 越贴近真实比例；取 0.82 时：
 * 木星/地球 = 7.13（真实 10.97）、土星 6.14（9.14）、天王星 3.10（3.98）、
 * 火星 0.60（0.53）、水星 0.46（0.38）——由内到外的量级关系全部正确，
 * 巨行星被压缩约三分之一，内行星最多放大 19%，换取默认视距下都能看见。
 * 太阳按 17 截断：裸算半径 87，会把水星轨道（24.3）整个包进太阳本体里；
 * 截到 17 后水星轨道仍在太阳表面之外 7 个场景单位，同时太阳直径仍比木星大 29%，
 * 不会出现「木星和太阳一样大」的观感。
 */
function displayRadius(radiusKm: number): number {
  const ratio = radiusKm / 6371
  return Math.min(17, 1.85 * Math.pow(ratio, 0.82))
}

/**
 * 卫星显示半径：在同一个幂律上再乘 0.78。
 * 幂律对小球是放大的（月球裸算 0.345 倍地球），乘 0.78 后落到 0.269，
 * 与真实的地月半径比 0.273 只差 1.4%——这也是用户最容易察觉的一组比例。
 */
function satelliteRadius(radiusKm: number): number {
  return displayRadius(radiusKm) * 0.78
}

/** 轨道半径：把天文单位映射到场景单位，内行星要留出太阳本体之外的空间。 */
function orbitRadius(au: number): number {
  return 20 + au * 11
}

/**
 * 行星系统的实际占位半径：本体、行星环、最外层卫星轨道三者取最大。
 * 土星环外径是本体半径的 2.3 倍，木星最外层的木卫四轨道达到木星半径的 2.75 倍，
 * 这些「看不见的边界」比本体大得多，只按本体算间距会让卫星轨道扫进隔壁行星。
 */
function systemExtent(def: BodyDef): number {
  const bodyRadius = displayRadius(def.radiusKm)
  if (def.kind !== 'planet') return bodyRadius
  let extent = bodyRadius
  if (def.id === 'saturn') extent = Math.max(extent, bodyRadius * 2.3)
  for (const moon of BODIES) {
    if (moon.parent !== def.id) continue
    const factor = MOON_ORBIT_FACTOR[moon.id] ?? 1.8
    extent = Math.max(extent, bodyRadius * factor + satelliteRadius(moon.radiusKm))
  }
  return extent
}

/**
 * 行星轨道半径表：真实 AU 映射优先，但相邻行星之间必须留出双方系统占位再外加 3 个单位的余量。
 * 内行星按真实间距换算到场景里过窄（金星 27.95 与地球 31 只差 3.05，
 * 而两者半径之和已有 3.62），公转时必然互相穿过，因此取两者中较大的半径。
 */
function planetOrbitRadii(): Map<string, number> {
  const radii = new Map<string, number>()
  // 从太阳表面起算：太阳本体半径已经占掉 17 个场景单位。
  let prevRadius = 0
  let prevExtent = displayRadius(695700)
  for (const def of BODIES) {
    if (def.kind !== 'planet') continue
    const extent = systemExtent(def)
    const radius = Math.max(orbitRadius(def.au), prevRadius + prevExtent + extent + 3)
    radii.set(def.id, radius)
    prevRadius = radius
    prevExtent = extent
  }
  return radii
}

/** 生成巨行星云带贴图：水平条带 + 随机亮度，用 alpha 通道勾出云带形状。 */
function cloudTexture(): THREE.CanvasTexture {
  const w = 512
  const h = 256
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  // 背景必须透明，否则云层球会变成不透明的黑色壳。
  ctx.clearRect(0, 0, w, h)
  let seed = 7
  const rand = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  let y = 0
  while (y < h) {
    const band = 6 + rand() * 22
    const bright = 90 + rand() * 120
    const grad = ctx.createLinearGradient(0, y, 0, y + band)
    grad.addColorStop(0, 'rgba(255,255,255,0)')
    grad.addColorStop(0.5, `rgba(255,255,255,${bright / 255})`)
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, y, w, band)
    y += band + 2 + rand() * 10
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/**
 * 自转时间倍率：场景秒对应的天数。
 * 取 0.25（1 秒 ≈ 6 小时），让类地行星几秒转一圈、巨行星几十秒一圈，
 * 与真实自转周期的相对关系保持一致，视觉上又不至于飞转。
 */
const SPIN_TIME_SCALE = 0.25

/**
 * 公转时间倍率：2π / 公转周期（天）× 该系数。
 * 自转与公转必须用不同的倍率：0.25 让地球 4 秒转一圈（看得清），
 * 6.1 让地球 60 秒公转一周（看得见位置变化）。两者之比 24.4
 * 就是「自转/公转」真实比例被整体压缩的倍数——所有天体压缩同一个常数，
 * 因此行星之间的相对速率关系仍然精确（水星/地球/木星的自转公转比误差一致）。
 * 若强行让比例等于真实值，地球需 0.16 秒转一圈（糊成一片），不具可看性。
 */
const ORBIT_TIME_SCALE = 6.1

/**
 * 卫星轨道半径：母行星显示半径的倍数，再加卫星自身半径。
 * 真实距离（木卫一到木星 6 倍半径、木卫四 27 倍）照搬会让木卫四压到土星轨道上，
 * 所以统一压缩到 1.55~2.9 倍：次序仍由内到外，也不会越出母行星轨道范围。
 */
const MOON_ORBIT_FACTOR: Record<string, number> = {
  moon: 1.65,
  io: 1.55,
  europa: 1.9,
  ganymede: 2.3,
  callisto: 2.75,
  titan: 2.9,
  triton: 2.6,
}

/**
 * 巨行星卫星的公转倍率（天 → 秒）。
 * 用行星的 6.1 会让木卫一 0.29 秒绕木星一圈，直接糊成频闪；
 * 0.3 让木卫一约 5.9 秒一圈，卫星之间仍保持真实周期比
 * （木卫一 : 木卫二 : 木卫三 : 木卫四 = 1 : 2.01 : 4.04 : 9.44）。
 * 地月系不套用这个倍率，仍按行星基准，保证「地球一年内 13.37 次月相」的关系。
 */
const MOON_TIME_SCALE = 0.3

/**
 * 初始公转相位（弧度，从 +x 轴起算）。
 * 用固定值而不是随机数：一是每次打开画面一致、截图可复现；
 * 二是让行星落在太阳背离相机的一侧（接近冲日），默认视角看到的是受光面，
 * 不会随机出现"土星只有一圈黑环"的夜半球构图。
 */
const START_ANGLE: Record<string, number> = {
  mercury: 0.9,
  venus: 2.1,
  earth: 0.35,
  mars: 1.85,
  jupiter: 0.45,
  saturn: 2.75,
  uranus: 1.2,
  neptune: 5.7,
}
/** 各行星自转轴倾角（度），来自 NASA NSSDC 行星事实表。
 * 天王星 97.8° = 几乎躺着转，是太阳系独一份。 */
const AXIAL_TILT_DEG: Record<string, number> = {
  sun: 7.25, mercury: 0.03, venus: 177.4, earth: 23.44, moon: 6.68,
  mars: 25.19, jupiter: 3.13, saturn: 26.73, uranus: 97.77, neptune: 28.32,
}

/** 聚焦时升级用的 4k 高清贴图（原始 8k 已按 4096×2048 重采样，兼顾清晰度与流量）。 */
const HIRES_TEXTURE: Record<string, string> = {
  sun: '4k_sun.webp',
  jupiter: '4k_jupiter.webp',
  saturn: '4k_saturn.webp',
  mars: '4k_mars.webp',
  moon: '4k_moon.webp',
}

/** 生成太阳光晕贴图。 */
function glowTexture(): THREE.CanvasTexture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255, 236, 190, 1)')
  g.addColorStop(0.25, 'rgba(255, 190, 110, 0.55)')
  g.addColorStop(0.6, 'rgba(255, 140, 60, 0.14)')
  g.addColorStop(1, 'rgba(255, 120, 40, 0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return new THREE.CanvasTexture(canvas)
}

/**
 * 生成星点用的软光圆斑贴图。
 * PointsMaterial 默认画方块，必须给一张径向渐变的 map 才是圆形光点。
 */
function starSpriteTexture(): THREE.CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255, 255, 255, 1)')
  g.addColorStop(0.3, 'rgba(255, 255, 255, 0.85)')
  g.addColorStop(0.65, 'rgba(255, 255, 255, 0.18)')
  g.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return new THREE.CanvasTexture(canvas)
}

/**
 * 把「高光强度图」反相重映射成「粗糙度图」。
 * SolarsystemScope 的 specular map 中白色表示海洋（高光强）、黑色表示陆地（无高光）。
 * 若直接当 roughnessMap 用，语义正好相反：陆地 roughness=0 会变成镜面，
 * 相机视角里出现刺眼白点。这里反相并把海洋下限压到 0.38，
 * 只保留海洋上一片宽阔柔和的反光，不出现镜面级硬高光。
 */
function roughnessFromSpecular(src: THREE.Texture): THREE.CanvasTexture | null {
  const img = src.image as (HTMLImageElement | HTMLCanvasElement | undefined)
  if (!img || !img.width) return null
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img as CanvasImageSource, 0, 0)
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
  for (let i = 0; i < data.data.length; i += 4) {
    const s = data.data[i]! / 255
    const v = Math.round(255 * (0.38 + 0.62 * (1 - s)))
    data.data[i] = v
    data.data[i + 1] = v
    data.data[i + 2] = v
  }
  ctx.putImageData(data, 0, 0)
  const tex = new THREE.CanvasTexture(canvas)
  // 粗糙度是数据贴图，不能按 sRGB 解码。
  tex.colorSpace = THREE.NoColorSpace
  return tex
}

/** 生成土星环贴图（径向条纹 + 透明度变化）。 */
function ringTexture(): THREE.CanvasTexture {
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.28, size / 2, size / 2, size * 0.5)
  g.addColorStop(0, 'rgba(210, 190, 150, 0)')
  g.addColorStop(0.18, 'rgba(214, 196, 160, 0.85)')
  g.addColorStop(0.32, 'rgba(190, 170, 130, 0.35)')
  g.addColorStop(0.5, 'rgba(220, 205, 175, 0.9)')
  g.addColorStop(0.72, 'rgba(180, 160, 120, 0.25)')
  g.addColorStop(0.9, 'rgba(200, 185, 150, 0.55)')
  g.addColorStop(1, 'rgba(200, 185, 150, 0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return new THREE.CanvasTexture(canvas)
}

/**
 * 太阳系 + 星表场景。负责渲染、动画、相机、点击拾取；
 * 通过回调把交互事件交给 React 层。
 */
export class UniverseScene {
  private readonly container: HTMLElement
  private readonly cb: SceneCallbacks
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly composer: EffectComposer
  private readonly bloom: UnrealBloomPass
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private readonly nodes = new Map<string, BodyNode>()
  private readonly pickables: THREE.Mesh[] = []
  private readonly starGroup = new THREE.Group()
  /** 星点分层材质：记录基础透明度与相位，用于呼吸式闪烁。 */
  private readonly starLayers: { mat: THREE.PointsMaterial; base: number; phase: number; speed: number }[] = []
  /** 彗星列表。 */
  private readonly comets: Comet[] = []
  /** 开场推进动画状态。 */
  private intro = false
  private introT = 0
  private readonly introFrom = new THREE.Vector3()
  private readonly introTo = new THREE.Vector3()
  /** 太阳在屏幕归一化坐标系的投影缓存，用于驱动 CSS 眩光层。 */
  private readonly sunNdc = new THREE.Vector3()
  private readonly clock = new THREE.Clock()
  private raf = 0
  private paused = false
  /** 公转速度倍率（滑动条控制）。 */
  private orbitScale = 1
  /** 自转速度倍率（滑动条控制）。 */
  private spinScale = 1
  private focusTarget = new THREE.Vector3()
  /** 聚焦时的横向构图偏移（相对天体世界坐标）。 */
  private focusOffset = new THREE.Vector3()
  /** 持续跟随的天体；聚焦后行星仍在公转，相机要跟着平移。 */
  private followId: string | null = null
  private focusDistance = 0
  private focusing = false
  /** 拥有卫星的母行星 id 集合（地球、木星、土星、海王星）。 */
  private readonly moonParents = new Set<string>()
  /** 当前显示卫星轨道导引线的母行星 id；null 表示不显示。 */
  private moonGuideParent: string | null = null
  private downX = 0
  private downY = 0
  private disposed = false
  /** 页面是否可见：切到后台时挂起整条渲染管线，避免空转耗电。 */
  private pageVisible = !document.hidden

  constructor(container: HTMLElement, cb: SceneCallbacks = {}) {
    this.container = container
    this.cb = cb
    const width = container.clientWidth || 1
    const height = container.clientHeight || 1

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(width, height)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0
    container.appendChild(this.renderer.domElement)

    // 太空底色用纯黑，保留深空那种巨大的漆黑与空洞感。
    this.scene.background = new THREE.Color('#000000')
    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 6000)
    // 开场推进：从高处远处沿同一视线推近到默认侧视机位，避免终点被某颗行星挡住。
    this.introFrom.set(560, 480, 860)
    this.introTo.set(340, 210, 520)
    this.camera.position.copy(this.introFrom)
    this.intro = true
    this.introT = 0

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.06
    this.controls.minDistance = 8
    this.controls.maxDistance = 1400
    // 开场期间锁住交互，避免用户一上来就打乱运镜。
    this.controls.enabled = false

    this.buildLights()
    this.buildMilkyway()
    this.buildStarfield()
    this.buildBodies()
    this.buildComets()

    this.composer = new EffectComposer(this.renderer)
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.composer.setSize(width, height)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.42, 0.34, 0.5)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())

    this.bindEvents()
    this.animate()
  }

  /** 场景灯光：太阳点光源 + 环境光。 */
  private buildLights(): void {
    const sun = new THREE.PointLight(0xfff2d8, 2.0, 0, 0)
    this.scene.add(sun)
    this.scene.add(new THREE.AmbientLight(0x33415c, 0.5))
  }

  /**
   * 背景银河：一个极大的内表面球，贴 SolarsystemScope 的真实银河全景图（8192×4096 等距柱状）。
   * 图像本身自带真实星点与银河尘埃带，取代原先程序化生成的噪点银河——
   * 程序化方案在贴图左右边界无法真正闭合，旋转时会出现接缝。
   * 挂在 starGroup 下随星点一起极慢旋转，避免背景和星空各转各的。
   */
  private buildMilkyway(): void {
    const geo = new THREE.SphereGeometry(2800, 64, 48)
    const mat = new THREE.MeshBasicMaterial({
      side: THREE.BackSide,
      // 初始必须纯黑：贴图未加载完就显示灰色会先闪一帧灰底板。
      color: new THREE.Color(0x000000),
      depthWrite: false,
    })
    const loader = new THREE.TextureLoader()
    // 移动端用 4k：8192×4096 的 RGBA 贴图要占 130MB 以上显存，手机 GPU 容易直接失败。
    const file = Math.min(window.innerWidth, window.innerHeight) < 700 ? '4k_stars_milky_way.webp' : '8k_stars_milky_way.webp'
    loader.load(`./textures/${file}`, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace
      // 等距柱状天球贴图必须横向 Repeat，保证接缝处插值连续。
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      tex.anisotropy = 8
      mat.map = tex
      // 这张全景图本身极暗（平均亮度约 1/255，银道带也才 3/255），
      // 经 sRGB 解码后线性值还要再低一个数量级，不提亮几乎看不见。
      // 6 倍时银道带落在 10~20/255，既有层次又不会把星点糊成一片；
      // 更亮的星点由 ACES 的高光肩部压缩，不会硬切成白块。
      mat.color.setScalar(6)
      mat.needsUpdate = true
    })
    this.starGroup.add(new THREE.Mesh(geo, mat))
  }

  /** 用 HYG 亮星生成三层点云，按星等区分大小。 */
  private buildStarfield(): void {
    const sprite = starSpriteTexture()
    // 恒星统一推到远景球壳上：HYG 的 xyz 是秒差距，若按同比例放进场景，
    // 最近的恒星（比邻星 1.3 pc）只有 1 个场景单位，会落在太阳系内部，
    // 变成一堆穿插在行星之间的光点。只保留方向、统一放到远方，
    // 恒星退化为纯背景（半径 2400，天球银河壳在 2800）。
    const SHELL = 2400
    // 尺寸改成像素单位（sizeAttenuation=false）：背景恒星不该随镜头远近变大变小。
    const layers = [
      { max: 2.0, size: 3.2, alpha: 0.9 },
      { max: 4.0, size: 2.2, alpha: 0.6 },
      { max: 99, size: 1.3, alpha: 0.4 },
    ]
    layers.forEach((layer, index) => {
      const lower = index === 0 ? -1 : layers[index - 1]!.max
      const picked = STARS.filter((s) => s.mag <= layer.max && s.mag > lower)
      if (picked.length === 0) return
      const positions = new Float32Array(picked.length * 3)
      const colors = new Float32Array(picked.length * 3)
      picked.forEach((star, i) => {
        const [x, y, z] = star.xyz
        const len = Math.hypot(x, y, z) || 1
        positions[i * 3] = (x / len) * SHELL
        positions[i * 3 + 1] = (y / len) * SHELL
        positions[i * 3 + 2] = (z / len) * SHELL
        // 星等 → 亮度：真实天空每差 5 等亮度差 100 倍（6 等星只有 1 等星的 1%），
        // 直接照搬会让暗星彻底消失，这里用压缩到 0.28~1.0 的映射。
        // 不乘这个系数的话，2034 颗星会以同一透明度叠加，看起来"满天一样亮"，
        // 与真实夜空（少数亮星 + 大片暗星）不符。
        const bright = 0.28 + 0.72 * Math.min(1, Math.max(0, (6.5 - star.mag) / 6.5))
        colors[i * 3] = star.rgb[0] * bright
        colors[i * 3 + 1] = star.rgb[1] * bright
        colors[i * 3 + 2] = star.rgb[2] * bright
      })
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      const mat = new THREE.PointsMaterial({
        size: layer.size,
        map: sprite,
        vertexColors: true,
        sizeAttenuation: false,
        transparent: true,
        opacity: layer.alpha,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      // 记录每层的基础透明度与相位，animate 里做呼吸式闪烁。
      this.starLayers.push({
        mat,
        base: layer.alpha,
        phase: index * 2.1,
        speed: 0.6 + index * 0.35,
      })
      this.starGroup.add(new THREE.Points(geo, mat))
    })
    this.scene.add(this.starGroup)
  }

  /** 创建太阳与各行星网格、轨道线与自转/公转参数。 */
  private buildBodies(): void {
    const loader = new THREE.TextureLoader()
    // 一次性算好所有行星的轨道半径，保证相邻行星系统之间互不穿插。
    const orbitRadii = planetOrbitRadii()

    for (const def of BODIES) {
      const radius = def.kind === 'moon' ? satelliteRadius(def.radiusKm) : displayRadius(def.radiusKm)
      const geo = new THREE.SphereGeometry(radius, 48, 32)
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(def.color),
        roughness: 0.92,
        metalness: 0.02,
      })
      const mesh = new THREE.Mesh(geo, material)
      mesh.name = def.id

      // 贴图异步加载，失败时用程序化纹理兜底。
      loader.load(
        textureUrl(def.texture),
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace
          material.map = tex
          material.color.set('#ffffff')
          material.needsUpdate = true
          // 地球：额外加载 normal map（山脉立体感）与 specular map（海洋反光）。
          if (def.id === 'earth') {
            loader.load('./textures/2k_earth_normal_map.webp', (nTex) => {
              nTex.colorSpace = THREE.SRGBColorSpace
              material.normalMap = nTex
              material.normalScale.set(0.85, 0.85)
              material.needsUpdate = true
            })
            loader.load('./textures/2k_earth_specular_map.webp', (sTex) => {
              // specular map 白色=海洋高光、黑色=陆地，必须反相后才能当粗糙度图用，
              // 否则陆地变成镜面，会在相机视角里出现刺眼反光点。
              const rough = roughnessFromSpecular(sTex)
              if (rough) {
                material.roughnessMap = rough
                material.roughness = 1.0
                // 显式声明 uv2 之外的贴图槽，改变贴图集合后需要重新编译材质。
                material.needsUpdate = true
              } else {
                material.roughness = 0.95
              }
              material.metalness = 0.0
              material.needsUpdate = true
            })
          }
          // 月球不做法线贴图：Solar System Scope 没有提供月球法线图，
          // 由亮度反推的伪法线会把月海压成一块块突兀的凸起，反而失真。
          // 金星：被 50km 厚硫酸云完全包裹，从太空根本看不到地表。
          // 替换 daymap 为 atmosphere 贴图（SolarsystemScope 提供），
          // 外加一层半透明 cloud sphere（作为 mesh 子对象，随本体自转）增加轻微大气扰动。
          if (def.id === 'venus') {
            loader.load('./textures/2k_venus_atmosphere.webp', (atmTex) => {
              atmTex.colorSpace = THREE.SRGBColorSpace
              material.map = atmTex
              material.needsUpdate = true
              // 大气反射率高、近乎漫反射，降低 roughness 到 0.7 更像真实硫酸云。
              material.roughness = 0.7
            })
            const venusCloud = new THREE.Mesh(
              new THREE.SphereGeometry(radius * 1.02, 48, 32),
              new THREE.MeshStandardMaterial({
                color: 0xffd9a8,
                transparent: true,
                opacity: 0.25,
                depthWrite: false,
                roughness: 1,
                metalness: 0,
              }),
            )
            mesh.add(venusCloud)
          }
        },
        undefined,
        () => {
          material.map = new THREE.CanvasTexture(fallbackTexture(def.color, def.id.length * 977))
          material.needsUpdate = true
        },
      )

      const isSun = def.kind === 'star'
      const isMoon = def.kind === 'moon'

      const node: BodyNode = {
        def,
        mesh,
        displayRadius: radius,
        orbitRadius: isSun || isMoon ? 0 : (orbitRadii.get(def.id) ?? orbitRadius(def.au)),
        angle: START_ANGLE[def.id] ?? 0,
        // 自转速度：2π / 自转周期（天）× 时间缩放。
        // 注意不要再按 retrograde 取负号：金星 177.4°、天王星 97.8° 的倾角本身
        // 已经大于 90°，即"轴朝天"就代表逆行，再取负号会造成两次翻转、看起来反而顺行。
        spin: (Math.PI * 2 / Math.max(def.rotationDays, 0.2)) * SPIN_TIME_SCALE,
        orbitSpeed: isSun || isMoon ? 0 : (Math.PI * 2 / Math.max(def.orbitalDays, 1)) * ORBIT_TIME_SCALE,
      }

      if (isSun) {
        // 太阳本体：贴 SolarsystemScope 的 2k_sun.webp（有真实太阳黑子和日冕细节）
        // 作为 MeshStandardMaterial 的 albedo 贴图，替换纯 emissive color 的塑料感。
        const sunLoader = new THREE.TextureLoader()
        sunLoader.load('./textures/2k_sun.webp', (sunTex) => {
          sunTex.colorSpace = THREE.SRGBColorSpace
          material.map = sunTex
          material.needsUpdate = true
        })
        // 光晕：保留程序化 radial gradient 圆形 Sprite + AdditiveBlending，
        // 避免直接用长方形贴图产生"方形图"观感。
        const glow = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: glowTexture(),
            transparent: true,
            opacity: 0.5,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
        )
        glow.scale.setScalar(radius * 1.7)
        mesh.add(glow)
        material.emissive = new THREE.Color(def.color)
        material.emissiveIntensity = 0.8
      }

      if (def.id === 'saturn') {
        const inner = radius * 1.35
        const outer = radius * 2.3
        // 环用自定义着色器：贴图 + 阳光渐变 + 土星本体的几何阴影，
        // 保证“背对太阳的一侧真的会暗下去”（内置材质的自定义 uniform 上传不可靠）。
        const ringMaterial = new THREE.ShaderMaterial({
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
          uniforms: {
            uMap: { value: new THREE.Texture() }, // 由下方 TextureLoader 异步加载替换
            uSunPos: { value: new THREE.Vector3(0, 0, 0) },
            uPlanetPos: { value: new THREE.Vector3() },
            uPlanetRadius: { value: radius },
            uInner: { value: inner },
            uOuter: { value: outer },
          },
          vertexShader: [
            'uniform float uInner;',
            'uniform float uOuter;',
            'varying float vRadial;',
            'varying vec3 vWorld;',
            'varying vec3 vNormalW;',
            'void main() {',
            // 官方环贴图是「径向条带」：X 轴为内→外的径向距离，Y 轴为环绕方向。
            // 因此不能用 RingGeometry 的平面 UV，必须自己按几何半径算出归一化径向坐标。
            '  vRadial = clamp((length(position.xy) - uInner) / (uOuter - uInner), 0.0, 1.0);',
            '  vec4 wp = modelMatrix * vec4(position, 1.0);',
            '  vWorld = wp.xyz;',
            '  vNormalW = normalize(mat3(modelMatrix) * normal);',
            '  gl_Position = projectionMatrix * viewMatrix * wp;',
            '}',
          ].join('\n'),
          fragmentShader: [
            'uniform sampler2D uMap;',
            'uniform vec3 uSunPos;',
            'uniform vec3 uPlanetPos;',
            'uniform float uPlanetRadius;',
            'varying float vRadial;',
            'varying vec3 vWorld;',
            'varying vec3 vNormalW;',
            'void main() {',
            // 取条带中间行采样：X = 径向，Y = 环绕（该行在整圈上颜色一致）。
            '  vec4 tex = texture2D(uMap, vec2(vRadial, 0.5));',
            '  if (tex.a < 0.01) discard;',
            '  vec3 L = normalize(uSunPos - vWorld);',
            // 双面环：用绝对值让正反两面都受光，避免背面全黑。
            '  float diff = 0.35 + 0.65 * abs(dot(normalize(vNormalW), L));',
            '  vec3 awayDir = normalize(uPlanetPos - uSunPos);',
            '  vec3 rel = vWorld - uPlanetPos;',
            '  float along = dot(rel, awayDir);',
            '  float perp = length(rel - awayDir * along);',
            // 本体阴影：仅当环点位于土星背光侧（along > 0）且轴向投影落入本体半径内才变暗。
            '  float shadow = smoothstep(0.0, uPlanetRadius * 0.8, along)',
            '    * (1.0 - smoothstep(uPlanetRadius * 0.95, uPlanetRadius * 1.15, perp));',
            '  vec3 col = tex.rgb * diff * (1.0 - 0.9 * shadow);',
            '  gl_FragColor = vec4(col, tex.a);',
            '}',
          ].join('\n'),
        })
        // 192 段：近距离观察时环的外缘不会露出多边形棱角。
        const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 192), ringMaterial)
        // 环与土星本体使用相同的 Euler YXZ 顺序，保证 rotation.x 轴向倾角语义一致。
        ring.rotation.order = 'YXZ'
        ring.rotation.x = -Math.PI / 2 // 初始水平，animate 里每帧加土星本体的 tilt
        // 环不挂在行星网格下：否则会跟随土星自转一起高速旋转。
        this.scene.add(ring)
        node.ring = ring

        // 异步加载官方环 alpha 贴图（卡西尼环缝 + A/B/C 环密度差）。
        const ringLoader = new THREE.TextureLoader()
        ringLoader.load('./textures/8k_saturn_ring_alpha.png', (ringTex) => {
          ringTex.colorSpace = THREE.SRGBColorSpace
          // 径向条带只在中间行采样，纵向夹边避免上下边缘渗色。
          ringTex.wrapS = THREE.ClampToEdgeWrapping
          ringTex.wrapT = THREE.ClampToEdgeWrapping
          ringTex.anisotropy = 8
          ringTex.needsUpdate = true
          ringMaterial.uniforms.uMap.value = ringTex
        })
      }

      // 巨行星云层：独立自转的半透明云带壳，转速略快于本体，制造大气流动感。
      if (def.id === 'jupiter' || def.id === 'saturn') {
        const cloud = new THREE.Mesh(
          new THREE.SphereGeometry(radius * 1.02, 48, 32),
          new THREE.MeshStandardMaterial({
            color: new THREE.Color('#ffffff'),
            map: cloudTexture(),
            transparent: true,
            opacity: 0.4,
            roughness: 1,
            metalness: 0,
            depthWrite: false,
          }),
        )
        this.scene.add(cloud)
        node.cloud = cloud
        node.cloudAngle = Math.random() * Math.PI * 2
      }

      // 轴向倾角：Euler 必须用 'XYZ' 顺序。
      // 'XYZ' 对应矩阵 Rx * Ry * Rz：自转（Ry）发生在天体自身坐标系里，
      // 再由 Rx 把整根自转轴倾斜出去——这才是"轴倾斜、天体绕自己的轴自转"。
      // 若用 'YXZ'（Ry * Rx），每帧增加 rotation.y 会让自转轴绕黄道面极点进动，
      // 表现为轴在缓慢画圈，倾角方向不稳定。
      const tiltDeg = AXIAL_TILT_DEG[def.id] ?? 0
      mesh.rotation.order = 'XYZ'
      mesh.rotation.x = THREE.MathUtils.degToRad(tiltDeg)

      this.scene.add(mesh)
      this.nodes.set(def.id, node)
      this.pickables.push(mesh)
      if (def.kind === 'planet') this.addOrbitLine(node.orbitRadius)
    }

    // ===== 地球专属增强：云层 + 夜半球城市灯光 =====
    const earth = this.nodes.get('earth')
    if (earth) {
      // 1) 独立云层壳：挂在 scene 下，animate 里每帧同步地球位置，
      //    自转比本体快 25%（和木星土星一致），制造大气流动感。
      const cloudLoader = new THREE.TextureLoader()
      cloudLoader.load('./textures/2k_earth_clouds.webp', (cTex) => {
        cTex.colorSpace = THREE.SRGBColorSpace
        const cloud = new THREE.Mesh(
          new THREE.SphereGeometry(earth.displayRadius * 1.012, 48, 32),
          new THREE.MeshStandardMaterial({
            map: cTex,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
            roughness: 1,
            metalness: 0,
          }),
        )
        cloud.castShadow = false
        cloud.receiveShadow = false
        this.scene.add(cloud)
        earth.cloud = cloud
        earth.cloudAngle = Math.random() * Math.PI * 2
      })

      // 2) 夜半球城市灯光：ShaderMaterial 叠加层，AdditiveBlending，
      //    在 lambert < 0.25 的背阳面渐显，昼夜交界 smoothstep 避免生硬。
      const nightLoader = new THREE.TextureLoader()
      nightLoader.load('./textures/2k_earth_nightmap.webp', (nTex) => {
        nTex.colorSpace = THREE.SRGBColorSpace
        const nightMaterial = new THREE.ShaderMaterial({
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.FrontSide,
          uniforms: {
            uNightMap: { value: nTex },
            uSunPos: { value: new THREE.Vector3(0, 0, 0) },
          },
          vertexShader: [
            'varying vec2 vUv;',
            'varying vec3 vNormal;',
            'varying vec3 vWorld;',
            'void main() {',
            '  vUv = uv;',
            '  vNormal = normalize(normalMatrix * normal);',
            '  vec4 wp = modelMatrix * vec4(position, 1.0);',
            '  vWorld = wp.xyz;',
            '  gl_Position = projectionMatrix * viewMatrix * wp;',
            '}',
          ].join('\n'),
          fragmentShader: [
            'uniform sampler2D uNightMap;',
            'uniform vec3 uSunPos;',
            'varying vec2 vUv;',
            'varying vec3 vNormal;',
            'varying vec3 vWorld;',
            'void main() {',
            '  vec3 L = normalize(vWorld - uSunPos);',
            '  float lambert = dot(vNormal, L);',
            '  float nightFactor = 1.0 - smoothstep(-0.2, 0.25, lambert);',
            '  vec3 nightCol = texture2D(uNightMap, vUv).rgb;',
            '  // 城市灯光在完全背光处更亮，近昼夜交界处渐隐。',
            '  vec3 col = nightCol * (0.5 + nightFactor * 0.7);',
            '  gl_FragColor = vec4(col, nightFactor * 0.85);',
            '}',
          ].join('\n'),
        })
        const nightMesh = new THREE.Mesh(
          new THREE.SphereGeometry(earth.displayRadius * 1.001, 48, 32),
          nightMaterial,
        )
        this.scene.add(nightMesh)
        // 存到 BodyNode 上，animate 里每帧同步位置与更新 sun uniform。
        earth.night = nightMesh
      })
    }

    // 所有卫星都挂在 scene 下而非母行星 mesh 下：避免跟着行星自转转一圈，
    // 这样才能实现潮汐锁定（同一面永远朝向母星）。animate 里按母行星世界位置同步。
    for (const node of this.nodes.values()) {
      if (node.def.kind !== 'moon') continue
      const parent = node.def.parent ? this.nodes.get(node.def.parent) : undefined
      if (!parent) continue
      this.scene.add(node.mesh)
      const factor = MOON_ORBIT_FACTOR[node.def.id] ?? 2
      node.orbitRadius = parent.displayRadius * factor + node.displayRadius
      node.mesh.position.copy(parent.mesh.position).setX(parent.mesh.position.x + node.orbitRadius)
      node.parent = parent
      // 地月系沿用行星时间基准，其余卫星用更慢的卫星倍率（见 MOON_TIME_SCALE 注释）。
      const scale = node.def.parent === 'earth' ? ORBIT_TIME_SCALE : MOON_TIME_SCALE
      node.orbitSpeed =
        (Math.PI * 2 / Math.max(node.def.orbitalDays, 0.1)) * scale * (node.def.retrograde ? -1 : 1)
      // 潮汐锁定：卫星不自转（rotation.y 不增加），同一面永远朝向母星。
      node.spin = 0
      // 卫星轨道导引线：默认隐藏，聚焦母行星系统时才显示，
      // 否则木星、土星周围会一直挂着一圈圈细线，远景下反而很杂乱。
      node.moonOrbit = this.createOrbitLine(node.orbitRadius, '#37567f', 0.5)
      node.moonOrbit.visible = false
      this.scene.add(node.moonOrbit)
      this.moonParents.add(parent.def.id)
    }
  }

  /** 画一条轨道参考线。 */
  private addOrbitLine(radius: number): void {
    this.scene.add(this.createOrbitLine(radius, '#2b3a55', 0.45))
  }

  /**
   * 生成一条水平圆形轨道线（xz 平面），调用方决定是否加入场景。
   * @param radius 轨道半径（场景单位）
   * @param color 线条颜色
   * @param opacity 线条透明度
   */
  private createOrbitLine(radius: number, color: string, opacity: number): THREE.Line {
    const points: THREE.Vector3[] = []
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2
      points.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius))
    }
    const geo = new THREE.BufferGeometry().setFromPoints(points)
    return new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
    )
  }

  /** 生成两颗彗星：彗头光点 + 离子尾/尘埃尾粒子池，沿椭圆轨道绕太阳运行。 */
  private buildComets(): void {
    const sprite = starSpriteTexture()
    // 轨道用真实彗星的近日点 q 与远日点 Q（JPL）：哈雷 1P q=0.586 AU / Q=35.1 AU，
    // 恩克 2P q=0.336 AU / Q=4.08 AU。哈雷远日点已超出海王星轨道，会飞出太阳系再绕回来。
    // 公转周期直接取真实值（哈雷 76.0 年 = 27759 天，恩克 3.30 年 = 1205 天），
    // 再除以与行星相同的 ORBIT_TIME_SCALE——彗星和行星处在同一时间基准上，
    // 两者周期之比 23.1 与真实一致。代价是哈雷在场景里几乎不动（约 75 分钟一圈），
    // 这是 76 年真实周期的必然结果；恩克约 3.3 分钟一圈，负责提供可见的运动。
    // 彗核要小、尾迹要细密：彗核只是一个小亮核（靠 bloom 出辉光），
    // 尾迹靠「多而小」的粒子堆出连续感，而不是「少而大」的团块。
    // 公转方向：哈雷轨道倾角 162.3°，是太阳系里著名的逆行彗星（dir = -1）；
    // 恩克倾角 11.8°，与行星同向顺行（dir = +1）。
    // 此前两颗彗星的位置公式 z 用 +sin（行星用 -sin），导致它们一律逆行。
    // 初始相位取远日点附近（π）：两颗彗星都从太阳系外缘向内运动，而不是凭空出现在行星之间。
    // 哈雷远日点 35.1 AU 已在海王星轨道之外；恩克的真实轨道最远只到 4.08 AU（火星与木星之间），
    // 这是它轨道的上限，因此它表现为从内太阳系外缘飞入。
    const defs = [
      { q: 0.586, Q: 35.1, tilt: 0.3, phase: Math.PI + 0.08, periodDays: 27759, dir: -1, head: 0.85, ionSize: 0.34, dustSize: 0.55 },
      { q: 0.336, Q: 4.08, tilt: 0.14, phase: Math.PI + 0.12, periodDays: 1205, dir: 1, head: 0.72, ionSize: 0.3, dustSize: 0.48 },
    ]
    // 粒子池容量：按「发射率 × 寿命」估算，保证正常循环而不是互相顶替。
    const ION_N = 900
    const DUST_N = 1300
    for (const d of defs) {
      // 把真实近日点/远日点映射到场景半径，反推椭圆半长轴与偏心率。
      const rMin = orbitRadius(d.q)
      const rMax = orbitRadius(d.Q)
      const a = (rMin + rMax) / 2
      const ecc = (rMax - rMin) / (rMax + rMin)
      const head = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: sprite,
          color: new THREE.Color('#f4faff'),
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      )
      head.scale.setScalar(d.head)
      head.frustumCulled = false

      // 预分配粒子池，运行期只复用不新建，避免每帧产生垃圾。
      const ionPool: TailParticle[] = []
      for (let i = 0; i < ION_N; i++) {
        ionPool.push({ age: 0, life: 1, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, r: 0, g: 0, b: 0 })
      }
      const dustPool: TailParticle[] = []
      for (let i = 0; i < DUST_N; i++) {
        dustPool.push({ age: 0, life: 1, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, r: 0, g: 0, b: 0 })
      }

      const ionPos = new Float32Array(ION_N * 3)
      const ionCol = new Float32Array(ION_N * 3)
      const ionGeo = new THREE.BufferGeometry()
      ionGeo.setAttribute('position', new THREE.BufferAttribute(ionPos, 3))
      ionGeo.setAttribute('color', new THREE.BufferAttribute(ionCol, 3))
      const ion = new THREE.Points(
        ionGeo,
        new THREE.PointsMaterial({
          size: d.ionSize,
          map: sprite,
          vertexColors: true,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          sizeAttenuation: true,
        }),
      )
      ion.frustumCulled = false

      const dustPos = new Float32Array(DUST_N * 3)
      const dustCol = new Float32Array(DUST_N * 3)
      const dustGeo = new THREE.BufferGeometry()
      dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3))
      dustGeo.setAttribute('color', new THREE.BufferAttribute(dustCol, 3))
      const dust = new THREE.Points(
        dustGeo,
        new THREE.PointsMaterial({
          size: d.dustSize,
          map: sprite,
          vertexColors: true,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          sizeAttenuation: true,
        }),
      )
      dust.frustumCulled = false

      // 初始位置，供切向差分使用。z 取负号与行星一致，dir 决定顺行/逆行。
      const r0 = a * (1 - ecc * ecc) / (1 + ecc * Math.cos(d.phase))
      const prev = new THREE.Vector3(Math.cos(d.phase) * r0, Math.sin(d.phase) * r0 * d.tilt, -Math.sin(d.phase) * r0)
      head.position.copy(prev)

      this.scene.add(head)
      this.scene.add(ion)
      this.scene.add(dust)
      this.comets.push({
        head,
        ion,
        dust,
        ionGeo,
        dustGeo,
        ionPos,
        ionCol,
        dustPos,
        dustCol,
        ionPool,
        dustPool,
        cursorIon: 0,
        cursorDust: 0,
        emitIon: 0,
        emitDust: 0,
        orbitRadius: a,
        ecc,
        angle: d.phase,
        // 平均角速度 n = dir × 2π / 场景周期；场景周期 = 真实天数 / ORBIT_TIME_SCALE。
        // dir = +1 与行星同向（顺行），-1 为逆行。
        speed: (d.dir * Math.PI * 2) / (d.periodDays / ORBIT_TIME_SCALE),
        tilt: d.tilt,
        prev,
      })
    }
  }

  /** 释放一个离子尾粒子：严格沿背日方向飞出，几乎不继承轨道切向速度，故尾巴是直的。 */
  private spawnIon(c: Comet, anti: THREE.Vector3): void {
    const p = c.ionPool[c.cursorIon]!
    c.cursorIon = (c.cursorIon + 1) % c.ionPool.length
    const speed = 7 + Math.random() * 3.5
    p.age = 0
    p.life = 5 + Math.random() * 2.5
    p.px = c.head.position.x
    p.py = c.head.position.y
    p.pz = c.head.position.z
    p.vx = anti.x * speed + (Math.random() - 0.5) * 0.5
    p.vy = anti.y * speed + (Math.random() - 0.5) * 0.5
    p.vz = anti.z * speed + (Math.random() - 0.5) * 0.5
    p.r = 0.28
    p.g = 0.44
    p.b = 0.58
  }

  /**
   * 释放一个尘埃尾粒子：背日方向 + 继承彗星的轨道切向速度。
   * 切向分量让先释放的粒子落在轨道后方，尾巴自然弯曲成“扫帚”形；
   * 继承量取彗星当前的真实轨道速度，因此近日点弯曲、远日点趋直。
   */
  private spawnDust(c: Comet, anti: THREE.Vector3, tangent: THREE.Vector3, vOrb: number): void {
    const p = c.dustPool[c.cursorDust]!
    c.cursorDust = (c.cursorDust + 1) % c.dustPool.length
    const radial = 2 + Math.random() * 1.2
    p.age = 0
    p.life = 7 + Math.random() * 3
    p.px = c.head.position.x
    p.py = c.head.position.y
    p.pz = c.head.position.z
    p.vx = anti.x * radial + tangent.x * vOrb + (Math.random() - 0.5) * 0.5
    p.vy = anti.y * radial + tangent.y * vOrb + (Math.random() - 0.5) * 0.5
    p.vz = anti.z * radial + tangent.z * vOrb + (Math.random() - 0.5) * 0.5
    p.r = 0.4
    p.g = 0.36
    p.b = 0.26
  }

  /**
   * 推进彗星：彗头沿椭圆轨道前进，同时向粒子池发射新粒子。
   * 已释放的粒子按各自速度留在空间中运动、变暗，形成“留在身后”的拖尾。
   */
  private updateComets(dt: number): void {
    const tangent = new THREE.Vector3()
    const anti = new THREE.Vector3()
    for (const c of this.comets) {
      // 开普勒第二定律：dθ/dt = n·(1+e·cosθ)²/(1-e²)^1.5，近日点快、远日点慢。
      // 与行星一致，乘以用户可调的公转速率倍率。
      const n = c.speed
      const e = c.ecc
      const dTheta = (n * Math.pow(1 + e * Math.cos(c.angle), 2)) / Math.pow(1 - e * e, 1.5)
      c.angle += dTheta * this.orbitScale * dt
      // 椭圆轨道：r = a(1-e²)/(1+e·cosθ)，θ=0 为近日点。
      const r = (c.orbitRadius * (1 - c.ecc * c.ecc)) / (1 + c.ecc * Math.cos(c.angle))
      const x = Math.cos(c.angle) * r
      const y = Math.sin(c.angle) * r * c.tilt
      // z 取负号：与行星的 (cosθ, -sinθ) 同向，dir = -1 时才是逆行。
      const z = -Math.sin(c.angle) * r
      c.head.position.set(x, y, z)

      // 轨道切向：与上一帧位置差分（含 dir 的符号），避免解析求导的复杂度。
      tangent.set(x - c.prev.x, y - c.prev.y, z - c.prev.z)
      if (tangent.lengthSq() < 1e-8) {
        const s = c.speed < 0 ? -1 : 1
        tangent.set(-Math.sin(c.angle) * s, Math.cos(c.angle) * c.tilt * s, -Math.cos(c.angle) * s)
      }
      tangent.normalize()
      c.prev.set(x, y, z)

      // 太阳在原点，背日方向即位置向量的单位向量。
      anti.set(x, y, z).normalize()
      // 彗星当前的轨道速度（场景单位/秒）：v = r·dθ/dt。
      // 尘埃粒子继承这个切向速度，所以近日点尾巴明显弯曲、远日点接近直线，
      // 这比用椭圆平均速度更贴近真实（也避免了彗星慢下来后粒子反而"跑到前面"）。
      const vOrb = r * dTheta * this.orbitScale

      // 越靠近近日点，喷发越剧烈（发射率更高）。
      const rMin = c.orbitRadius * (1 - c.ecc)
      const rMax = c.orbitRadius * (1 + c.ecc)
      const activity = THREE.MathUtils.clamp((rMax - r) / Math.max(rMax - rMin, 1e-6), 0, 1)

      // 累积发射：按速率往池子里放粒子，帧率高低都不影响尾巴浓度。
      // 发射率与粒子寿命、池容量匹配（离子 58~134/s × 约 6s ≈ 800 粒，尘埃 44~106/s × 约 8.5s ≈ 900 粒）。
      c.emitIon += (58 + 76 * activity) * dt
      while (c.emitIon >= 1) {
        this.spawnIon(c, anti)
        c.emitIon -= 1
      }
      c.emitDust += (44 + 62 * activity) * dt
      while (c.emitDust >= 1) {
        this.spawnDust(c, anti, tangent, vOrb)
        c.emitDust -= 1
      }

      // 离子尾：粒子惯性飞行 + 寿命末期快速变暗（additive 下趋黑即消散）。
      for (let i = 0; i < c.ionPool.length; i++) {
        const p = c.ionPool[i]!
        p.age += dt
        const fade = Math.max(0, 1 - p.age / p.life)
        p.px += p.vx * dt
        p.py += p.vy * dt
        p.pz += p.vz * dt
        c.ionPos[i * 3] = p.px
        c.ionPos[i * 3 + 1] = p.py
        c.ionPos[i * 3 + 2] = p.pz
        const f = Math.pow(fade, 1.6)
        c.ionCol[i * 3] = p.r * f
        c.ionCol[i * 3 + 1] = p.g * f
        c.ionCol[i * 3 + 2] = p.b * f
      }
      c.ionGeo.getAttribute('position').needsUpdate = true
      c.ionGeo.getAttribute('color').needsUpdate = true

      // 尘埃尾：同离子尾，但寿命更长、扩散更明显。
      for (let i = 0; i < c.dustPool.length; i++) {
        const p = c.dustPool[i]!
        p.age += dt
        const fade = Math.max(0, 1 - p.age / p.life)
        p.px += p.vx * dt
        p.py += p.vy * dt
        p.pz += p.vz * dt
        c.dustPos[i * 3] = p.px
        c.dustPos[i * 3 + 1] = p.py
        c.dustPos[i * 3 + 2] = p.pz
        const f = Math.pow(fade, 1.4)
        c.dustCol[i * 3] = p.r * f
        c.dustCol[i * 3 + 1] = p.g * f
        c.dustCol[i * 3 + 2] = p.b * f
      }
      c.dustGeo.getAttribute('position').needsUpdate = true
      c.dustGeo.getAttribute('color').needsUpdate = true
    }
  }

  /** 绑定指针与尺寸事件。 */
  private bindEvents(): void {
    const dom = this.renderer.domElement
    dom.addEventListener('pointerdown', this.onPointerDown)
    dom.addEventListener('pointerup', this.onPointerUp)
    dom.addEventListener('pointermove', this.onPointerMove)
    dom.addEventListener('wheel', this.onWheel, { passive: true })
    window.addEventListener('resize', this.onResize)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
  }

  /**
   * 页面可见性切换：隐藏时停掉 rAF，回到前台再重新起播。
   * 浏览器在后台会压低帧率，但 EffectComposer + bloom 的每帧开销依然可观，
   * 手机切后台放置时会持续耗电，因此直接停掉整条渲染管线。
   */
  private onVisibilityChange = (): void => {
    this.pageVisible = !document.hidden
    if (!this.pageVisible) {
      cancelAnimationFrame(this.raf)
      return
    }
    // 后台期间 clock 仍在累计时间，先丢弃这段间隔，避免回到前台瞬间跳一大帧。
    this.clock.getDelta()
    if (!this.disposed) this.raf = requestAnimationFrame(this.animate)
  }

  private onPointerDown = (e: PointerEvent): void => {
    // 开场推进期间一旦用户操作，立即交还控制权。
    this.skipIntro()
    this.downX = e.clientX
    this.downY = e.clientY
  }

  /** 滚轮同样跳过开场推进。 */
  private onWheel = (): void => {
    this.skipIntro()
  }

  /** 跳过开场推进：结束运镜并启用交互。 */
  private skipIntro(): void {
    if (!this.intro) return
    this.intro = false
    this.controls.enabled = true
    this.controls.target.set(0, 0, 0)
  }

  /** 按下到抬起位移很小才算点击，避免旋转相机误触发选择。 */
  private onPointerUp = (e: PointerEvent): void => {
    if (Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > 6) return
    const id = this.pick(e)
    this.setSelected(id)
    // 点击即定位：直接聚焦到该天体，不再画高亮环。
    if (id) this.focusBody(id)
    this.cb.onSelect?.(id)
  }

  private onPointerMove = (e: PointerEvent): void => {
    const id = this.pick(e)
    this.container.style.cursor = id ? 'pointer' : 'grab'
    const rect = this.container.getBoundingClientRect()
    this.cb.onHover?.(id, e.clientX - rect.left, e.clientY - rect.top)
  }

  /** 射线拾取天体。 */
  private pick(e: PointerEvent): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObjects(this.pickables, false)
    return hits.length > 0 ? (hits[0].object.name || null) : null
  }

  private onResize = (): void => {
    if (this.disposed) return
    const width = this.container.clientWidth || 1
    const height = this.container.clientHeight || 1
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
    this.composer.setSize(width, height)
  }

  /** 主循环：自转、公转、星点缓转、高亮环朝向相机、聚焦过渡。 */
  private animate = (): void => {
    if (this.disposed || !this.pageVisible) return
    this.raf = requestAnimationFrame(this.animate)
    const dt = Math.min(this.clock.getDelta(), 0.05)

    // 开场推进：从远机位缓动飞到常规视角，结束或用户交互后交还控制权。
    if (this.intro) {
      this.introT += dt
      const t = Math.min(1, this.introT / 4.2)
      const ease = 1 - Math.pow(1 - t, 3)
      this.camera.position.lerpVectors(this.introFrom, this.introTo, ease)
      if (t >= 1) this.skipIntro()
    }

    if (!this.paused) {
      // 公转与自转分别受各自滑动条控制。
      const spinDt = dt * this.spinScale
      const orbitDt = dt * this.orbitScale
      for (const node of this.nodes.values()) {
        node.mesh.rotation.y += node.spin * spinDt
        if (node.parent) {
          // 月球：在 scene 下独立 mesh，公转位置 = 地球世界位置 + 公转偏移向量。
          // 正在近距离观察的卫星暂停绕母星公转：公转会在一两秒内把它转到夜半球，
          // 贴图刚看清就黑掉；移开焦点后自动恢复公转。
          if (this.followId !== node.def.id) node.angle += node.orbitSpeed * orbitDt
          const earthPos = node.parent.mesh.position
          node.mesh.position.set(
            earthPos.x + Math.cos(node.angle) * node.orbitRadius,
            earthPos.y + 0,
            earthPos.z - Math.sin(node.angle) * node.orbitRadius,
          )
          // 潮汐锁定：月球自转周期等于公转周期，同一面永远朝向地球。
          // 位置方向为 (cosθ, 0, -sinθ)，朝向地球需 ry = π + θ。
          node.mesh.rotation.y = Math.PI + node.angle
        } else if (node.orbitSpeed > 0) {
          node.angle += node.orbitSpeed * orbitDt
          // z 取负号：让公转方向与绕 +Y 轴自转（Ry 把 +X 转向 -Z）同向，
          // 即所有行星都顺行公转+顺行自转，符合太阳系角动量方向。
          node.mesh.position.set(Math.cos(node.angle) * node.orbitRadius, 0, -Math.sin(node.angle) * node.orbitRadius)
        }
        // 行星环跟随天体位置 + 轴向倾角，不参与自转。
        if (node.ring) {
          node.ring.position.copy(node.mesh.position)
          // 环平面水平旋转 -PI/2 + 土星本体的轴向倾角 rotation.x。
          node.ring.rotation.x = -Math.PI / 2 + node.mesh.rotation.x
          // 每帧同步土星位置，供着色器计算本体投影阴影。
          ;(node.ring.material as THREE.ShaderMaterial).uniforms.uPlanetPos.value.copy(node.mesh.position)
        }
        // 云层壳跟随天体位置，自转比本体快 25%，看起来像大气在流动。
        if (node.cloud) {
          node.cloud.position.copy(node.mesh.position)
          node.cloudAngle = (node.cloudAngle ?? 0) + node.spin * 1.25 * spinDt
          // 云层与本体共用同一根自转轴：同步轴向倾角，否则云带会与本体贴图错位。
          node.cloud.rotation.order = 'XYZ'
          node.cloud.rotation.x = node.mesh.rotation.x
          node.cloud.rotation.y = node.cloudAngle
        }
        // 夜半球叠加层：位置跟随地球，自转与本体同步（night map 需与 day map 对齐），
        // 每帧更新着色器里的太阳方向，保证昼夜交界随地球公转正确移动。
        if (node.night) {
          node.night.position.copy(node.mesh.position)
          node.night.rotation.copy(node.mesh.rotation)
          const mat = node.night.material as THREE.ShaderMaterial
          const sunPos = new THREE.Vector3()
          // 太阳在原点（PointLight 在 scene 原点）。
          sunPos.set(0, 0, 0)
          mat.uniforms.uSunPos.value.copy(sunPos)
        }
      }
      this.updateComets(dt)
      this.starGroup.rotation.y += dt * 0.004
    }

    // 卫星轨道导引线：跟随母行星平移，且只在聚焦该行星系统时显示。
    // 放在暂停判断之外，这样暂停时选中天体也能立刻看到/隐藏轨道。
    for (const node of this.nodes.values()) {
      if (!node.moonOrbit || !node.parent) continue
      node.moonOrbit.position.copy(node.parent.mesh.position)
      node.moonOrbit.visible = this.moonGuideParent === node.parent.def.id
    }

    // 星点呼吸式闪烁：各层相位错开，避免整片星空同步明灭。
    const elapsed = this.clock.elapsedTime
    for (const layer of this.starLayers) {
      layer.mat.opacity = layer.base + Math.sin(elapsed * layer.speed + layer.phase) * 0.14
    }

    // 太阳眩光：把太阳的屏幕坐标与强度写到容器 CSS 变量，交给 ::before 叠加暖色光晕。
    this.sunNdc.set(0, 0, 0).project(this.camera)
    const sunVisible =
      this.sunNdc.z < 1 && Math.abs(this.sunNdc.x) < 1.35 && Math.abs(this.sunNdc.y) < 1.35
    const sunX = (this.sunNdc.x * 0.5 + 0.5) * 100
    const sunY = (-this.sunNdc.y * 0.5 + 0.5) * 100
    const sunStrength = sunVisible
      ? Math.max(0, 1 - Math.hypot(this.sunNdc.x, this.sunNdc.y) * 0.7)
      : 0
    this.container.style.setProperty('--sun-x', `${sunX.toFixed(2)}%`)
    this.container.style.setProperty('--sun-y', `${sunY.toFixed(2)}%`)
    this.container.style.setProperty('--sun-a', sunStrength.toFixed(3))

    // 跟随选中的天体：目标点与相机同步平移，保持相对构图不漂移。
    if (this.followId) {
      const node = this.nodes.get(this.followId)
      if (node) {
        const desired = new THREE.Vector3()
        node.mesh.getWorldPosition(desired).add(this.focusOffset)
        const delta = desired.clone().sub(this.controls.target)
        if (delta.lengthSq() > 1e-8) {
          this.controls.target.add(delta)
          this.camera.position.add(delta)
        }
        this.focusTarget.copy(desired)
      } else {
        this.followId = null
      }
    }

    if (this.focusing) {
      this.controls.target.lerp(this.focusTarget, 0.08)
      const dir = this.camera.position.clone().sub(this.controls.target).normalize()
      const desired = this.focusTarget.clone().add(dir.multiplyScalar(this.focusDistance))
      this.camera.position.lerp(desired, 0.06)
      if (this.camera.position.distanceTo(desired) < 0.4) this.focusing = false
    }

    this.controls.update()
    this.composer.render()
  }

  /** 外部设置选中项。 */
  setSelected(id: string | null): void {
    // 不再绘制选中高亮环；取消选中时只需停止跟随，相机留在原地。
    if (id === null) this.followId = null
  }

  /** 视角复位：回到太阳系的广角初始机位。 */
  resetView(): void {
    this.followId = null
    this.moonGuideParent = null
    // 复位时恢复全局最小机位距离（聚焦卫星时会临时放宽）。
    this.controls.minDistance = 8
    this.focusOffset.set(0, 0, 0)
    this.focusTarget.set(0, 0, 0)
    this.focusDistance = 440
    this.focusing = true
  }

  /** 已经请求过 8k 贴图的天体，避免重复下载。 */
  private readonly hiResAsked = new Set<string>()

  /** 相机聚焦到某天体。 */
  focusBody(id: string): void {
    const node = this.nodes.get(id)
    if (!node) return
    // 聚焦时才按需拉取 8k 贴图：首屏不必为近看细节付出十几 MB 流量。
    this.upgradeTexture(id)
    const world = new THREE.Vector3()
    node.mesh.getWorldPosition(world)
    this.focusTarget.copy(world)
    // 卫星半径只有行星的几十分之一，沿用行星的机位会让卫星只剩二十来像素；
    // 这里给卫星单独的近机位，同时放宽 OrbitControls 的最小距离（否则会被夹回 8）。
    const isMoonNode = node.def.kind === 'moon'
    this.focusDistance = isMoonNode ? Math.max(2.4, node.displayRadius * 5) : Math.max(9, node.displayRadius * 8)
    this.controls.minDistance = isMoonNode ? this.focusDistance * 0.8 : 8
    // 相机放在天体的侧向（略偏向太阳），这样能看到被太阳照亮的半球；
    // 若沿 outward（背离太阳）偏移，相机就落在夜半球一侧，行星几乎全黑，
    // 之前木星聚焦后只剩一个黑盘就是这个符号写反导致的。
    const outward =
      world.lengthSq() > 0.01
        ? world.clone().normalize()
        : this.camera.position.clone().sub(this.controls.target).normalize()
    const side = new THREE.Vector3().crossVectors(outward, new THREE.Vector3(0, 1, 0))
    if (side.lengthSq() < 0.01) side.set(0, 0, 1)
    side.normalize()
    // 侧向 1 + 朝日 0.45：相机与太阳方向的夹角约 66°，行星呈约 70% 受光的凸相，
    // 既能看到完整贴图细节，又保留昼夜分界线，不会像正对太阳时那样完全扁平。
    // 再抬高约 18°：行星公转轨道面是 y=0 平面，若相机也停在 y=0，卫星轨道、
    // 土星环都会被压成一条线，四颗伽利略卫星还会全部躲在木星圆面后面。
    const camDir = side.clone().add(outward.clone().multiplyScalar(-0.45))
    camDir.y += 0.32
    camDir.normalize()
    this.camera.position.copy(world.clone().add(camDir.multiplyScalar(this.focusDistance * 1.8)))
    // 构图偏移：让天体落在画面偏左，避开居中浮层卡片与右侧详情面板。
    const camRight = new THREE.Vector3().crossVectors(camDir, new THREE.Vector3(0, 1, 0))
    if (camRight.lengthSq() < 0.01) camRight.set(1, 0, 0)
    camRight.normalize()
    this.focusOffset.copy(camRight).multiplyScalar(-this.focusDistance * 0.4)
    this.focusTarget.copy(world).add(this.focusOffset)
    // 立刻把轨道控制的目标点也挪过来：聚焦动画每帧用「相机 - 目标点」重新求相机位置，
    // 若目标点还留在上一个天体上（比如从木星跳到木卫一），这个方向会指向错误的一侧，
    // 相机会绕到卫星的夜半球去——之前木卫一近景全黑就是这个原因。
    this.controls.target.copy(this.focusTarget)
    this.followId = id
    // 卫星轨道导引：聚焦行星时显示它的卫星轨道，聚焦卫星时显示母行星的卫星轨道；
    // 没有卫星的天体（水星、金星、火星、太阳）则隐藏所有导引线。
    const holder = node.def.kind === 'moon' ? node.def.parent ?? null : node.def.id
    this.moonGuideParent = holder !== null && this.moonParents.has(holder) ? holder : null
    this.focusing = true
  }

  /**
   * 把天体的 2k 贴图替换成 8k 版本（仅在首次聚焦时触发）。
   * @param id 天体 id；无 8k 版本的天体会直接跳过
   */
  private upgradeTexture(id: string): void {
    const file = HIRES_TEXTURE[id]
    if (!file || this.hiResAsked.has(id)) return
    const node = this.nodes.get(id)
    if (!node) return
    this.hiResAsked.add(id)
    new THREE.TextureLoader().load(textureUrl(file), (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = 8
      const mat = node.mesh.material as THREE.MeshStandardMaterial
      mat.map = tex
      mat.needsUpdate = true
    })
  }

  /**
   * 转向某个世界方向（星表定位用）。
   * 只改视线目标，不移动相机位置：恒星距离以秒差距计，飞过去会扎进场景内部。
   */
  faceDirection(x: number, y: number, z: number): void {
    const dir = new THREE.Vector3(x, y, z)
    if (dir.lengthSq() < 1e-6) return
    dir.normalize()
    this.followId = null
    this.moonGuideParent = null
    this.focusing = false
    this.controls.target.copy(this.camera.position).add(dir.multiplyScalar(1000))
  }

  setPaused(value: boolean): void {
    this.paused = value
  }

  /** 设置公转速度倍率。 */
  setOrbitScale(value: number): void {
    this.orbitScale = value
  }

  /** 设置自转速度倍率。 */
  setSpinScale(value: number): void {
    this.spinScale = value
  }

  /** 释放渲染资源。 */
  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    const dom = this.renderer.domElement
    dom.removeEventListener('pointerdown', this.onPointerDown)
    dom.removeEventListener('pointerup', this.onPointerUp)
    dom.removeEventListener('pointermove', this.onPointerMove)
    dom.removeEventListener('wheel', this.onWheel)
    window.removeEventListener('resize', this.onResize)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    this.controls.dispose()
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const mat = (mesh as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else if (mat) mat.dispose()
    })
    this.composer.dispose()
    this.renderer.dispose()
    dom.parentElement?.removeChild(dom)
  }
}
