import {
  engine, Entity, Transform, GltfContainer, MeshCollider, MeshRenderer,
  Material, MaterialTransparencyMode, ColliderLayer,
  InputAction, pointerEventsSystem, Schemas
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { RoundState, ux } from '../shared/components'
import {
  PartType, PART_TYPES, PART_GLB, GLB_SCALE,
  SCENE_CENTER, DEBUG, RoundPhase
} from '../shared/constants'
import { SlotDefinition, TEMPLATES, TemplateId, getTemplate } from '../shared/templates'
import { getClientSnapshot, requestAttach, getLocalPlayerId } from './client'
import { onWrongPart, showFeedback, playSuccess } from './hud'

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
  const showSolids = phase === 'BUILD' || phase === 'BUILD_COMPLETE'

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    const occupied = ((mask >> i) & 1) === 1
    const refs = slotRefs[slot.slotId]
    if (occupied && showSolids) {
      issues += verifyPlaced(refs?.solid, slot, 'solid', 1)
      issues += verifyPlaced(refs?.collider, slot, 'collider', 1)
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
  const showSolids = phase === 'BUILD' || phase === 'BUILD_COMPLETE'

  // On transition into a non-visual phase, declaratively remove all slot
  // entities. Per-slot removeSlotSolid/removeSlotAffordance depend on slotRefs
  // being fully populated, which is not guaranteed for late joiners whose initial
  // state came from a CRDT snapshot rather than incremental attach events.
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
  }

  // Periodic health audit + integrity verification, every second in all phases.
  const now = Date.now()
  if (now - healthAuditAtMs >= HEALTH_AUDIT_INTERVAL_MS) {
    healthAuditAtMs = now
    if (phase === 'BUILD' || phase === 'BUILD_COMPLETE') {
      runHealthAudit(slots, mask, phase)
    }
    const issues = runIntegrityCheck(slots, mask, phase) + logStrayPartMeshes()
    if (issues > 0) console.log(`[INTEGRITY] issues=${issues} at=tick phase=${phase}`)
  }
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
