import {
  clampNumber,
  EmotionStorage,
  normalizeNumber,
  normalizeText,
  resolveIdentity,
  resolveStoragePath,
  round1,
  round2,
} from "./storage.ts";
import type {
  BlendedEmotionResult,
  ContextMoodState,
  DecayCurve,
  EmotionEngineOptions,
  EmotionPersistedState,
  EmotionSystemStatus,
  FatigueState,
  PersonalityBaseline,
} from "./types.ts";

/** 6 hours in milliseconds */
export const BASE_DECAY_MS = 6 * 60 * 60 * 1000;

/** 2 hours in milliseconds */
export const CONTEXT_DECAY_MS = 2 * 60 * 60 * 1000;

/** Maximum immediate offset a Context Mood can have from current Base Mood valence */
export const DEFAULT_MAX_GRAVITY_DELTA = 4.0;

/** Default pull weight of a fresh Context Mood against Base Mood at t=0 */
export const DEFAULT_CONTEXT_WEIGHT = 0.65;

/**
 * Compute normalized interpolation progress [0, 1] over a decay window.
 * Supports both linear and smooth exponential decay curves that reach 1.0 at `windowMs`.
 */
export function computeDecayFactor(
  elapsedMs: number,
  windowMs: number,
  curve: DecayCurve = "linear",
): number {
  if (windowMs <= 0) return 1;
  const linear = clampNumber(elapsedMs / windowMs, 0, 1);
  if (linear >= 1) return 1;
  if (linear <= 0) return 0;

  if (curve === "exponential") {
    const k = 3;
    return (1 - Math.exp(-k * linear)) / (1 - Math.exp(-k));
  }
  return linear;
}

/**
 * Compute maximum sustainable energy (0–10) allowed by current Fatigue & Sleep status.
 * - SLEEPING => capped at 1.0
 * - AWAKE    => linearly scales from 10.0 (at fatigue 0) down to 1.0 (at fatigue 100)
 */
export function computeEnergyCapFromFatigue(
  fatigue: Pick<FatigueState, "status" | "fatigue">,
): number {
  if (fatigue.status === "SLEEPING") {
    return 1.0;
  }
  const f = clampNumber(fatigue.fatigue, 0, 100);
  return round1(10 - (f / 100) * 9);
}

/**
 * Constrain raw energy [0, 10] by the current fatigue ceiling.
 */
export function computeEffectiveEnergy(
  rawEnergy: number,
  fatigue: Pick<FatigueState, "status" | "fatigue">,
): number {
  const cap = computeEnergyCapFromFatigue(fatigue);
  return round1(clampNumber(Math.min(rawEnergy, cap), 0, 10));
}

/**
 * Emotional Gravity Clamping Function (引力夹逼函数):
 * Anchors a target Context valence around the active Base valence within `[-maxDelta, +maxDelta]`,
 * preventing extreme single-turn mood whiplash (e.g., jumping from valence 1 to 10 on one compliment).
 */
export function clampValenceByGravity(
  targetValence: number,
  baseValence: number,
  maxDelta: number = DEFAULT_MAX_GRAVITY_DELTA,
): number {
  const clampedTarget = clampNumber(targetValence, 0, 10);
  const clampedBase = clampNumber(baseValence, 0, 10);
  const delta = Math.max(0, maxDelta);
  const minAllowed = Math.max(0, clampedBase - delta);
  const maxAllowed = Math.min(10, clampedBase + delta);
  return round1(clampNumber(clampedTarget, minAllowed, maxAllowed));
}

/**
 * Emotional Gravity Blending Function (引力加权融合):
 * Combines Base valence and gravity-clamped Context valence, weighted by Context's remaining freshness.
 */
export function blendValenceWithGravity(
  baseValence: number,
  contextValence: number,
  remainingWeight: number,
  contextWeight: number = DEFAULT_CONTEXT_WEIGHT,
  maxDelta: number = DEFAULT_MAX_GRAVITY_DELTA,
): number {
  const clampedContext = clampValenceByGravity(contextValence, baseValence, maxDelta);
  const effectiveWeight = clampNumber(contextWeight, 0, 1) * clampNumber(remainingWeight, 0, 1);
  return round1(baseValence * (1 - effectiveWeight) + clampedContext * effectiveWeight);
}

