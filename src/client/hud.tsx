import {
  engine, Entity, Transform, GltfContainer, AudioSource,
  InputAction, inputSystem, PointerEventType
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { ReactEcsRenderer, UiEntity, Label, ReactEcs } from '@dcl/sdk/react-ecs'
import {
  PART_TYPES, PART_GLB, PART_LABEL, PART_SYMBOL, PartType,
  SCENE_CENTER, PERFORMANCE_LABEL, RoundPhase,
  COUNTDOWN_SECONDS, PERFORMANCE_DURATION_SECONDS, RESET_DELAY_SECONDS
} from '../shared/constants'
import { getClientSnapshot } from './client'

let selectedIndex = 0
// One persistent entity per piece type, each with its GLB loaded once at
// init. Cycling pieces only toggles which one is visible (scale) — the GLB
// src is never swapped on a live entity, which the Unity renderer fails to
// reinstantiate (the same churn that broke slot visuals).
const shoulderEntities: Entity[] = []
const SHOULDER_SCALE = 0.286
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

// Total seconds left in the whole inter-round cinematic window (COUNTDOWN +
// PERFORM + RESET), counted down as one continuous number (~7 → 0).
function cinematicSecondsLeft(phase: RoundPhase, secondsLeftInPhase: number): number {
  if (phase === 'COUNTDOWN') return secondsLeftInPhase + PERFORMANCE_DURATION_SECONDS + RESET_DELAY_SECONDS
  if (phase === 'PERFORM')   return secondsLeftInPhase + RESET_DELAY_SECONDS
  if (phase === 'RESET')     return secondsLeftInPhase
  return 0
}

//  Audio
// One-shot SFX use a small round-robin pool of "voice" entities. A single
// AudioSource can only voice one instance at a time, so two rapid clicks on
// the same entity just restart the sound — you never hear both. Cycling
// through N voices lets back-to-back plays overlap. All voices are created
// once at init; gameplay only retriggers them (zero entity churn).
const SFX_VOICES = 6
const successVoices: Entity[] = []
const pressVoices: Entity[] = []
let successCursor = 0
let pressCursor = 0

function createVoiceEntity(): Entity {
  const e = engine.addEntity()
  Transform.create(e, { position: Vector3.create(SCENE_CENTER.x, SCENE_CENTER.y + 1, SCENE_CENTER.z) })
  return e
}

function playVoice(voices: Entity[], cursor: number, url: string, volume: number): number {
  if (voices.length === 0) return cursor
  try {
    AudioSource.createOrReplace(voices[cursor], { audioClipUrl: url, playing: true, loop: false, volume })
  } catch (_) {}
  return (cursor + 1) % voices.length
}

export function playSuccess(): void {
  successCursor = playVoice(successVoices, successCursor, 'assets/sounds/success.mp3', 1.0)
}

function playPress(): void {
  pressCursor = playVoice(pressVoices, pressCursor, 'assets/sounds/pressE.mp3', 1.0)
}

function initAudio(): void {
  if (ambientEntity !== (0 as Entity)) return
  for (let i = 0; i < SFX_VOICES; i++) {
    successVoices.push(createVoiceEntity())
    pressVoices.push(createVoiceEntity())
  }
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
  if (shoulderEntities.length > 0) return
  for (let i = 0; i < PART_TYPES.length; i++) {
    const e = engine.addEntity()
    const show = carriedVisible && i === selectedIndex
    Transform.create(e, {
      position: Vector3.create(0.5, 1.5, -0.5),
      scale: show ? Vector3.create(SHOULDER_SCALE, SHOULDER_SCALE, SHOULDER_SCALE) : Vector3.Zero(),
      rotation: Quaternion.Identity(),
      parent: playerEntity
    })
    GltfContainer.create(e, { src: PART_GLB[PART_TYPES[i]] })
    shoulderEntities.push(e)
  }
}

function applyShoulderVisibility(): void {
  for (let i = 0; i < shoulderEntities.length; i++) {
    const show = carriedVisible && i === selectedIndex
    try {
      Transform.getMutable(shoulderEntities[i]).scale = show
        ? Vector3.create(SHOULDER_SCALE, SHOULDER_SCALE, SHOULDER_SCALE)
        : Vector3.Zero()
    } catch (_) {}
  }
}

export function setCarriedVisible(visible: boolean): void {
  carriedVisible = visible
  applyShoulderVisibility()
}

function updateShoulderPiece(): void {
  applyShoulderVisibility()
}

//  Input 
export function hudInputSystem(_dt: number): void {
  if (inputSystem.isTriggered(InputAction.IA_PRIMARY, PointerEventType.PET_DOWN)) {
    selectedIndex = (selectedIndex + 1) % PART_TYPES.length
    updateShoulderPiece()
    playPress()
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
  const shoulderY = 1.5 + Math.sin(floatTime * 2.5) * 0.06
  for (const e of shoulderEntities) {
    try {
      Transform.getMutable(e).position = Vector3.create(0.5, shoulderY, -0.5)
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
                const tint = isSelected
                  ? col
                  : { r: col.r * 0.5, g: col.g * 0.5, b: col.b * 0.5, a: 0.6 }
                return (
                  <UiEntity
                    key={pt}
                    uiTransform={{ width: 60, height: 48, alignItems: 'center', justifyContent: 'center' }}
                    uiBackground={{ color: isSelected
                      ? { r: 0.12, g: 0.12, b: 0.45, a: 1 }
                      : { r: 0.02, g: 0.02, b: 0.1, a: 0.8 }
                    }}
                  >
                    {pt === 'CYLINDER' ? (
                      <UiEntity
                        uiTransform={{ width: 34, height: 34 }}
                        uiBackground={{
                          texture: { src: 'assets/images/octagon.png' },
                          textureMode: 'stretch',
                          color: tint
                        }}
                      />
                    ) : (
                      <Label
                        value={PART_SYMBOL[pt]}
                        fontSize={28}
                        color={tint}
                        uiTransform={{ width: '100%', height: '100%' }}
                        textAlign='middle-center'
                      />
                    )}
                  </UiEntity>
                )
              })}
            </UiEntity>
            <Label
              value='Press <color=#00ffff><size=14>E</size></color> to change block'
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
            position: { top: 280, left: 480 },
            width: 960,
            flexDirection: 'column',
            alignItems: 'center',
            display: showOnboarding && !inCinematic && !syncing ? 'flex' : 'none'
          }}
          uiBackground={{ color: { r: 0.03, g: 0.03, b: 0.15, a: 0.95 * onboardingAlpha } }}
        >
            <Label
              value='ALIENSCRAPYARD'
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
              value='Press <color=#00ffff><size=22>E</size></color> to change piece. Click a slot to place.'
              fontSize={16}
              color={{ r: 0.9, g: 0.9, b: 1, a: onboardingAlpha }}
              uiTransform={{ width: '100%', height: 28 }}
              textAlign='middle-center'
            />
            <Label value=' ' fontSize={6} color={{ r: 0, g: 0, b: 0, a: 0 }} uiTransform={{ width: '100%', height: 10 }} textAlign='middle-center' />
        </UiEntity>

        {/* Cinematic letterbox + countdown + effects */}
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', display: inCinematic ? 'flex' : 'none' }}>

          {/* Top + bottom letterbox bars */}
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: 1920, height: 140 }}
            uiBackground={{ color: { r: 0, g: 0, b: 0, a: 1 } }}
          />
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: 940, left: 0 }, width: 1920, height: 140 }}
            uiBackground={{ color: { r: 0, g: 0, b: 0, a: 1 } }}
          />

          {/* Inner edge glow — top + bottom */}
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: 136, left: 0 }, width: 1920, height: 4 }}
            uiBackground={{ color: { r: 0.3, g: 0.6, b: 1, a: 0.5 + Math.sin(floatTime * 2.2) * 0.3 } }}
          />
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: 940, left: 0 }, width: 1920, height: 4 }}
            uiBackground={{ color: { r: 0.3, g: 0.6, b: 1, a: 0.5 + Math.sin(floatTime * 2.2 + 1.5) * 0.3 } }}
          />

          {/* Left + right accent bars pulsing (offset phase) */}
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: 140, left: 0 }, width: 4, height: 800 }}
            uiBackground={{ color: { r: 0.3, g: 0.6, b: 1, a: Math.max(0.1, 0.4 + Math.sin(floatTime * 2.5) * 0.4) } }}
          />
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: 140, left: 1916 }, width: 4, height: 800 }}
            uiBackground={{ color: { r: 0.3, g: 0.6, b: 1, a: Math.max(0.1, 0.4 + Math.sin(floatTime * 2.5 + Math.PI) * 0.4) } }}
          />

          {/* Moving scan line */}
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: { top: Math.round(140 + ((Math.sin(floatTime * 0.75) + 1) / 2) * 790), left: 0 },
              width: 1920, height: 3
            }}
            uiBackground={{ color: { r: 0.5, g: 0.8, b: 1, a: 0.45 } }}
          />

          {/* "NEXT BUILD IN" label */}
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: 162, left: 0 }, width: 1920, height: 58, alignItems: 'center', justifyContent: 'center' }}
          >
            <Label
              value='NEXT BUILD IN'
              fontSize={26}
              color={{ r: 0.75, g: 0.85, b: 1, a: Math.max(0.4, 0.7 + Math.sin(floatTime * 3.5) * 0.3) }}
              uiTransform={{ width: '100%', height: 58 }}
              textAlign='middle-center'
            />
          </UiEntity>

          {/* Countdown number — warm color cycle */}
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: 210, left: 0 }, width: 1920, height: 200, alignItems: 'center', justifyContent: 'center' }}
          >
            <Label
              value={`${Math.max(0, cinematicSecondsLeft(phase, snap.secondsLeft))}`}
              fontSize={160}
              color={{
                r: Math.min(1, 0.75 + Math.sin(floatTime * 2.0) * 0.25),
                g: Math.max(0, 0.75 + Math.sin(floatTime * 2.0 + 1.2) * 0.25),
                b: Math.max(0, 0.1  + Math.sin(floatTime * 2.0 + 2.4) * 0.15),
                a: 1
              }}
              uiTransform={{ width: '100%', height: 200 }}
              textAlign='middle-center'
            />
          </UiEntity>

          {/* Depleting progress bar — total cinematic time remaining */}
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: 428, left: 360 }, width: 1200, height: 5 }}
            uiBackground={{ color: { r: 0.08, g: 0.08, b: 0.25, a: 0.7 } }}
          >
            <UiEntity
              uiTransform={{
                width: Math.round(
                  (Math.max(0, cinematicSecondsLeft(phase, snap.secondsLeft)) /
                  (COUNTDOWN_SECONDS + PERFORMANCE_DURATION_SECONDS + RESET_DELAY_SECONDS)) * 1200
                ),
                height: 5
              }}
              uiBackground={{ color: { r: 0.3, g: 0.65, b: 1, a: 0.85 } }}
            />
          </UiEntity>

        </UiEntity>

      </UiEntity>
    )
  }, { virtualWidth: 1920, virtualHeight: 1080 })
}
