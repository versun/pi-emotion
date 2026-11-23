/**
 * Data models and interfaces for the Layered Emotion & Fatigue System Plugin.
 */

export type DecayCurve = "linear" | "exponential";

/**
 * 1. Default Personality Baseline (configurable resting persona)
 * - energy: 0–10 (energy / activity level)
 * - valence: 0–10 (emotional positivity / mood valence)
 */
export interface PersonalityBaseline {
  mood: string;
  energy: number;
  valence: number;
  description: string;
}

/**
 * 2. Base Mood (shared per identity; lazily decays over 6h back to baseline)
 */
export interface BaseMoodState {
  mood: string;
  energy: number;
  valence: number;
  description: string;
  updatedAt: number;
}

/**
 * 3. Context Mood (shared per identity; lazily decays and expires after 2h)
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
 * 4. Fatigue System (shared per identity; driven by workload and lazy idle recovery)
 */
export interface FatigueState {
  fatigue: number; // 0–100
  updatedAt: number;
}

/**
 * Workload event used to accumulate fatigue after completed turns/tool runs.
 */
export interface WorkloadInput {
  /** Number of completed LLM turns (default: 1) */
  turns?: number;
  /** Number of non-passive tool calls executed (default: 0) */
  toolCalls?: number;
  /** Number of failed tool calls (default: 0) */
  toolErrors?: number;
  /** Explicit fatigue delta override (0–100); bypasses turn/tool formula when provided */
  fatigueDelta?: number;
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
  context: BlendedEmotionResult["context"];
  blended: BlendedEmotionResult["blended"];
  fatigue: BlendedEmotionResult["fatigue"] & {
    raw: FatigueState;
  };
}

/**
 * Configuration options for EmotionEngine.
 */
export interface EmotionEngineOptions {
  /** Path to persistent JSON file. Defaults to PI_EMOTION_STATE_PATH or <PI_EMOTION_STATE_DIR or ~/.pi/agent/emotion-state>/<identity>.json */
  storagePath?: string;
  /**
   * User identity for multi-user isolation on a shared machine/account.
   * Defaults to PI_EMOTION_USER > OS username > "default".
   * Stored at <PI_EMOTION_STATE_DIR or ~/.pi/agent/emotion-state>/<identity>.json.
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
  /** Passive idle fatigue recovery in points per hour (default: 15) */
  fatigueRecoveryPerHour?: number;
  /** Fatigue added per completed turn (default: 0.2) */
  fatiguePerTurn?: number;
  /** Additional fatigue per executed tool call (default: 0.05) */
  fatiguePerToolCall?: number;
  /** Additional fatigue per failed tool call (default: 0.1) */
  fatiguePerToolError?: number;
  /** Maximum fatigue added per turn (default: 1.2) */
  maxFatiguePerTurn?: number;
  /** Fatigue threshold above which high exhaustion drags down blended valence (default: 60) */
  highFatigueValenceThreshold?: number;
  /** Maximum valence drag at fatigue = 100 (default: 1.5) */
  maxFatigueValencePenalty?: number;
  /** Optional clock override for deterministic testing */
  now?: () => number;
}
