import {
  engine, Entity, Transform, GltfContainer, AudioSource,
  InputAction, inputSystem, PointerEventType
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { ReactEcsRenderer, UiEntity, Label, ReactEcs } from '@dcl/sdk/react-ecs'
import {
  PART_TYPES, PART_GLB, PART_LABEL, PART_SYMBOL, PartType,
  SCENE_CENTER, PERFORMANCE_LABEL, RoundPhase
} from '../shared/constants'
import { getClientSnapshot } from './client'

let selectedIndex = 0
let shoulderEntity: Entity = 0 as Entity
let carriedVisible = true
let cinematicCameraActive = false
let feedbackText = ''
let feedbackTimer = 0
let showOnboarding = true
let onboardingAlpha = 1
let onboardingDismissed = false
let floatTime = 0
let ambientEntity: Entity = 0 as Entity

const FEEDBACK_DURATION = 2.5

//  Public API 
export function getSelectedPart(): PartType {
  return PART_TYPES[selectedIndex]
}

export function showFeedback(text: string): void {
  feedbackText = text
  feedbackTimer = FEEDBACK_DURATION
}

export function onWrongPart(required: PartType): void {
  showFeedback(`Wrong piece — need ${PART_LABEL[required]}`)
}

export function dismissOnboarding(): void {
  if (!onboardingDismissed) onboardingDismissed = true
}

// Set by cinematic.ts with the REAL camera state — true only when the
// VirtualCamera assignment succeeded. The letterbox keys off this, so a
// client whose explorer rejects the virtual camera keeps its normal view
// instead of getting black bars over first person.
export function setCinematicCameraActive(active: boolean): void {
  cinematicCameraActive = active
}

//  Audio
// One persistent entity per one-shot sound. Retriggering replaces the
// AudioSource component in place — no entities are created or removed
// during gameplay (zero-churn doctrine).
let pressSoundEntity: Entity = 0 as Entity
let successSoundEntity: Entity = 0 as Entity

function createSoundEntity(): Entity {
  const e = engine.addEntity()
  Transform.create(e, { position: Vector3.create(SCENE_CENTER.x, SCENE_CENTER.y + 1, SCENE_CENTER.z) })
  return e
}

function playOneShot(e: Entity, url: string, volume: number): void {
  if (e === (0 as Entity)) return
  try {
    AudioSource.createOrReplace(e, { audioClipUrl: url, playing: true, loop: false, volume })
  } catch (_) {}
}

export function playSuccess(): void {
  playOneShot(successSoundEntity, 'assets/sounds/success.mp3', 1.0)
}

function initAudio(): void {
  if (ambientEntity !== (0 as Entity)) return
  pressSoundEntity = createSoundEntity()
  successSoundEntity = createSoundEntity()
  ambientEntity = engine.addEntity()
  Transform.create(ambientEntity, { position: Vector3.create(SCENE_CENTER.x, SCENE_CENTER.y + 1, SCENE_CENTER.z) })
  AudioSource.create(ambientEntity, {
    audioClipUrl: 'assets/sounds/ambient.mp3',
    playing: true,
    loop: true,
    volume: 0.06,
    global: true
  })
}

//  Shoulder carried piece
export function initShoulder(playerEntity: Entity): void {
  if (shoulderEntity !== (0 as Entity)) return
  shoulderEntity = engine.addEntity()
  Transform.create(shoulderEntity, {
    position: Vector3.create(0.5, 1.5, -0.5),
    scale: carriedVisible ? Vector3.create(0.286, 0.286, 0.286) : Vector3.Zero(),
    rotation: Quaternion.Identity(),
    parent: playerEntity
  })
  GltfContainer.create(shoulderEntity, { src: PART_GLB[PART_TYPES[selectedIndex]] })
}

export function setCarriedVisible(visible: boolean): void {
  carriedVisible = visible
  if (shoulderEntity === (0 as Entity)) return
  try {
    Transform.getMutable(shoulderEntity).scale = visible
      ? Vector3.create(0.286, 0.286, 0.286)
      : Vector3.Zero()
  } catch (_) {}
}

function updateShoulderPiece(): void {
  if (shoulderEntity === (0 as Entity)) return
  GltfContainer.createOrReplace(shoulderEntity, { src: PART_GLB[PART_TYPES[selectedIndex]] })
}

//  Input 
export function hudInputSystem(_dt: number): void {
  if (inputSystem.isTriggered(InputAction.IA_PRIMARY, PointerEventType.PET_DOWN)) {
    selectedIndex = (selectedIndex + 1) % PART_TYPES.length
    updateShoulderPiece()
    playOneShot(pressSoundEntity, 'assets/sounds/pressE.mp3', 1.0)
    dismissOnboarding()
  }
}

//  Per-frame ticks
let lastHudPhase: RoundPhase = 'IDLE'

export function hudTickSystem(dt: number): void {
  // Feedback messages are BUILD-phase interaction hints; drop them on any
  // phase change so they never overlap the cinematic letterbox.
  const phase = getClientSnapshot().phase
  if (phase !== lastHudPhase) {
    lastHudPhase = phase
    feedbackText = ''
    feedbackTimer = 0
  }

  if (feedbackTimer > 0) {
    feedbackTimer = Math.max(0, feedbackTimer - dt)
    if (feedbackTimer <= 0) feedbackText = ''
  }
  if (onboardingDismissed && onboardingAlpha > 0) {
    onboardingAlpha = Math.max(0, onboardingAlpha - dt * 1.8)
    if (onboardingAlpha <= 0) showOnboarding = false
  }
  floatTime += dt
  if (shoulderEntity !== (0 as Entity)) {
    try {
      const t = Transform.getMutable(shoulderEntity)
      t.position = Vector3.create(0.5, 1.5 + Math.sin(floatTime * 2.5) * 0.06, -0.5)
    } catch (_) {}
  }
}

//  UI 
const PART_UI_COLOR: Record<PartType, { r: number; g: number; b: number; a: number }> = {
  CUBE:     { r: 0.2, g: 0.5, b: 1,    a: 1 },
  CYLINDER: { r: 1,   g: 0.2, b: 0.2,  a: 1 },
  CONE:     { r: 1,   g: 0.85, b: 0,   a: 1 }
}

function phaseLabel(phase: RoundPhase, snap: ReturnType<typeof getClientSnapshot>): string {
  switch (phase) {
    case 'BUILD':          return `BUILD THE ${snap.templateId} — ${snap.secondsLeft}s`
    case 'BUILD_COMPLETE': return snap.performanceType === 'PERFECT' ? PERFORMANCE_LABEL.PERFECT : PERFORMANCE_LABEL.FAIL
    case 'COUNTDOWN':      return `GET READY... ${snap.secondsLeft}`
    case 'PERFORM':        return snap.performanceType === 'PERFECT' ? PERFORMANCE_LABEL.PERFECT : PERFORMANCE_LABEL.FAIL
    case 'RESET':          return 'NEXT ROUND...'
    default:               return 'WAITING...'
  }
}

export function initHUD(): void {
  initAudio()

  ReactEcsRenderer.setUiRenderer(() => {
    const snap = getClientSnapshot()
    const phase = snap.phase
    const inBuild = phase === 'BUILD' && !snap.isStale
    // Letterbox only while the cinematic camera is genuinely driving the view.
    const inCinematic = cinematicCameraActive && !snap.isStale
    const syncing = !snap.resolved || snap.isStale

    const partsRequired = Math.max(1, snap.partsRequired)
    const pct = Math.round((snap.partsAttached / partsRequired) * 100)
    const isUrgent = inBuild && snap.secondsLeft <= 10
    const label = syncing
      ? 'Syncing with server...'
      : phaseLabel(phase, snap)

    return (
      <UiEntity uiTransform={{ width: 1920, height: 1080, positionType: 'absolute', position: { top: 0, left: 0 } }}>

        {/* Top bar — phase / timer / syncing */}
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: 12, left: 480 },
            width: 960, height: 38,
            alignItems: 'center',
            justifyContent: 'center'
          }}
          uiBackground={{
            color: syncing
              ? { r: 0.25, g: 0.15, b: 0.05, a: 0.92 }
              : { r: 0.05, g: 0.05, b: 0.18, a: 0.92 }
          }}
        >
          <Label
            value={label}
            fontSize={isUrgent ? 18 : 15}
            color={{
              r: 1,
              g: isUrgent ? 0.3 : (syncing ? 0.8 : 1),
              b: isUrgent ? 0.3 : (syncing ? 0.4 : 1),
              a: 1
            }}
            uiTransform={{ width: '100%', height: '100%' }}
            textAlign='middle-center'
          />
        </UiEntity>

        {/* All conditional blocks below stay permanently mounted and toggle
            via display — unmount/remount churn of UI entities desyncs the
            Unity renderer (icons/text dropped or ghosted). */}

        {/* Progress bar */}
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: 60, left: 576 }, width: 768, height: 14, display: inBuild ? 'flex' : 'none' }}
          uiBackground={{ color: { r: 0.1, g: 0.1, b: 0.1, a: 0.7 } }}
        >
          <UiEntity
            uiTransform={{ width: `${pct}%`, height: 14 }}
            uiBackground={{ color: { r: 0.15, g: 0.75, b: 0.3, a: 1 } }}
          />
        </UiEntity>

        {/* Progress label */}
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: 78, left: 576 }, width: 768, height: 20, alignItems: 'center', justifyContent: 'center', display: inBuild ? 'flex' : 'none' }}
        >
          <Label
            value={`${snap.partsAttached} / ${snap.partsRequired}`}
            fontSize={12}
            color={{ r: 0.85, g: 0.85, b: 1, a: 1 }}
            uiTransform={{ width: '100%', height: '100%' }}
            textAlign='middle-center'
          />
        </UiEntity>

        {/* Piece picker */}
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: 110, left: 740 },
            width: 440, height: 104,
            flexDirection: 'column',
            alignItems: 'center',
            display: inBuild ? 'flex' : 'none'
          }}
          uiBackground={{ color: { r: 0.05, g: 0.05, b: 0.2, a: 0.88 } }}
        >
            <Label
              value='CURRENT BLOCK'
              fontSize={10}
              color={{ r: 0.5, g: 0.5, b: 0.9, a: 0.9 }}
              uiTransform={{ width: '100%', height: 20 }}
              textAlign='middle-center'
            />
            <UiEntity
              uiTransform={{ width: '100%', height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' }}
            >
              {PART_TYPES.map(pt => {
                const isSelected = pt === PART_TYPES[selectedIndex]
                const col = PART_UI_COLOR[pt]
                return (
                  <UiEntity
                    key={pt}
                    uiTransform={{ width: 60, height: 48, alignItems: 'center', justifyContent: 'center' }}
                    uiBackground={{ color: isSelected
                      ? { r: 0.12, g: 0.12, b: 0.45, a: 1 }
                      : { r: 0.02, g: 0.02, b: 0.1, a: 0.8 }
                    }}
                  >
                    <Label
                      value={PART_SYMBOL[pt]}
                      fontSize={28}
                      color={isSelected
                        ? col
                        : { r: col.r * 0.5, g: col.g * 0.5, b: col.b * 0.5, a: 0.6 }
                      }
                      uiTransform={{ width: '100%', height: '100%' }}
                      textAlign='middle-center'
                    />
                  </UiEntity>
                )
              })}
            </UiEntity>
            <Label
              value='Press E to change block'
              fontSize={9}
              color={{ r: 0.6, g: 0.6, b: 0.8, a: 0.85 }}
              uiTransform={{ width: '100%', height: 18 }}
              textAlign='middle-center'
            />
        </UiEntity>

        {/* Feedback — bottom bar */}
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: 1020, left: 480 }, width: 960, height: 38, alignItems: 'center', justifyContent: 'center', display: feedbackText !== '' ? 'flex' : 'none' }}
          uiBackground={{ color: { r: 0.05, g: 0.05, b: 0.2, a: 0.88 } }}
        >
          <Label
            value={feedbackText}
            fontSize={14}
            color={{ r: 1, g: 1, b: 1, a: 1 }}
            uiTransform={{ width: '100%', height: '100%' }}
            textAlign='middle-center'
          />
        </UiEntity>

        {/* Onboarding */}
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: 200, left: 480 },
            width: 960,
            flexDirection: 'column',
            alignItems: 'center',
            display: showOnboarding && !inCinematic && !syncing ? 'flex' : 'none'
          }}
          uiBackground={{ color: { r: 0.03, g: 0.03, b: 0.15, a: 0.95 * onboardingAlpha } }}
        >
            <Label
              value='DECENTRALAND BUILDER'
              fontSize={42}
              color={{ r: 0, g: 1, b: 1, a: onboardingAlpha }}
              uiTransform={{ width: '100%', height: 60 }}
              textAlign='middle-center'
            />
            <Label
              value='Place the matching pieces before the timer runs out.'
              fontSize={20}
              color={{ r: 0.9, g: 0.9, b: 1, a: onboardingAlpha }}
              uiTransform={{ width: '100%', height: 32 }}
              textAlign='middle-center'
            />
            <Label
              value='Press E to change piece. Click a slot to place.'
              fontSize={16}
              color={{ r: 0.9, g: 0.9, b: 1, a: onboardingAlpha }}
              uiTransform={{ width: '100%', height: 28 }}
              textAlign='middle-center'
            />
            <Label value=' ' fontSize={6} color={{ r: 0, g: 0, b: 0, a: 0 }} uiTransform={{ width: '100%', height: 10 }} textAlign='middle-center' />
        </UiEntity>

        {/* Cinematic letterbox */}
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', display: inCinematic ? 'flex' : 'none' }}>
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: 1920, height: 140 }}
            uiBackground={{ color: { r: 0, g: 0, b: 0, a: 1 } }}
          />
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: 940, left: 0 }, width: 1920, height: 140 }}
            uiBackground={{ color: { r: 0, g: 0, b: 0, a: 1 } }}
          />
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: 380, left: 0 }, width: 1920, height: 80, alignItems: 'center', justifyContent: 'center' }}
          >
            <Label
              value='NEXT ROUND'
              fontSize={48}
              color={{ r: 1, g: 1, b: 1, a: 1 }}
              uiTransform={{ width: '100%', height: 80 }}
              textAlign='middle-center'
            />
          </UiEntity>
        </UiEntity>

      </UiEntity>
    )
  }, { virtualWidth: 1920, virtualHeight: 1080 })
}