export class EmotionEngine {
  readonly storage: EmotionStorage;
  readonly identity: string;
  readonly baseDecayMs: number;
  readonly contextDecayMs: number;
  readonly maxGravityDelta: number;
  readonly contextWeight: number;
  readonly decayCurve: DecayCurve;
  private readonly clock: () => number;

  constructor(options: EmotionEngineOptions = {}) {
    this.identity = resolveIdentity(options.identity);
    const storagePath =
      options.storagePath ?? resolveStoragePath(this.identity);
    this.storage = new EmotionStorage(storagePath, options.baseline);
    this.baseDecayMs = options.baseDecayMs ?? BASE_DECAY_MS;
    this.contextDecayMs = options.contextDecayMs ?? CONTEXT_DECAY_MS;
    this.maxGravityDelta = options.maxGravityDelta ?? DEFAULT_MAX_GRAVITY_DELTA;
    this.contextWeight = options.contextWeight ?? DEFAULT_CONTEXT_WEIGHT;
    this.decayCurve = options.decayCurve ?? "linear";
    this.clock = options.now ?? (() => Date.now());
  }

  private now(nowOverride?: number): number {
    return typeof nowOverride === "number" && Number.isFinite(nowOverride)
      ? nowOverride
      : this.clock();
  }

  /**
   * Load persisted state, lazily pruning an expired shared Context Mood on disk.
   */
  private loadState(currentTime: number): EmotionPersistedState {
    const state = this.storage.load(currentTime);
    if (this.pruneExpiredContext(state, currentTime)) {
      this.storage.save(state);
    }
    return state;
  }

  /**
   * Load state, apply a mutation, persist (unless mutator returns `false` for a no-op),
   * and return the resulting blended snapshot without a redundant reload.
   */
  private transact(
    currentTime: number,
    mutate: (state: EmotionPersistedState) => boolean | void,
  ): BlendedEmotionResult {
    const state = this.loadState(currentTime);
    if (mutate(state) !== false) {
      this.storage.save(state);
    }
    return this.computeBlend(state, currentTime);
  }

  /**
   * Compute decayed Base Mood at `currentTime` without mutating disk unless requested.
   */
  private computeDecayedBase(
    state: EmotionPersistedState,
    currentTime: number,
  ): BlendedEmotionResult["base"] {
    const { base, baseline, fatigue } = state;
    const elapsed = Math.max(0, currentTime - base.updatedAt);
    // Keep the unrounded factor for the boundary comparison: rounding first
    // would trigger full revert up to ~40min early under the exponential curve.
    const decayFactor = computeDecayFactor(
      elapsed,
      this.baseDecayMs,
      this.decayCurve,
    );
    const decayProgress = round2(decayFactor);
    const sleeping = fatigue.status === "SLEEPING";

    if (decayFactor >= 1) {
      return {
        mood: sleeping ? "sleepy" : baseline.mood,
        valence: round1(baseline.valence),
        energy: computeEffectiveEnergy(baseline.energy, fatigue),
        description: baseline.description,
        updatedAt: base.updatedAt,
        decayProgress: 1,
      };
    }

    // Interpolate with the unrounded factor so valence/energy cannot fully
    // revert while the boundary check still keeps the mood label — keeps
    // compute and display consistent in the tail of the decay window.
    const decayedValence = round1(
      base.valence + (baseline.valence - base.valence) * decayFactor,
    );
    const decayedRawEnergy = round1(
      base.energy + (baseline.energy - base.energy) * decayFactor,
    );

    return {
      mood: sleeping ? "sleepy" : base.mood,
      valence: decayedValence,
      energy: computeEffectiveEnergy(decayedRawEnergy, fatigue),
      description: base.description,
      updatedAt: base.updatedAt,
      decayProgress,
    };
  }

  private isContextExpired(ctx: ContextMoodState, currentTime: number): boolean {
    const elapsed = Math.max(0, currentTime - ctx.updatedAt);
    return elapsed >= this.contextDecayMs;
  }

