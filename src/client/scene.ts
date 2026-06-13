import {
  engine, Entity, Transform, GltfContainer, MeshCollider, MeshRenderer,
  Material, MaterialTransparencyMode, ColliderLayer,
  InputAction, pointerEventsSystem, Schemas,
  TextShape, Billboard, BillboardMode
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { RoundState, ux } from '../shared/components'
import {
  PartType, PART_TYPES, PART_GLB, GLB_SCALE,
  SCENE_CENTER, TEMPLATE_BASE_Y, DEBUG, RoundPhase
} from '../shared/constants'
import { movePlayerTo } from '~system/RestrictedActions'
import { SlotDefinition, TEMPLATES, TemplateId, getTemplate } from '../shared/templates'
import { getClientSnapshot, requestAttach, getLocalPlayerId, ClientSnapshot } from './client'
import { onWrongPart, showFeedback, playSuccess } from './hud'

// Feature flag for #2 (cinematic dance + explosion). Turned OFF while we
// isolate a "player falls into the void during the cinematic" bug that
// appeared with this feature. When false: clones/particles are never
// prewarmed and the anim system is never registered — the cutscene reverts to
// the known-good pre-#2 behaviour (empty arena, camera only). Flip to true to
// re-enable once the cause is found.
export const CINEMATIC_ANIM_ENABLED = true

//  Slot visual registry 

// One entity per (slotId, kind) for the currently-active round. The
// SlotVisual component tags every entity with its identity so cleanup is
// straightforward when a new round starts.
type SlotKind = 'ghost' | 'hitbox' | 'solid' | 'collider' | 'feedback'

const SlotVisual = engine.defineComponent('dbc:SlotVisual', {
  slotId:      Schemas.String,
  templateId:  Schemas.String,
  roundNumber: Schemas.Int,
  kind:        Schemas.String,
  part:        Schemas.String
})

interface SlotRefs {
  ghost?: Entity
  hitbox?: Entity
  solid?: Entity
  collider?: Entity
}

const slotRefs: Record<string, SlotRefs> = {}
let activeTemplateId: TemplateId | '' = ''
let activeRoundNumber = 0
let lastBoardPhase: RoundPhase = 'IDLE'
let getSelectedPartFn: () => PartType = () => 'CUBE'
let arenaEntity: Entity = 0 as Entity
// True while cinematic clones are dancing. Suppresses integrity position/scale
// checks for slot solid GLBs, which are intentionally hidden (scale=0) so
// the animated clones can display without z-fighting.
let cinematicAnimating = false

// Anti-spam: 400ms window after a click to avoid duplicate requests if the
// pointer registers twice. Server dedupes too, but suppressing locally
// keeps logs cleaner.
const recentClicks: Set<string> = new Set()
const ANTI_SPAM_MS = 400

// Active feedback flashes — tracked so clearAllSlotVisuals can cancel them.
// Tokens guard against a stale timeout releasing a pooled entity that has
// already been re-acquired for a newer flash.
const activeFlashes: Set<Entity> = new Set()
const flashTokens: Map<Entity, number> = new Map()
let flashTokenSeq = 0

// Visual health audit — runs every second in BUILD/BUILD_COMPLETE to catch
// any entities that were silently lost.
let healthAuditAtMs = 0
const HEALTH_AUDIT_INTERVAL_MS = 1000

// Four safe landing positions on the platform edges (N/S/E/W, 7m from center)
// used when respawning the player at round transitions. Camera always aims at
// the center of the build area.
const RESPAWN_POSITIONS = [
  Vector3.create(SCENE_CENTER.x,     TEMPLATE_BASE_Y + 1, SCENE_CENTER.z - 7), // south
  Vector3.create(SCENE_CENTER.x + 7, TEMPLATE_BASE_Y + 1, SCENE_CENTER.z    ), // east
  Vector3.create(SCENE_CENTER.x,     TEMPLATE_BASE_Y + 1, SCENE_CENTER.z + 7), // north
  Vector3.create(SCENE_CENTER.x - 7, TEMPLATE_BASE_Y + 1, SCENE_CENTER.z    ), // west
]
const RESPAWN_LOOK_TARGET = Vector3.create(SCENE_CENTER.x, TEMPLATE_BASE_Y + 2, SCENE_CENTER.z)

//  Trophy system
const MAX_TROPHIES       = 5
const TROPHY_BASE_Y      = TEMPLATE_BASE_Y + 3.5   // orbit centre height
const TROPHY_ORBIT_R     = 5.5                      // metres from scene centre
const TROPHY_ORBIT_SPD   = 0.22                     // rad/s
const TROPHY_BOB_AMP     = 0.35                     // metres
const TROPHY_BOB_SPD     = 0.9                      // rad/s
const TROPHY_SPIN_RAD    = 55 * (Math.PI / 180)     // rad/s
const TROPHY_SCALE       = 0.5                      // miniature scale factor
const TROPHY_LABEL_Y_OFF = 2.0                      // metres above orbit centre

interface TrophyBlock {
  entity:      Entity
  part:        PartType
  localOffset: Vector3  // from trophy centre, already scaled × TROPHY_SCALE
  baseScale:   Vector3
  baseRot:     Quaternion
}

interface TrophyEntry {
  blocks:      TrophyBlock[]
  label:       Entity
  orbitAngle:  number   // current angle (rad)
  bobPhase:    number   // phase offset for sin bob
  labelOffY:   number   // metres above orbit centre: top of tallest block + margin
}

const trophyBlockPool: Record<PartType, Entity[]> = { CUBE: [], CYLINDER: [], CONE: [] }
const trophyLabelPool: Entity[] = []
const trophies: TrophyEntry[] = []
let trophyTime = 0
let lastTrophyRound = -1

//  Materials
const PART_GLOW_COLOR: Record<PartType, Color4> = {
  CUBE:     Color4.create(0.1, 0.3, 1,   0.22),
  CYLINDER: Color4.create(1,   0.1, 0.1, 0.22),
  CONE:     Color4.create(1,   0.85, 0,  0.22)
}

const PART_EMISSIVE: Record<PartType, Color4> = {
  CUBE:     Color4.create(0.1, 0.3, 1, 1),
  CYLINDER: Color4.create(1,   0.1, 0.1, 1),
  CONE:     Color4.create(1,   0.85, 0,  1)
}

function partRotation(part: PartType): Quaternion {
  return part === 'CONE'
    ? Quaternion.fromEulerDegrees(180, 0, 0)
    : Quaternion.Identity()
}

//  Logging 
function logVisualSummary(reason: string): void {
  let total = 0, ghosts = 0, hitboxes = 0, solids = 0, colliders = 0, feedbacks = 0
  for (const [, v] of engine.getEntitiesWith(SlotVisual)) {
    total++
    if (v.kind === 'ghost') ghosts++
    else if (v.kind === 'hitbox') hitboxes++
    else if (v.kind === 'solid') solids++
    else if (v.kind === 'collider') colliders++
    else if (v.kind === 'feedback') feedbacks++
  }
  console.log(
    `[SCENE] visual-summary reason=${reason} template=${activeTemplateId} round=${activeRoundNumber} ` +
    `total=${total} ghosts=${ghosts} hitboxes=${hitboxes} solids=${solids} colliders=${colliders} feedbacks=${feedbacks}`
  )
}

//  Visual entity pool
// The Unity explorer desyncs render instances from ECS state under entity
// churn bursts — orphaned meshes, invisible meshes and dropped UI elements
// were all reproduced on 2026-06-10 with the ECS provably correct. So slot
// visuals are never created or removed during gameplay: each (kind, part)
// pool owns persistent entities that get repositioned + shown on acquire and
// hidden + parked on release. The render object lives for the whole session
// and only ever receives property updates.
const HIDDEN_Y = -100

const poolFree: Record<string, Entity[]> = {}
const poolInUse: Set<Entity> = new Set()

function poolKey(kind: SlotKind, part: PartType | ''): string {
  return `${kind}:${part}`
}

function createPooledEntity(kind: SlotKind, part: PartType | ''): Entity {
  const e = engine.addEntity()
  Transform.create(e, {
    position: Vector3.create(SCENE_CENTER.x, HIDDEN_Y, SCENE_CENTER.z),
    scale: Vector3.Zero(),
    rotation: Quaternion.Identity()
  })
  if (kind === 'ghost') {
    const p = part as PartType
    if (p === 'CUBE') MeshRenderer.setBox(e)
    else if (p === 'CYLINDER') MeshRenderer.setCylinder(e)
    else MeshRenderer.setCylinder(e, 0, 0.5)
    Material.setPbrMaterial(e, {
      albedoColor: PART_GLOW_COLOR[p],
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
      emissiveColor: PART_EMISSIVE[p],
      emissiveIntensity: 1.2
    })
  } else if (kind === 'solid') {
    GltfContainer.create(e, {
      src: PART_GLB[part as PartType],
      visibleMeshesCollisionMask: 0,
      invisibleMeshesCollisionMask: 0
    })
  } else if (kind === 'hitbox') {
    MeshCollider.setBox(e, ColliderLayer.CL_POINTER)
  } else if (kind === 'collider') {
    MeshCollider.setBox(e, ColliderLayer.CL_PHYSICS)
  } else {
    MeshRenderer.setSphere(e)
  }
  return e
}

function acquireEntity(kind: SlotKind, part: PartType | ''): Entity {
  const key = poolKey(kind, part)
  const free = poolFree[key] || (poolFree[key] = [])
  let e = free.pop()
  if (e === undefined) {
    // Pools are prewarmed at init to the worst case across all templates, so
    // this should never run. If it does, the log flags that a mid-session
    // entity creation happened — the one operation we aim to never perform.
    e = createPooledEntity(kind, part)
    console.log(`[SCENE] pool exhausted key=${key} — created mid-session entity`)
  }
  poolInUse.add(e)
  return e
}

// Create the full visual inventory up front, parked out of sight. Gameplay
// then never creates entities: every visual is a property update on a
// pre-existing entity whose GLB/mesh finished loading during scene init.
function prewarmPools(): void {
  const maxPerPart: Record<PartType, number> = { CUBE: 0, CYLINDER: 0, CONE: 0 }
  let maxSlots = 0
  for (const id of Object.keys(TEMPLATES)) {
    const slots = TEMPLATES[id as TemplateId]
    maxSlots = Math.max(maxSlots, slots.length)
    const count: Record<PartType, number> = { CUBE: 0, CYLINDER: 0, CONE: 0 }
    for (const s of slots) count[s.requiredPart]++
    for (const p of PART_TYPES) maxPerPart[p] = Math.max(maxPerPart[p], count[p])
  }
  let created = 0
  for (const p of PART_TYPES) {
    for (let i = 0; i < maxPerPart[p]; i++) {
      prewarmOne('ghost', p)
      prewarmOne('solid', p)
      created += 2
    }
  }
  for (let i = 0; i < maxSlots; i++) {
    prewarmOne('hitbox', '')
    prewarmOne('collider', '')
    created += 2
  }
  for (let i = 0; i < 3; i++) {
    prewarmOne('feedback', '')
    created++
  }
  console.log(
    `[SCENE] pools prewarmed entities=${created} maxSlots=${maxSlots} ` +
    `cube=${maxPerPart.CUBE} cyl=${maxPerPart.CYLINDER} cone=${maxPerPart.CONE}`
  )
}

function prewarmOne(kind: SlotKind, part: PartType | ''): void {
  const key = poolKey(kind, part)
  ;(poolFree[key] || (poolFree[key] = [])).push(createPooledEntity(kind, part))
}

// Hides the entity and returns it to its pool. The (kind, part) pool key is
// read from the entity's own SlotVisual tag, so callers only pass the entity.
function releaseEntity(e: Entity | undefined): void {
  if (e === undefined || !poolInUse.has(e)) return
  const tag = SlotVisual.getOrNull(e)
  if (!tag) return
  poolInUse.delete(e)
  SlotVisual.deleteFrom(e)
  if (tag.kind === 'hitbox') {
    try { pointerEventsSystem.removeOnPointerDown(e) } catch (_) {}
  }
  try {
    const t = Transform.getMutable(e)
    t.scale = Vector3.Zero()
    t.position = Vector3.create(t.position.x, HIDDEN_Y, t.position.z)
  } catch (_) {}
  const key = poolKey(tag.kind as SlotKind, tag.part as PartType | '')
  ;(poolFree[key] || (poolFree[key] = [])).push(e)
}

//  Cinematic animation + explosion
// During the inter-round cutscene the slot solid entities dance in place and
// then burst into particles. We animate the ORIGINAL solid and collider entities
// from slotRefs directly — no separate clone pool — so the structure is
// physically walkable throughout the animation and entity count stays minimal.
const PARTICLES_PER_BLOCK = 6
const MAX_PARTICLES = 60

// Each block's last animated position during PERFORM, so the explosion fires
// from where the blocks actually were when the cutscene ended.
const lastAnimPositions: Map<string, Vector3> = new Map()

const particlePoolFree: Entity[] = []

interface ExplosionParticle {
  entity:  Entity
  vx: number; vy: number; vz: number
  life:    number
  maxLife: number
}
const explosionParticles: ExplosionParticle[] = []

function createParticleEntity(): Entity {
  const e = engine.addEntity()
  Transform.create(e, {
    position: Vector3.create(SCENE_CENTER.x, HIDDEN_Y, SCENE_CENTER.z),
    scale: Vector3.Zero(),
    rotation: Quaternion.Identity()
  })
  MeshRenderer.setBox(e)
  // One shared warm-spark material, set once at prewarm. DCL dedupes identical
  // materials, so all particles together count as a single material.
  Material.setPbrMaterial(e, {
    albedoColor:       { r: 1, g: 0.85, b: 0.4, a: 1 },
    emissiveColor:     { r: 1, g: 0.8,  b: 0.3 },
    emissiveIntensity: 4.0,
    transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND
  })
  return e
}

// Prewarm only particle pool — solids are already prewarmed by prewarmPools().
function prewarmCinematicPools(): void {
  let maxSlots = 0
  for (const id of Object.keys(TEMPLATES)) {
    maxSlots = Math.max(maxSlots, TEMPLATES[id as TemplateId].length)
  }
  const particles = Math.min(maxSlots * PARTICLES_PER_BLOCK, MAX_PARTICLES)
  for (let i = 0; i < particles; i++) particlePoolFree.push(createParticleEntity())
  console.log(`[CINEMATIC] prewarmed particles=${particles}`)
}

function prewarmTrophyPools(): void {
  const maxPerPart: Record<PartType, number> = { CUBE: 0, CYLINDER: 0, CONE: 0 }
  for (const id of Object.keys(TEMPLATES)) {
    const slots = TEMPLATES[id as TemplateId]
    const cnt: Record<PartType, number> = { CUBE: 0, CYLINDER: 0, CONE: 0 }
    for (const s of slots) cnt[s.requiredPart]++
    for (const p of PART_TYPES) maxPerPart[p] = Math.max(maxPerPart[p], cnt[p])
  }
  let total = 0
  for (const p of PART_TYPES) {
    for (let i = 0; i < MAX_TROPHIES * maxPerPart[p]; i++) {
      const e = engine.addEntity()
      Transform.create(e, {
        position: Vector3.create(SCENE_CENTER.x, HIDDEN_Y, SCENE_CENTER.z),
        scale: Vector3.Zero(),
        rotation: Quaternion.Identity()
      })
      GltfContainer.create(e, {
        src: PART_GLB[p],
        visibleMeshesCollisionMask: 0,
        invisibleMeshesCollisionMask: 0
      })
      trophyBlockPool[p].push(e)
      total++
    }
  }
  for (let i = 0; i < MAX_TROPHIES; i++) {
    const e = engine.addEntity()
    Transform.create(e, {
      position: Vector3.create(SCENE_CENTER.x, HIDDEN_Y, SCENE_CENTER.z),
      scale: Vector3.One(),
      rotation: Quaternion.Identity()
    })
    TextShape.create(e, {
      text: '',
      fontSize: 3,
      textColor: { r: 1, g: 1, b: 1, a: 0.95 },
      outlineColor: { r: 0, g: 0, b: 0 },
      outlineWidth: 0.08
    })
    Billboard.create(e, { billboardMode: BillboardMode.BM_Y })
    trophyLabelPool.push(e)
    total++
  }
  console.log(
    `[TROPHY] prewarmed total=${total} cube=${MAX_TROPHIES * maxPerPart.CUBE} ` +
    `cyl=${MAX_TROPHIES * maxPerPart.CYLINDER} cone=${MAX_TROPHIES * maxPerPart.CONE}`
  )
}

function spawnParticlesAt(pos: Vector3): void {
  for (let p = 0; p < PARTICLES_PER_BLOCK; p++) {
    const e = particlePoolFree.pop()
    if (e === undefined) break
    const theta = Math.random() * Math.PI * 2
    const phi   = (Math.random() * 0.55 + 0.1) * Math.PI
    const speed = 5 + Math.random() * 8
    const vx = Math.sin(phi) * Math.cos(theta) * speed
    const vy = Math.abs(Math.cos(phi)) * speed + 2
    const vz = Math.sin(phi) * Math.sin(theta) * speed
    const t = Transform.getMutable(e)
    t.position = Vector3.create(pos.x, pos.y, pos.z)
    t.scale    = Vector3.create(0.01, 0.01, 0.01)
    explosionParticles.push({ entity: e, vx, vy, vz, life: 0, maxLife: 1.1 + Math.random() * 0.7 })
  }
}

function triggerExplosion(): void {
  for (const pos of lastAnimPositions.values()) spawnParticlesAt(pos)
  lastAnimPositions.clear()
  console.log(`[EXPLOSION] particles=${explosionParticles.length}`)
}

function updateExplosionParticles(dt: number): void {
  let i = explosionParticles.length
  while (i--) {
    const p = explosionParticles[i]
    p.life += dt
    const t = p.life / p.maxLife
    if (t >= 1.0) {
      try {
        const tr = Transform.getMutable(p.entity)
        tr.scale = Vector3.Zero()
        tr.position = Vector3.create(SCENE_CENTER.x, HIDDEN_Y, SCENE_CENTER.z)
      } catch (_) {}
      particlePoolFree.push(p.entity)
      explosionParticles.splice(i, 1)
      continue
    }
    p.vy += -7.0 * dt
    try {
      const tr = Transform.getMutable(p.entity)
      tr.position.x += p.vx * dt
      tr.position.y += p.vy * dt
      tr.position.z += p.vz * dt
      const sc = t < 0.12 ? (t / 0.12) * 0.38 : 0.38 * (1 - (t - 0.12) / 0.88)
      tr.scale = Vector3.create(Math.max(0, sc), Math.max(0, sc), Math.max(0, sc))
    } catch (_) {}
  }
}

// Resets all occupied slot solids and colliders to their base transforms after
// the animation ends due to an unexpected phase exit or stale state.
function resetAnimatedSolids(snap: ClientSnapshot): void {
  const slots = getTemplate(snap.templateId)
  if (!slots) return
  const mask = snap.occupiedMask | 0
  for (let i = 0; i < slots.length; i++) {
    if (((mask >> i) & 1) === 0) continue
    const slot = slots[i]
    const refs = slotRefs[slot.slotId]
    if (!refs) continue
    const basePos   = slotPositionVector(slot)
    const baseScale = slotScaleVector(slot)
    if (refs.solid !== undefined) {
      try {
        const t = Transform.getMutable(refs.solid)
        t.position = basePos
        t.scale    = baseScale
        t.rotation = partRotation(slot.requiredPart)
      } catch (_) {}
    }
    if (refs.collider !== undefined) {
      try {
        const tc = Transform.getMutable(refs.collider)
        tc.position = basePos
        tc.scale    = baseScale
      } catch (_) {}
    }
  }
  lastAnimPositions.clear()
}

// Hides solid GLBs and physics colliders when the explosion fires (PERFORM→RESET).
// Blocks vanish with the burst; the movePlayerTo in cinematicAnimSystem handles any fall.
function hideAnimatedSolids(snap: ClientSnapshot): void {
  const slots = getTemplate(snap.templateId)
  if (!slots) return
  const mask = snap.occupiedMask | 0
  for (let i = 0; i < slots.length; i++) {
    if (((mask >> i) & 1) === 0) continue
    const refs = slotRefs[slots[i].slotId]
    if (!refs) continue
    if (refs.solid    !== undefined) try { Transform.getMutable(refs.solid).scale    = Vector3.Zero() } catch (_) {}
    if (refs.collider !== undefined) try { Transform.getMutable(refs.collider).scale = Vector3.Zero() } catch (_) {}
  }
  lastAnimPositions.clear()
}

// Animates slot solid + collider entities directly during COUNTDOWN and PERFORM,
// then bursts them into particles at PERFORM→RESET. The collider follows the
// solid's position so the structure is walkable throughout the dance.
let choreTime = 0
let chorePhase: RoundPhase = 'IDLE'
let choreVariant = 0
let choreRound = 0
let choreActive = false
let choreExploded = false

export function cinematicAnimSystem(dt: number): void {
  const snap  = getClientSnapshot()
  const phase = snap.phase
  const round = snap.roundNumber

  if (snap.isStale) {
    if (choreActive) resetAnimatedSolids(snap)
    choreActive = false
    chorePhase = phase
    choreRound = round
    if (explosionParticles.length > 0) updateExplosionParticles(dt)
    return
  }

  // Phase / round transitions.
  if (phase !== chorePhase || round !== choreRound) {
    // PERFORM→RESET: keep animating into RESET — explosion fires when secondsLeft reaches 1.
    // Any other exit from animated phases: reset solids to base.
    if (choreActive && phase !== 'COUNTDOWN' && phase !== 'PERFORM' && phase !== 'RESET') {
      resetAnimatedSolids(snap)
      choreActive = false
    }

    if (phase === 'COUNTDOWN') {
      choreExploded = false
      if (snap.performanceType === 'PERFECT') {
        choreTime = 0
        choreVariant = Math.floor(Math.random() * 2)
        choreActive = true
        console.log(`[CINEMATIC-ANIM] start round=${round} variant=${choreVariant === 1 ? 'ORBIT' : 'WAVE'}`)
      }
    } else if (phase === 'PERFORM' && !choreActive && snap.performanceType === 'PERFECT') {
      // Late joiner missed COUNTDOWN.
      choreTime = 0
      choreActive = true
    }

    chorePhase = phase
    choreRound = round
  }

  // Explosion fires when the big countdown hits 1 — RESET phase, secondsLeft === 1.
  if (choreActive && phase === 'RESET' && !choreExploded && snap.secondsLeft <= 1) {
    choreExploded = true
    choreActive = false
    triggerExplosion()
    hideAnimatedSolids(snap)
    movePlayerTo({
      newRelativePosition: RESPAWN_POSITIONS[Math.floor(Math.random() * RESPAWN_POSITIONS.length)],
      cameraTarget: RESPAWN_LOOK_TARGET
    }).catch(() => {})
  }

  if (explosionParticles.length > 0) updateExplosionParticles(dt)

  if (!choreActive || (phase !== 'COUNTDOWN' && phase !== 'PERFORM' && phase !== 'RESET')) return

  choreTime += dt
  const slots = getTemplate(snap.templateId)
  if (!slots) return

  const mask      = snap.occupiedMask | 0
  const n         = Math.max(slots.length, 1)
  const spinSpeed = phase === 'COUNTDOWN' ? 140 : 85

  for (let i = 0; i < slots.length; i++) {
    if (((mask >> i) & 1) === 0) continue
    const slot  = slots[i]
    const refs  = slotRefs[slot.slotId]
    if (!refs?.solid) continue

    const basePos   = slotPositionVector(slot)
    const baseScale = slotScaleVector(slot)
    const baseRot   = partRotation(slot.requiredPart)
    const pOff = (i / n) * Math.PI * 2
    let yBounce: number, scaleMod: number, spinDeg: number, driftX: number, driftZ: number

    if (choreVariant === 1) {
      // ORBIT: each block orbits its base XZ position at a unique speed.
      const orbitSpd = 1.8 + (i % 3) * 0.7
      const orbitAng = choreTime * orbitSpd + pOff
      driftX   = Math.cos(orbitAng) * 0.35
      driftZ   = Math.sin(orbitAng) * 0.35
      yBounce  = Math.sin(choreTime * 2.0 + pOff * 0.5) * 0.35
      scaleMod = 1 + Math.sin(choreTime * 2.5) * 0.25
      spinDeg  = choreTime * spinSpeed + (pOff * 180 / Math.PI)
    } else {
      // WAVE: stadium wave, alternating spin, XZ micro-drift.
      const spinDir = (i % 2 === 0) ? 1 : -1
      yBounce  = Math.sin(choreTime * 3.2 + pOff) * 0.50
      scaleMod = 1 + Math.sin(choreTime * 4.0 + pOff + Math.PI * 0.35) * 0.30
      spinDeg  = choreTime * spinSpeed * spinDir + (pOff * 180 / Math.PI)
      driftX   = Math.cos(choreTime * 2.0 + pOff) * 0.10
      driftZ   = Math.sin(choreTime * 2.0 + pOff + 1.1) * 0.10
    }

    const animPos = Vector3.create(basePos.x + driftX, basePos.y + yBounce, basePos.z + driftZ)
    if (phase === 'PERFORM') lastAnimPositions.set(slot.slotId, animPos)

    try {
      const t = Transform.getMutable(refs.solid)
      t.position = animPos
      t.scale    = Vector3.create(baseScale.x * scaleMod, baseScale.y * scaleMod, baseScale.z * scaleMod)
      t.rotation = Quaternion.multiply(Quaternion.fromEulerDegrees(0, spinDeg, 0), baseRot)
    } catch (_) {}

    // Collider follows the solid's position so the block remains physically
    // walkable. Keep base scale/rotation on the physics box to avoid jitter.
    if (refs.collider !== undefined) {
      try {
        Transform.getMutable(refs.collider).position = animPos
      } catch (_) {}
    }
  }
}

function tagVisual(e: Entity, slot: SlotDefinition, kind: SlotKind, part: PartType | ''): void {
  SlotVisual.createOrReplace(e, {
    slotId: slot.slotId,
    templateId: activeTemplateId,
    roundNumber: activeRoundNumber,
    kind,
    part
  })
  if (DEBUG) {
    console.log(`[SCENE] tag kind=${kind} slot=${slot.slotId} template=${activeTemplateId} round=${activeRoundNumber}`)
  }
}

function clearAllSlotVisuals(reason: string): void {
  // Cancel active flashes first so their pending timeouts become no-ops.
  for (const e of activeFlashes) { flashTokens.delete(e); releaseEntity(e) }
  activeFlashes.clear()

  const entities: Entity[] = []
  for (const [e] of engine.getEntitiesWith(SlotVisual)) entities.push(e)
  for (const e of entities) releaseEntity(e)
  for (const k of Object.keys(slotRefs)) delete slotRefs[k]
  recentClicks.clear()
  healthAuditAtMs = 0
  if (entities.length > 0) {
    console.log(`[SCENE] cleared ${entities.length} visuals reason=${reason}`)
  }
}

function slotPositionVector(slot: SlotDefinition): Vector3 {
  return Vector3.create(slot.position.x, slot.position.y, slot.position.z)
}

function slotScaleVector(slot: SlotDefinition): Vector3 {
  return Vector3.create(slot.scale.x * GLB_SCALE, slot.scale.y * GLB_SCALE, slot.scale.z * GLB_SCALE)
}

//  Visual placement (pool-backed)
function placeGhost(slot: SlotDefinition): Entity {
  const e = acquireEntity('ghost', slot.requiredPart)
  const t = Transform.getMutable(e)
  t.position = slotPositionVector(slot)
  t.scale = Vector3.scale(slotScaleVector(slot), 1.18)
  t.rotation = partRotation(slot.requiredPart)
  tagVisual(e, slot, 'ghost', slot.requiredPart)
  return e
}

function placeHitbox(slot: SlotDefinition): Entity {
  const e = acquireEntity('hitbox', '')
  const t = Transform.getMutable(e)
  t.position = slotPositionVector(slot)
  t.scale = slotScaleVector(slot)
  t.rotation = partRotation(slot.requiredPart)
  pointerEventsSystem.onPointerDown(
    {
      entity: e,
      opts: {
        button: InputAction.IA_POINTER,
        hoverText: 'Press E to change block',
        maxDistance: 8
      }
    },
    () => onSlotClick(slot)
  )
  tagVisual(e, slot, 'hitbox', '')
  return e
}

function placeSolid(slot: SlotDefinition): { solid: Entity; collider: Entity } {
  const solid = acquireEntity('solid', slot.requiredPart)
  let t = Transform.getMutable(solid)
  t.position = slotPositionVector(slot)
  t.scale = slotScaleVector(slot)
  t.rotation = partRotation(slot.requiredPart)
  tagVisual(solid, slot, 'solid', slot.requiredPart)

  const collider = acquireEntity('collider', '')
  t = Transform.getMutable(collider)
  t.position = slotPositionVector(slot)
  t.scale = slotScaleVector(slot)
  t.rotation = partRotation(slot.requiredPart)
  tagVisual(collider, slot, 'collider', '')
  return { solid, collider }
}

function flashFeedback(slot: SlotDefinition, color: Color4): void {
  const e = acquireEntity('feedback', '')
  const t = Transform.getMutable(e)
  t.position = slotPositionVector(slot)
  t.scale = Vector3.scale(slotScaleVector(slot), 3.0)
  t.rotation = Quaternion.Identity()
  Material.setPbrMaterial(e, {
    albedoColor: { r: color.r, g: color.g, b: color.b, a: 0.55 },
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    emissiveColor: color,
    emissiveIntensity: 3.0
  })
  tagVisual(e, slot, 'feedback', '')
  activeFlashes.add(e)
  const token = ++flashTokenSeq
  flashTokens.set(e, token)
  setTimeout(() => {
    if (flashTokens.get(e) !== token) return
    flashTokens.delete(e)
    activeFlashes.delete(e)
    releaseEntity(e)
  }, 600)
}

//  Affordance state
function ensureSlotAffordance(slot: SlotDefinition): void {
  const refs = slotRefs[slot.slotId] || (slotRefs[slot.slotId] = {})
  if (refs.ghost === undefined) refs.ghost = placeGhost(slot)
  if (refs.hitbox === undefined) refs.hitbox = placeHitbox(slot)
}

function removeSlotAffordance(slot: SlotDefinition): void {
  const refs = slotRefs[slot.slotId]
  if (!refs) return
  releaseEntity(refs.ghost)
  releaseEntity(refs.hitbox)
  refs.ghost = undefined
  refs.hitbox = undefined
}

function ensureSlotSolid(slot: SlotDefinition): void {
  const refs = slotRefs[slot.slotId] || (slotRefs[slot.slotId] = {})
  if (refs.solid === undefined || refs.collider === undefined) {
    releaseEntity(refs.solid)
    releaseEntity(refs.collider)
    const created = placeSolid(slot)
    refs.solid = created.solid
    refs.collider = created.collider
  }
}

function removeSlotSolid(slot: SlotDefinition): void {
  const refs = slotRefs[slot.slotId]
  if (!refs) return
  releaseEntity(refs.solid)
  releaseEntity(refs.collider)
  refs.solid = undefined
  refs.collider = undefined
}

//  Arena 
export function clearAllVisuals(reason: string): void {
  clearAllSlotVisuals(reason)
}

export function initArena(): void {
  if (arenaEntity !== (0 as Entity)) return
  arenaEntity = engine.addEntity()
  Transform.create(arenaEntity, {
    position: Vector3.create(SCENE_CENTER.x, SCENE_CENTER.y, SCENE_CENTER.z),
    rotation: Quaternion.Identity(),
    scale: Vector3.One()
  })
  GltfContainer.create(arenaEntity, {
    src: 'assets/scene/Models/DBC/DBCPLATAFORMA_20260429.glb',
    visibleMeshesCollisionMask: ColliderLayer.CL_PHYSICS,
    invisibleMeshesCollisionMask: ColliderLayer.CL_PHYSICS
  })
}

//  Public init
export function initScene(getPart: () => PartType): void {
  getSelectedPartFn = getPart
  prewarmPools()
  if (CINEMATIC_ANIM_ENABLED) prewarmCinematicPools()
  prewarmTrophyPools()

  ux.on('wrongPart', (data: any) => {
    if (!data) return
    const snap = getClientSnapshot()
    if (!snap.resolved) return
    if (data.templateId !== snap.templateId || data.roundNumber !== snap.roundNumber) return
    if (data.playerId !== getLocalPlayerId()) return
    const slots = getTemplate(snap.templateId)
    const slot = slots?.find(s => s.slotId === data.slotId)
    if (slot) flashFeedback(slot, Color4.create(1, 0.1, 0.1, 1))
    onWrongPart(data.required as PartType)
  })

  ux.on('attachRejected', (data: any) => {
    if (!data || data.playerId !== getLocalPlayerId()) return
    clearAntiSpam(data.slotId)
    console.log(`[SCENE] rejected reason=${data.reason} slot=${data.slotId} phase=${data.currentPhase}`)
  })
}

//  Integrity check
// Working assumption: the renderer faithfully draws ECS state. Then any wrong
// pixel means OUR state is wrong somewhere the tag census cannot see — e.g. a
// tagged solid that is actually parked at HIDDEN_Y, or a part mesh that fell
// out of the bookkeeping entirely. This check verifies real transforms against
// expectations slot by slot and logs every discrepancy with coordinates, so a
// repro names the exact bug.
function verifyPlaced(e: Entity | undefined, slot: SlotDefinition, kind: string, scaleMul: number): number {
  if (e === undefined) {
    console.log(`[INTEGRITY] missing ref slot=${slot.slotId} kind=${kind}`)
    return 1
  }
  // The mesh-bearing component must still be present on the entity.
  const meshMissing =
    (kind === 'ghost' && MeshRenderer.getOrNull(e) === null) ||
    (kind === 'solid' && GltfContainer.getOrNull(e) === null) ||
    ((kind === 'hitbox' || kind === 'collider') && MeshCollider.getOrNull(e) === null)
  if (meshMissing) {
    console.log(`[INTEGRITY] missing mesh component slot=${slot.slotId} kind=${kind}`)
    return 1
  }
  try {
    const t = Transform.get(e)
    const expected = slotPositionVector(slot)
    const expScale = slotScaleVector(slot).x * scaleMul
    if (
      Math.abs(t.position.x - expected.x) > 0.01 ||
      Math.abs(t.position.y - expected.y) > 0.01 ||
      Math.abs(t.position.z - expected.z) > 0.01 ||
      Math.abs(t.scale.x - expScale) > 0.01
    ) {
      console.log(
        `[INTEGRITY] misplaced slot=${slot.slotId} kind=${kind} ` +
        `expected=(${expected.x.toFixed(1)},${expected.y.toFixed(1)},${expected.z.toFixed(1)},s=${expScale.toFixed(2)}) ` +
        `actual=(${t.position.x.toFixed(1)},${t.position.y.toFixed(1)},${t.position.z.toFixed(1)},s=${t.scale.x.toFixed(2)})`
      )
      return 1
    }
  } catch (_) {
    console.log(`[INTEGRITY] dead entity slot=${slot.slotId} kind=${kind}`)
    return 1
  }
  return 0
}

function runIntegrityCheck(slots: SlotDefinition[], mask: number, phase: RoundPhase): number {
  let issues = 0
  const buildable = phase === 'BUILD'
  const showSolids =
    phase === 'BUILD' ||
    phase === 'BUILD_COMPLETE' ||
    phase === 'COUNTDOWN' ||
    phase === 'PERFORM' ||
    phase === 'RESET'

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    const occupied = ((mask >> i) & 1) === 1
    const refs = slotRefs[slot.slotId]
    if (occupied && showSolids) {
      // During animation solid+collider are at non-base positions — skip transform checks.
      if (!cinematicAnimating) {
        issues += verifyPlaced(refs?.solid, slot, 'solid', 1)
        issues += verifyPlaced(refs?.collider, slot, 'collider', 1)
      }
    } else if (!occupied && buildable) {
      issues += verifyPlaced(refs?.ghost, slot, 'ghost', 1.18)
      issues += verifyPlaced(refs?.hitbox, slot, 'hitbox', 1)
    }
  }

  // Freed entities must really be parked out of sight.
  for (const key of Object.keys(poolFree)) {
    for (const e of poolFree[key]) {
      try {
        const t = Transform.get(e)
        if (t.position.y > HIDDEN_Y + 1 || t.scale.x > 0.001) {
          issues++
          console.log(
            `[INTEGRITY] freed entity not parked pool=${key} ` +
            `pos=(${t.position.x.toFixed(1)},${t.position.y.toFixed(1)},${t.position.z.toFixed(1)}) scale=${t.scale.x.toFixed(3)}`
          )
        }
      } catch (_) {
        issues++
        console.log(`[INTEGRITY] freed entity has no transform pool=${key}`)
      }
    }
  }
  return issues
}

