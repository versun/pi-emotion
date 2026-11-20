/**
 * Data models and interfaces for the Layered Emotion & Fatigue System Plugin.
 */

export type SleepStatus = "AWAKE" | "SLEEPING";

export type DecayCurve = "linear" | "exponential";

/**
 * 1. Default Personality Baseline (可配置默认人格基线)
 * - energy: 0–10 (精力/活跃度)
 * - valence: 0–10 (情绪正负向/愉悦度)
 */
export interface PersonalityBaseline {
  mood: string;
  energy: number;
  valence: number;
  description: string;
}

/**
 * 2. Base Mood (底层情绪 — 身份级共享，6小时衰减回落至默认人格基线)
 */
export interface BaseMoodState {
  mood: string;
  energy: number;
  valence: number;
  description: string;
  updatedAt: number;
}

/**
 * 3. Context Mood (场景情绪 — 身份级共享，2小时衰减过期)
 *
 * One shared short-term mood per user identity: a mood shift set in any
 * session is visible to every session of that identity until it decays.
 */
export interface ContextMoodState {
  mood: string;
  valence: number;
  trigger: string;
  updatedAt: number;
}

/**
 * 4. Fatigue System (疲劳与睡眠状态 — 身份级共享)
 */
export interface FatigueState {
  status: SleepStatus;
  fatigue: number; // 0–100
  updatedAt: number;
}

/**
 * Persisted JSON schema on disk.
 */
export interface EmotionPersistedState {
  version: 1;
  baseline: PersonalityBaseline;
  base: BaseMoodState;
  context: ContextMoodState | null;
  fatigue: FatigueState;
}

/**
 * Return shape of `getBlendedEmotion()`
 */
export interface BlendedEmotionResult {
  base: {
    mood: string;
    energy: number;
    valence: number;
    description: string;
    updatedAt: number;
    decayProgress: number;
  };
  context: {
    mood: string;
    valence: number;
    trigger: string;
    updatedAt: number;
    remainingWeight: number;
  } | null;
  blended: {
    mood: string;
    valence: number;
    energy: number;
  };
  fatigue: {
    status: SleepStatus;
    value: number;
    energyCap: number;
    updatedAt: number;
  };
}

/**
 * Full status overview across Base Mood, the shared Context Mood, and Fatigue.
 */
export interface EmotionSystemStatus {
  now: number;
  identity: string;
  baseline: PersonalityBaseline;
  base: BlendedEmotionResult["base"] & {
    raw: BaseMoodState;
  };
  context:
    | (NonNullable<BlendedEmotionResult["context"]> & {
        blendedValence: number;
      })
    | null;
  fatigue: BlendedEmotionResult["fatigue"];
}

/**
 * Configuration options for EmotionEngine.
 */
export interface EmotionEngineOptions {
  /** Path to persistent JSON file. Defaults to PI_EMOTION_STATE_PATH or ~/.pi/agent/emotion-state.json */
  storagePath?: string;
  /**
   * User identity for multi-user isolation on a shared machine/account.
   * Defaults to PI_EMOTION_USER > OS username > "default".
   * A custom identity gets its own state file under emotion-state/users/.
   */
  identity?: string;
  /** Default personality baseline */
  baseline?: Partial<PersonalityBaseline>;
  /** Base mood full decay window in ms (default: 6 hours = 21_600_000 ms) */
  baseDecayMs?: number;
  /** Context mood expiration window in ms (default: 2 hours = 7_200_000 ms) */
  contextDecayMs?: number;
  /** Maximum immediate valence deviation of Context Mood from current Base Mood (default: 4.0) */
  maxGravityDelta?: number;
  /** Maximum pull weight of fresh Context Mood against Base Mood at t=0 (default: 0.65) */
  contextWeight?: number;
  /** Interpolation curve for lazy decay (default: "linear") */
  decayCurve?: DecayCurve;
  /** Optional clock override for deterministic testing */
  now?: () => number;
}