  /**
   * Compute decayed shared Context Mood at `currentTime`.
   * Returns `null` if missing or past the context decay window.
   */
  private computeDecayedContext(
    ctx: ContextMoodState | null | undefined,
    currentTime: number,
  ): BlendedEmotionResult["context"] {
    if (!ctx || this.isContextExpired(ctx, currentTime)) return null;
    const elapsed = Math.max(0, currentTime - ctx.updatedAt);
    const remainingFactor =
      1 - computeDecayFactor(elapsed, this.contextDecayMs, this.decayCurve);
    // Compare on the unrounded factor so near-expiry contexts are not dropped
    // early just because their remaining weight rounds to 0.00.
    if (remainingFactor <= 0) {
      return null;
    }
    const remainingWeight = round2(remainingFactor);

    return {
      mood: ctx.mood,
      valence: round1(ctx.valence),
      trigger: ctx.trigger,
      updatedAt: ctx.updatedAt,
      remainingWeight,
    };
  }

  /**
   * Clear the expired shared Context Mood in-place before saving.
   */
  private pruneExpiredContext(state: EmotionPersistedState, currentTime: number): boolean {
    if (state.context && this.isContextExpired(state.context, currentTime)) {
      state.context = null;
      return true;
    }
    return false;
  }

  private static fatigueResult(
    fatigue: FatigueState,
  ): BlendedEmotionResult["fatigue"] {
    return {
      status: fatigue.status,
      value: round1(fatigue.fatigue),
      energyCap: computeEnergyCapFromFatigue(fatigue),
      updatedAt: fatigue.updatedAt,
    };
  }

  /**
   * Compute the blended emotion snapshot for an already-loaded state:
   * lazy Base decay, shared-Context expiration/decay, Emotional Gravity
   * clamping & weighted blending, and Fatigue-to-Energy constraints.
   */
  private computeBlend(
    state: EmotionPersistedState,
    currentTime: number,
  ): BlendedEmotionResult {
    const base = this.computeDecayedBase(state, currentTime);
    const context = this.computeDecayedContext(state.context, currentTime);
    const fatigue = EmotionEngine.fatigueResult(state.fatigue);

    if (!context) {
      return {
        base,
        context: null,
        blended: {
          mood: base.mood,
          valence: base.valence,
          energy: base.energy,
        },
        fatigue,
      };
    }

    // Apply Emotional Gravity to both context.valence and blended.valence
    const gravityClampedContextValence = clampValenceByGravity(
      context.valence,
      base.valence,
      this.maxGravityDelta,
    );
    const blendedValence = blendValenceWithGravity(
      base.valence,
      gravityClampedContextValence,
      context.remainingWeight,
      this.contextWeight,
      this.maxGravityDelta,
    );

    // If sleeping, sleep overrides active mood label; otherwise adopt active Context mood
    const blendedMood = state.fatigue.status === "SLEEPING" ? "sleepy" : context.mood;

    return {
      base,
      context: {
        ...context,
        valence: gravityClampedContextValence,
      },
      blended: {
        mood: blendedMood,
        valence: blendedValence,
        energy: base.energy,
      },
      fatigue,
    };
  }

  /**
   * Core read-time computation (`getBlendedEmotion()`):
   * Applies lazy 6h Base decay, lazy 2h shared-Context expiration/decay,
   * Emotional Gravity clamping & weighted blending, and Fatigue-to-Energy constraints.
   */
  getBlendedEmotion(nowOverride?: number): BlendedEmotionResult {
    const currentTime = this.now(nowOverride);
    return this.computeBlend(this.loadState(currentTime), currentTime);
  }

  /**
   * Return global status across Base Mood, the shared Context Mood, and Fatigue.
   */
  getStatus(nowOverride?: number): EmotionSystemStatus {
    const currentTime = this.now(nowOverride);
    const state = this.loadState(currentTime);
    const result = this.computeBlend(state, currentTime);

    return {
      now: currentTime,
      identity: this.identity,
      baseline: { ...state.baseline },
      base: {
        ...result.base,
        raw: { ...state.base },
      },
      context: result.context
        ? { ...result.context, blendedValence: result.blended.valence }
        : null,
      fatigue: result.fatigue,
    };
  }