// Any part-GLB entity outside the pools and not parented (the carried
// shoulder piece is player-parented) is a stray our bookkeeping lost.
function logStrayPartMeshes(): number {
  let strays = 0
  for (const [e, g, t] of engine.getEntitiesWith(GltfContainer, Transform)) {
    const src = g.src
    if (src !== PART_GLB.CUBE && src !== PART_GLB.CYLINDER && src !== PART_GLB.CONE) continue
    if (t.parent !== undefined && t.parent !== (0 as Entity)) continue
    if (poolInUse.has(e)) continue
    let pooled = false
    for (const key of Object.keys(poolFree)) {
      if (poolFree[key].indexOf(e) >= 0) { pooled = true; break }
    }
    if (pooled) continue
    strays++
    console.log(
      `[INTEGRITY] stray part mesh src=${src} ` +
      `pos=(${t.position.x.toFixed(1)},${t.position.y.toFixed(1)},${t.position.z.toFixed(1)}) scale=${t.scale.x.toFixed(2)}`
    )
  }
  return strays
}

//  Visual health audit
// Runs once per second. Verifies slotRefs match the expected state and
// silently repairs any discrepancy (e.g. an entity whose underlying ECS
// record was silently dropped). Repairs are logged only when N > 0.
function runHealthAudit(slots: SlotDefinition[], mask: number, phase: string): void {
  let repaired = 0
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    const occupied = ((mask >> i) & 1) === 1
    const refs = slotRefs[slot.slotId] || (slotRefs[slot.slotId] = {})

    if (occupied) {
      if (refs.solid === undefined || refs.collider === undefined) {
        releaseEntity(refs.solid)
        releaseEntity(refs.collider)
        const created = placeSolid(slot)
        refs.solid = created.solid
        refs.collider = created.collider
        repaired++
      }
      if (refs.ghost !== undefined)  { releaseEntity(refs.ghost);  refs.ghost  = undefined; repaired++ }
      if (refs.hitbox !== undefined) { releaseEntity(refs.hitbox); refs.hitbox = undefined; repaired++ }
    } else if (phase === 'BUILD') {
      if (refs.ghost === undefined || refs.hitbox === undefined) {
        releaseEntity(refs.ghost)
        releaseEntity(refs.hitbox)
        refs.ghost  = placeGhost(slot)
        refs.hitbox = placeHitbox(slot)
        repaired++
      }
      if (refs.solid !== undefined)    { releaseEntity(refs.solid);    refs.solid    = undefined; repaired++ }
      if (refs.collider !== undefined) { releaseEntity(refs.collider); refs.collider = undefined; repaired++ }
    }
  }
  if (repaired > 0) console.log(`[VISUAL-HEALTH] repaired=${repaired}`)
}

