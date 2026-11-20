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
}

const STARS = starsData as unknown as StarDef[]

/** 显示半径：幂律压缩（指数 0.55）保留行星层级，太阳再单独截断。 */
function displayRadius(radiusKm: number): number {
  const ratio = radiusKm / 6371
  return Math.min(12, 2.4 * Math.pow(ratio, 0.55))
}

/** 卫星显示半径：在压缩基础上再收紧，避免出现"月球和地球差不多大"的观感。 */
function satelliteRadius(radiusKm: number): number {
  return displayRadius(radiusKm) * 0.7
}

/** 轨道半径：把天文单位映射到场景单位，内行星要留出太阳本体之外的空间。 */
function orbitRadius(au: number): number {
  return 20 + au * 11
}

/**
 * 自转时间倍率：场景秒对应的天数。
 * 取 0.25（1 秒 ≈ 6 小时），让类地行星几秒转一圈、巨行星几十秒一圈，
 * 与真实自转周期的相对关系保持一致，视觉上又不至于飞转。
 */
const SPIN_TIME_SCALE = 0.25

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
  private downX = 0
  private downY = 0
  private disposed = false

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

    this.scene.background = new THREE.Color('#04060e')
    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 6000)
    this.camera.position.set(0, 180, 400)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.06
    this.controls.minDistance = 8
    this.controls.maxDistance = 1400

    this.buildLights()
    this.buildStarfield()
    this.buildBodies()

    this.composer = new EffectComposer(this.renderer)
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.composer.setSize(width, height)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.5, 0.4, 0.32)
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

  /** 用 HYG 亮星生成三层点云，按星等区分大小。 */
  private buildStarfield(): void {
    const sprite = starSpriteTexture()
    const layers = [
      { max: 2.0, size: 2.6 },
      { max: 4.0, size: 1.7 },
      { max: 99, size: 1.1 },
    ]
    layers.forEach((layer, index) => {
      const lower = index === 0 ? -1 : layers[index - 1]!.max
      const picked = STARS.filter((s) => s.mag <= layer.max && s.mag > lower)
      if (picked.length === 0) return
      const positions = new Float32Array(picked.length * 3)
      const colors = new Float32Array(picked.length * 3)
      picked.forEach((star, i) => {
        const [x, y, z] = star.xyz
        positions[i * 3] = x * 0.9
        positions[i * 3 + 1] = y * 0.9
        positions[i * 3 + 2] = z * 0.9
        colors[i * 3] = star.rgb[0]
        colors[i * 3 + 1] = star.rgb[1]
        colors[i * 3 + 2] = star.rgb[2]
      })
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      const mat = new THREE.PointsMaterial({
        size: layer.size,
        map: sprite,
        vertexColors: true,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      this.starGroup.add(new THREE.Points(geo, mat))
    })
    this.scene.add(this.starGroup)
  }

  /** 创建太阳与各行星网格、轨道线与自转/公转参数。 */
  private buildBodies(): void {
    const loader = new THREE.TextureLoader()

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
        orbitRadius: isSun ? 0 : isMoon ? 0 : orbitRadius(def.au),
        angle: Math.random() * Math.PI * 2,
        spin: (Math.PI * 2 / Math.max(def.rotationDays, 0.2)) * SPIN_TIME_SCALE * (def.retrograde ? -1 : 1),
        orbitSpeed: isSun || isMoon ? 0 : (Math.PI * 2 / Math.max(def.orbitalDays, 1)) * 6.1,
      }

      if (isSun) {
        const glow = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: glowTexture(),
            transparent: true,
            opacity: 0.5,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
        )
        // 光晕约为太阳直径的 1.7 倍：保留明亮观感，又不会在聚焦内行星时糊满画面。
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
            uMap: { value: ringTexture() },
            uSunPos: { value: new THREE.Vector3(0, 0, 0) },
            uPlanetPos: { value: new THREE.Vector3() },
            uPlanetRadius: { value: radius },
          },
          vertexShader: [
            'varying vec2 vUv;',
            'varying vec3 vWorld;',
            'void main() {',
            '  vUv = uv;',
            '  vec4 wp = modelMatrix * vec4(position, 1.0);',
            '  vWorld = wp.xyz;',
            '  gl_Position = projectionMatrix * viewMatrix * wp;',
            '}',
          ].join('\n'),
          fragmentShader: [
            'uniform sampler2D uMap;',
            'uniform vec3 uSunPos;',
            'uniform vec3 uPlanetPos;',
            'uniform float uPlanetRadius;',
            'varying vec2 vUv;',
            'varying vec3 vWorld;',
            'void main() {',
            '  vec4 tex = texture2D(uMap, vUv);',
            '  vec3 N = normalize(vec3(0.0, 0.95, 0.31));',
            '  vec3 L = normalize(vWorld - uSunPos);',
            '  float diff = max(dot(N, L), 0.0);',
            '  vec3 col = tex.rgb * (0.45 + 0.75 * diff);',
            '  vec3 awayDir = normalize(uPlanetPos - uSunPos);',
            '  vec3 rel = vWorld - uPlanetPos;',
            '  float along = dot(rel, awayDir);',
            '  float perp = length(rel - awayDir * along);',
            '  float shadow = (1.0 - smoothstep(uPlanetRadius * 1.05, uPlanetRadius * 2.1, perp))',
            '    * smoothstep(0.0, uPlanetRadius * 0.7, along);',
            '  col *= 1.0 - shadow * 0.92;',
            '  gl_FragColor = vec4(col, tex.a);',
            '}',
          ].join('\n'),
        })
        const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 96), ringMaterial)
        ring.rotation.x = -Math.PI / 2 + 0.32
        // 环不挂在行星网格下：否则会跟随土星自转一起高速旋转。
        this.scene.add(ring)
        node.ring = ring
      }

      this.scene.add(mesh)
      this.nodes.set(def.id, node)
      this.pickables.push(mesh)
      if (def.kind === 'planet') this.addOrbitLine(node.orbitRadius)
    }

    // 把月球挂到地球下，使其跟随地球公转。
    const earth = this.nodes.get('earth')
    const moon = this.nodes.get('moon')
    if (earth && moon) {
      earth.mesh.add(moon.mesh)
      // 月轨半径按地月两者的显示半径留出可见间隙，不再写死常数。
      moon.orbitRadius = earth.displayRadius + moon.displayRadius + 1.2
      moon.mesh.position.set(moon.orbitRadius, 0, 0)
      moon.parent = earth
      moon.orbitSpeed = (Math.PI * 2 / 27.322) * 6.1
    }
  }

  /** 画一条轨道参考线。 */
  private addOrbitLine(radius: number): void {
    const points: THREE.Vector3[] = []
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2
      points.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius))
    }
    const geo = new THREE.BufferGeometry().setFromPoints(points)
    const line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: '#2b3a55', transparent: true, opacity: 0.45 }),
    )
    this.scene.add(line)
  }

  /** 绑定指针与尺寸事件。 */
  private bindEvents(): void {
    const dom = this.renderer.domElement
    dom.addEventListener('pointerdown', this.onPointerDown)
    dom.addEventListener('pointerup', this.onPointerUp)
    dom.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('resize', this.onResize)
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.downX = e.clientX
    this.downY = e.clientY
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
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.animate)
    const dt = Math.min(this.clock.getDelta(), 0.05)

    if (!this.paused) {
      // 公转与自转分别受各自滑动条控制。
      const spinDt = dt * this.spinScale
      const orbitDt = dt * this.orbitScale
      for (const node of this.nodes.values()) {
        node.mesh.rotation.y += node.spin * spinDt
        if (node.parent) {
          node.angle += node.orbitSpeed * orbitDt
          node.mesh.position.set(Math.cos(node.angle) * node.orbitRadius, 0, Math.sin(node.angle) * node.orbitRadius)
        } else if (node.orbitSpeed > 0) {
          node.angle += node.orbitSpeed * orbitDt
          node.mesh.position.set(Math.cos(node.angle) * node.orbitRadius, 0, Math.sin(node.angle) * node.orbitRadius)
        }
        // 行星环只跟随天体位置，不参与自转。
        if (node.ring) {
          node.ring.position.copy(node.mesh.position)
          // 每帧同步土星位置，供着色器计算本体投影阴影。
          ;(node.ring.material as THREE.ShaderMaterial).uniforms.uPlanetPos.value.copy(node.mesh.position)
        }
      }
      this.starGroup.rotation.y += dt * 0.004
    }

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
    this.focusOffset.set(0, 0, 0)
    this.focusTarget.set(0, 0, 0)
    this.focusDistance = 440
    this.focusing = true
  }

  /** 相机聚焦到某天体。 */
  focusBody(id: string): void {
    const node = this.nodes.get(id)
    if (!node) return
    const world = new THREE.Vector3()
    node.mesh.getWorldPosition(world)
    this.focusTarget.copy(world)
    this.focusDistance = Math.max(9, node.displayRadius * 8)
    // 相机放在天体的侧向（略偏外），这样能看到被太阳照亮的半球；
    // 若放在正背阳面，行星会几乎全黑，贴图细节也就无从辨认。
    const outward =
      world.lengthSq() > 0.01
        ? world.clone().normalize()
        : this.camera.position.clone().sub(this.controls.target).normalize()
    const side = new THREE.Vector3().crossVectors(outward, new THREE.Vector3(0, 1, 0))
    if (side.lengthSq() < 0.01) side.set(0, 0, 1)
    side.normalize()
    const camDir = side.clone().add(outward.clone().multiplyScalar(0.45)).normalize()
    this.camera.position.copy(world.clone().add(camDir.multiplyScalar(this.focusDistance * 1.8)))
    // 构图偏移：让天体落在画面偏左，避开居中浮层卡片与右侧详情面板。
    const camRight = new THREE.Vector3().crossVectors(camDir, new THREE.Vector3(0, 1, 0))
    if (camRight.lengthSq() < 0.01) camRight.set(1, 0, 0)
    camRight.normalize()
    this.focusOffset.copy(camRight).multiplyScalar(-this.focusDistance * 0.4)
    this.focusTarget.copy(world).add(this.focusOffset)
    this.followId = id
    this.focusing = true
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
    window.removeEventListener('resize', this.onResize)
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