  /**
   * Update global Base Mood (`emotion_set_base`).
   * Energy is automatically constrained by current Fatigue / Sleep status.
   */
  setBase(
    params: {
      mood: string;
      energy: number;
      valence: number;
      description: string;
    },
    nowOverride?: number,
  ): BlendedEmotionResult {
    const currentTime = this.now(nowOverride);
    return this.transact(currentTime, (state) => {
      const requestedEnergy = round1(clampNumber(params.energy, 0, 10));
      const constrainedEnergy = computeEffectiveEnergy(requestedEnergy, state.fatigue);

      state.base = {
        mood: normalizeText(params.mood, state.baseline.mood),
        energy: constrainedEnergy,
        valence: round1(clampNumber(params.valence, 0, 10)),
        description: normalizeText(params.description, state.baseline.description),
        updatedAt: currentTime,
      };
    });
  }

  /**
   * Update the shared Context Mood (`emotion_set_context`).
   * Applies Emotional Gravity clamping against the current decayed Base Mood
   * valence on write. Visible to every session of this identity for 2h.
   */
  setContext(
    params: {
      mood: string;
      valence: number;
      trigger: string;
    },
    nowOverride?: number,
  ): BlendedEmotionResult {
    const currentTime = this.now(nowOverride);
    return this.transact(currentTime, (state) => {
      const decayedBase = this.computeDecayedBase(state, currentTime);
      const clampedValence = clampValenceByGravity(
        round1(clampNumber(params.valence, 0, 10)),
        decayedBase.valence,
        this.maxGravityDelta,
      );

      state.context = {
        mood: normalizeText(params.mood, "neutral"),
        valence: clampedValence,
        trigger: normalizeText(params.trigger, "conversation shift"),
        updatedAt: currentTime,
      };
    });
  }

  /**
   * Enter sleep state (`sleep()`):
   * - Sets fatigue.status = "SLEEPING"
   * - Synchronously lowers Base Mood energy to <= 1 and updates mood to "sleepy"
   * - Re-sleeping preserves the original sleep start so `wake()` recovery
   *   still counts the full sleep duration.
   */
  sleep(nowOverride?: number): BlendedEmotionResult {
    const currentTime = this.now(nowOverride);
    return this.transact(currentTime, (state) => {
      const alreadySleeping = state.fatigue.status === "SLEEPING";
      if (alreadySleeping && state.base.mood === "sleepy" && state.base.energy <= 1) {
        return false;
      }

      const decayedBase = this.computeDecayedBase(state, currentTime);

      state.fatigue = {
        status: "SLEEPING",
        fatigue: round1(clampNumber(state.fatigue.fatigue, 0, 100)),
        updatedAt: alreadySleeping ? state.fatigue.updatedAt : currentTime,
      };

      state.base = {
        mood: "sleepy",
        energy: round1(Math.min(decayedBase.energy, 1)),
        valence: decayedBase.valence,
        description: "sleeping, drowsy, low responsiveness",
        updatedAt: currentTime,
      };
    });
  }

  /**
   * Wake up from sleep (`wake()`):
   * - No-op while already AWAKE (prevents farming fatigue recovery)
   * - Reduces fatigue based on sleep duration (minimum 40 points recovery)
   * - Synchronously restores Base Mood energy to a moderate waking level bounded by remaining fatigue
   */
  wake(nowOverride?: number): BlendedEmotionResult {
    const currentTime = this.now(nowOverride);
    return this.transact(currentTime, (state) => {
      if (state.fatigue.status !== "SLEEPING") {
        return false;
      }

      const wasSleepyMood = state.base.mood === "sleepy";
      const sleepHours = Math.max(
        0,
        (currentTime - state.fatigue.updatedAt) / (60 * 60 * 1000),
      );

      // Recover at least 40 fatigue points on wake, or more if slept longer (20 pts/hour)
      const recovery = Math.max(40, round1(sleepHours * 20));
      state.fatigue = {
        status: "AWAKE",
        fatigue: round1(clampNumber(state.fatigue.fatigue - recovery, 0, 100)),
        updatedAt: currentTime,
      };

      // Compute decay under the new AWAKE status so energy isn't sleep-capped
      // and a fully decayed mood reverts to the baseline rather than "sleepy".
      const decayedBase = this.computeDecayedBase(state, currentTime);
      const energyCap = computeEnergyCapFromFatigue(state.fatigue);
      const targetWakeEnergy = Math.max(
        decayedBase.energy,
        Math.min(state.baseline.energy, 6),
      );

      state.base = {
        mood: wasSleepyMood ? state.baseline.mood : decayedBase.mood,
        energy: round1(clampNumber(targetWakeEnergy, 0, energyCap)),
        valence: decayedBase.valence,
        description: wasSleepyMood
          ? `just woke up, ${state.baseline.description}`
          : decayedBase.description,
        updatedAt: currentTime,
      };
    });
  }