//  Reconciliation 
// Runs every frame. Diffs the authoritative state against the local visuals
// and applies the minimum number of mutations to converge. Idempotent.
export function reconcileScene(): void {
  const snap = getClientSnapshot()

  // Out-of-sync or paused: tear everything down and wait.
  if (!snap.resolved || snap.isStale || snap.phase === 'IDLE') {
    if (Object.keys(slotRefs).length > 0) {
      clearAllSlotVisuals(snap.isStale ? 'stale' : (snap.resolved ? 'idle' : 'unresolved'))
      activeTemplateId = ''
      activeRoundNumber = 0
      lastBoardPhase = snap.phase
    }
    return
  }

  const phase = snap.phase
  const templateId = snap.templateId
  const slots = getTemplate(templateId)
  if (!slots) return

  // Round/template change: wipe and rebuild.
  const phaseRebuild = phase !== lastBoardPhase
  if (templateId !== activeTemplateId || snap.roundNumber !== activeRoundNumber) {
    clearAllSlotVisuals(`rebuild template=${templateId} round=${snap.roundNumber}`)
    activeTemplateId = templateId as TemplateId
    activeRoundNumber = snap.roundNumber
  }
  lastBoardPhase = phase

  const buildable = phase === 'BUILD'
  const showSolids =
    phase === 'BUILD' ||
    phase === 'BUILD_COMPLETE' ||
    phase === 'COUNTDOWN' ||
    phase === 'PERFORM' ||
    phase === 'RESET'

  // Solids are being animated by cinematicAnimSystem during COUNTDOWN/PERFORM —
  // suppress integrity position checks so the checker doesn't flag intentional motion.
  cinematicAnimating = CINEMATIC_ANIM_ENABLED &&
    (phase === 'COUNTDOWN' || phase === 'PERFORM' || phase === 'RESET')

  // On transition into a phase without physical build visuals, declaratively
  // remove all slot entities. Cinematic phases keep solids/colliders alive so a
  // player standing on the finished template does not lose the floor mid-shot.
  if (phaseRebuild && !showSolids) {
    clearAllSlotVisuals(`transition-to=${phase}`)
  }

  // Build occupiedMask from authoritative state.
  const mask = snap.occupiedMask | 0
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    const occupied = ((mask >> i) & 1) === 1

    if (occupied) {
      removeSlotAffordance(slot)
      if (showSolids) ensureSlotSolid(slot)
      else removeSlotSolid(slot)
    } else {
      removeSlotSolid(slot)
      if (buildable) ensureSlotAffordance(slot)
      else removeSlotAffordance(slot)
    }
  }

  if (phaseRebuild) {
    logVisualSummary(`phase=${phase}`)
    const issues = runIntegrityCheck(slots, mask, phase) + logStrayPartMeshes()
    // Always logged on transitions: a clean session must PROVE the checker ran.
    console.log(`[INTEGRITY] ${issues === 0 ? 'ok' : `issues=${issues}`} at=transition phase=${phase}`)

    if (phase === 'BUILD_COMPLETE' && snap.performanceType === 'PERFECT' && snap.roundNumber !== lastTrophyRound) {
      lastTrophyRound = snap.roundNumber
      spawnTrophy(snap)
    }
  }

  // Periodic health audit + integrity verification, every second in all phases.
  const now = Date.now()
  if (now - healthAuditAtMs >= HEALTH_AUDIT_INTERVAL_MS) {
    healthAuditAtMs = now
    if (showSolids) {
      runHealthAudit(slots, mask, phase)
    }
    const issues = runIntegrityCheck(slots, mask, phase) + logStrayPartMeshes()
    if (issues > 0) console.log(`[INTEGRITY] issues=${issues} at=tick phase=${phase}`)
  }
}

//  Trophy spawn / release / animation

function releaseTrophyEntry(entry: TrophyEntry): void {
  for (const b of entry.blocks) {
    trophyBlockPool[b.part].push(b.entity)
    try {
      const t = Transform.getMutable(b.entity)
      t.scale = Vector3.Zero()
      t.position = Vector3.create(SCENE_CENTER.x, HIDDEN_Y, SCENE_CENTER.z)
    } catch (_) {}
  }
  trophyLabelPool.push(entry.label)
  try {
    Transform.getMutable(entry.label).position = Vector3.create(SCENE_CENTER.x, HIDDEN_Y, SCENE_CENTER.z)
  } catch (_) {}
  try { TextShape.getMutable(entry.label).text = '' } catch (_) {}
}

function spawnTrophy(snap: ClientSnapshot): void {
  const slots = getTemplate(snap.templateId)
  if (!slots) return

  if (trophies.length >= MAX_TROPHIES) {
    const old = trophies.shift()!
    releaseTrophyEntry(old)
  }

  const blocks: TrophyBlock[] = []
  const mask = snap.occupiedMask | 0
  for (let i = 0; i < slots.length; i++) {
    if (((mask >> i) & 1) === 0) continue
    const slot = slots[i]
    const part = slot.requiredPart
    const e = trophyBlockPool[part].pop()
    if (e === undefined) { console.log(`[TROPHY] pool exhausted for part=${part}`); continue }
    const localOffset = Vector3.create(
      (slot.position.x - SCENE_CENTER.x) * TROPHY_SCALE,
      (slot.position.y - TEMPLATE_BASE_Y) * TROPHY_SCALE,
      (slot.position.z - SCENE_CENTER.z) * TROPHY_SCALE
    )
    const baseScale = Vector3.create(
      slot.scale.x * GLB_SCALE * TROPHY_SCALE,
      slot.scale.y * GLB_SCALE * TROPHY_SCALE,
      slot.scale.z * GLB_SCALE * TROPHY_SCALE
    )
    blocks.push({ entity: e, part, localOffset, baseScale, baseRot: partRotation(part) })
  }

  const label = trophyLabelPool.pop() ?? (() => {
    const e = engine.addEntity()
    Transform.create(e, { position: Vector3.create(SCENE_CENTER.x, HIDDEN_Y, SCENE_CENTER.z), scale: Vector3.One(), rotation: Quaternion.Identity() })
    TextShape.create(e, { text: '', fontSize: 3, textColor: { r: 1, g: 1, b: 1, a: 0.95 }, outlineColor: { r: 0, g: 0, b: 0 }, outlineWidth: 0.08 })
    Billboard.create(e, { billboardMode: BillboardMode.BM_Y })
    return e
  })()

  const nameLines = snap.builders ? snap.builders.split(', ').join('\n') : ''
  const labelText  = nameLines ? `built by:\n${nameLines}` : 'PERFECT!'
  try { TextShape.getMutable(label).text = labelText } catch (_) {}

  let topExtent = 0
  for (const b of blocks) {
    topExtent = Math.max(topExtent, b.localOffset.y + b.baseScale.y * 0.5)
  }
  const labelOffY  = topExtent + 1.2   // clearance above tallest block (text anchors at centre, names hang down)

  const startAngle = (trophies.length / MAX_TROPHIES) * Math.PI * 2
  const bobPhase   = startAngle
  trophies.push({ blocks, label, orbitAngle: startAngle, bobPhase, labelOffY })

  console.log(`[TROPHY] spawned round=${snap.roundNumber} builders="${snap.builders}" blocks=${blocks.length} total=${trophies.length}`)
}