  /**
   * Full recovery (`rest()`):
   * - Resets fatigue to 0 and status to "AWAKE"
   * - Synchronously boosts Base Mood energy (at least max(baseline.energy, 8))
   */
  rest(nowOverride?: number): BlendedEmotionResult {
    const currentTime = this.now(nowOverride);
    return this.transact(currentTime, (state) => {
      const wasSleepyMood = state.base.mood === "sleepy";

      state.fatigue = {
        status: "AWAKE",
        fatigue: 0,
        updatedAt: currentTime,
      };

      // Compute decay under the new AWAKE status (see wake() for why).
      const decayedBase = this.computeDecayedBase(state, currentTime);
      const boostedEnergy = round1(
        clampNumber(Math.max(decayedBase.energy, state.baseline.energy, 8), 0, 10),
      );

      state.base = {
        mood: wasSleepyMood ? state.baseline.mood : decayedBase.mood,
        energy: boostedEnergy,
        valence: round1(Math.max(decayedBase.valence, state.baseline.valence)),
        description: wasSleepyMood
          ? state.baseline.description
          : decayedBase.description,
        updatedAt: currentTime,
      };
    });
  }

  /**
   * Query current fatigue state (`fatigue_status()`).
   */
  getFatigueStatus(nowOverride?: number): BlendedEmotionResult["fatigue"] {
    const currentTime = this.now(nowOverride);
    const state = this.storage.load(currentTime);
    return EmotionEngine.fatigueResult(state.fatigue);
  }

  /**
   * Set fatigue value (0–100) and synchronize Base Mood energy ceiling.
   */
  setFatigue(
    fatigueValue: number,
    nowOverride?: number,
  ): BlendedEmotionResult {
    const currentTime = this.now(nowOverride);
    return this.transact(currentTime, (state) => {
      state.fatigue = {
        status: state.fatigue.status,
        fatigue: round1(clampNumber(fatigueValue, 0, 100)),
        // Preserve the sleep-start timestamp while SLEEPING (mirrors sleep())
        // so wake() still counts the full sleep duration.
        updatedAt:
          state.fatigue.status === "SLEEPING"
            ? state.fatigue.updatedAt
            : currentTime,
      };

      // Clamp persisted base energy down to the new fatigue ceiling without
      // perturbing mood, valence, description, or the 6h decay timer.
      const energyCap = computeEnergyCapFromFatigue(state.fatigue);
      if (state.base.energy > energyCap) {
        state.base = {
          ...state.base,
          energy: energyCap,
        };
      }
    });
  }

  /**
   * Update configurable Default Personality Baseline.
   */
  setBaseline(
    baseline: Partial<PersonalityBaseline>,
    nowOverride?: number,
  ): PersonalityBaseline {
    const currentTime = this.now(nowOverride);
    const state = this.loadState(currentTime);

    state.baseline = {
      mood: normalizeText(baseline.mood, state.baseline.mood),
      energy: normalizeNumber(baseline.energy, state.baseline.energy, 0, 10),
      valence: normalizeNumber(baseline.valence, state.baseline.valence, 0, 10),
      description: normalizeText(baseline.description, state.baseline.description),
    };

    this.storage.save(state);
    return { ...state.baseline };
  }
}