function updateTrophies(dt: number): void {
  trophyTime += dt
  const spinDeg = trophyTime * 55
  const spinRad = trophyTime * TROPHY_SPIN_RAD
  const cosS = Math.cos(spinRad)
  const sinS = Math.sin(spinRad)
  const spinQuat = Quaternion.fromEulerDegrees(0, spinDeg, 0)

  for (const entry of trophies) {
    entry.orbitAngle += TROPHY_ORBIT_SPD * dt
    const bob = Math.sin(trophyTime * TROPHY_BOB_SPD + entry.bobPhase) * TROPHY_BOB_AMP
    const cx = SCENE_CENTER.x + Math.cos(entry.orbitAngle) * TROPHY_ORBIT_R
    const cz = SCENE_CENTER.z + Math.sin(entry.orbitAngle) * TROPHY_ORBIT_R
    const cy = TROPHY_BASE_Y + bob

    for (const b of entry.blocks) {
      const lx = b.localOffset.x
      const lz = b.localOffset.z
      const rx = cosS * lx - sinS * lz
      const rz = sinS * lx + cosS * lz
      try {
        const t = Transform.getMutable(b.entity)
        t.position = Vector3.create(cx + rx, cy + b.localOffset.y, cz + rz)
        t.scale = b.baseScale
        t.rotation = Quaternion.multiply(spinQuat, b.baseRot)
      } catch (_) {}
    }

    try {
      Transform.getMutable(entry.label).position = Vector3.create(cx, cy + entry.labelOffY, cz)
    } catch (_) {}
  }
}

export function trophySystem(dt: number): void {
  if (trophies.length > 0) updateTrophies(dt)
}

//  Click handler
function clearAntiSpam(slotId: string): void {
  recentClicks.delete(slotId)
}

function onSlotClick(slot: SlotDefinition): void {
  const snap = getClientSnapshot()
  if (!snap.resolved) {
    showFeedback('Connecting...')
    return
  }
  if (snap.isStale) {
    showFeedback('Syncing...')
    return
  }
  if (snap.phase !== 'BUILD') return
  if (snap.templateId !== activeTemplateId || snap.roundNumber !== activeRoundNumber) return
  if (recentClicks.has(slot.slotId)) return

  const slots = TEMPLATES[snap.templateId as TemplateId]
  if (!slots) return
  const idx = slots.findIndex(s => s.slotId === slot.slotId)
  if (idx < 0) return
  if (((snap.occupiedMask >> idx) & 1) === 1) {
    showFeedback('Slot already taken')
    return
  }

  const selected = getSelectedPartFn()
  if (selected !== slot.requiredPart) {
    flashFeedback(slot, Color4.create(1, 0.1, 0.1, 1))
    onWrongPart(slot.requiredPart)
    return
  }

  recentClicks.add(slot.slotId)
  setTimeout(() => recentClicks.delete(slot.slotId), ANTI_SPAM_MS)
  flashFeedback(slot, Color4.create(1, 1, 0.5, 1))
  playSuccess()

  requestAttach(slot.slotId, selected)
}
