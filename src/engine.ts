import {
  clamp,
  EmotionStorage,
  finiteOr,
  normalizeBaseline,
  normalizeText,
  resolveIdentity,
  resolveStoragePath,
  round,
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
  WorkloadInput,
} from "./types.ts";

/** 6 hours in milliseconds */
export const BASE_DECAY_MS = 6 * 60 * 60 * 1000;

/** 2 hours in milliseconds */
export const CONTEXT_DECAY_MS = 2 * 60 * 60 * 1000;

/** Maximum immediate offset a Context Mood can have from current Base Mood valence */
export const DEFAULT_MAX_GRAVITY_DELTA = 4.0;

/** Default pull weight of a fresh Context Mood against Base Mood at t=0 */
export const DEFAULT_CONTEXT_WEIGHT = 0.65;

/** Default passive idle fatigue recovery rate (points per hour) */
export const DEFAULT_FATIGUE_RECOVERY_PER_HOUR = 15;

/** Default fatigue added per completed agent turn */
export const DEFAULT_FATIGUE_PER_TURN = 0.2;

/** Default additional fatigue per non-passive tool call */
export const DEFAULT_FATIGUE_PER_TOOL_CALL = 0.05;

/** Default additional fatigue per failed tool call */
export const DEFAULT_FATIGUE_PER_TOOL_ERROR = 0.1;

/** Default cap on fatigue added by a single workload event */
export const DEFAULT_MAX_FATIGUE_PER_TURN = 1.2;

/** Fatigue threshold above which exhaustion begins weighing down blended valence */
export const DEFAULT_HIGH_FATIGUE_VALENCE_THRESHOLD = 60;

/** Maximum valence drag applied at 100 fatigue */
export const DEFAULT_MAX_FATIGUE_VALENCE_PENALTY = 1.5;

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
  const linear = clamp(elapsedMs / windowMs, 0, 1);
  if (linear >= 1) return 1;
  if (linear <= 0) return 0;

  if (curve === "exponential") {
    const k = 3;
    return (1 - Math.exp(-k * linear)) / (1 - Math.exp(-k));
  }
  return linear;
}

function computeRawRecoveredFatigue(
  rawFatigue: number,
  elapsedMs: number,
  recoveryPerHour: number = DEFAULT_FATIGUE_RECOVERY_PER_HOUR,
): number {
  const start = clamp(rawFatigue, 0, 100);
  if (start <= 0 || !(elapsedMs > 0) || !(recoveryPerHour > 0)) {
    return start;
  }
  const elapsedHours = elapsedMs / (60 * 60 * 1000);
  return clamp(start - elapsedHours * recoveryPerHour, 0, 100);
}

/**
 * Compute lazily recovered fatigue [0, 100] after `elapsedMs` of idle time.
 */
export function computeRecoveredFatigue(
  rawFatigue: number,
  elapsedMs: number,
  recoveryPerHour: number = DEFAULT_FATIGUE_RECOVERY_PER_HOUR,
): number {
  return round(computeRawRecoveredFatigue(rawFatigue, elapsedMs, recoveryPerHour), 1);
}

/**
 * Compute maximum sustainable energy (0–10) allowed by current Fatigue.
 * Linearly scales from 10.0 (at fatigue 0) down to 1.0 (at fatigue 100).
 */
export function computeEnergyCapFromFatigue(fatigueValue: number): number {
  const f = clamp(fatigueValue, 0, 100);
  return round(10 - (f / 100) * 9, 1);
}

/**
 * Compute valence drag caused by high fatigue (returns unrounded penalty >= 0).
 * Below `threshold`, fatigue does not weigh on valence; above `threshold`,
 * it scales linearly up to `maxPenalty` at fatigue = 100.
 */
export function computeFatigueValencePenalty(
  fatigueValue: number,
  threshold: number = DEFAULT_HIGH_FATIGUE_VALENCE_THRESHOLD,
  maxPenalty: number = DEFAULT_MAX_FATIGUE_VALENCE_PENALTY,
): number {
  const f = clamp(fatigueValue, 0, 100);
  const t = clamp(threshold, 0, 100);
  const penalty = Math.max(0, maxPenalty);
  if (t >= 100 || f <= t || penalty <= 0) return 0;
  return ((f - t) / (100 - t)) * penalty;
}

/**
 * Emotional Gravity Clamping Function:
 * Anchors a target Context valence around the active Base valence within `[-maxDelta, +maxDelta]`,
 * preventing extreme single-turn mood whiplash (e.g., jumping from valence 1 to 10 on one compliment).
 */
export function clampValenceByGravity(
  targetValence: number,
  baseValence: number,
  maxDelta: number = DEFAULT_MAX_GRAVITY_DELTA,
): number {
  const clampedBase = clamp(baseValence, 0, 10);
  const delta = Math.max(0, maxDelta);
  return round(
    clamp(
      targetValence,
      Math.max(0, clampedBase - delta),
      Math.min(10, clampedBase + delta),
    ),
    1,
  );
}

export class EmotionEngine {
  readonly storage: EmotionStorage;
  readonly identity: string;
  readonly baseDecayMs: number;
  readonly contextDecayMs: number;
  readonly maxGravityDelta: number;
  readonly contextWeight: number;
  readonly decayCurve: DecayCurve;
  readonly fatigueRecoveryPerHour: number;
  readonly fatiguePerTurn: number;
  readonly fatiguePerToolCall: number;
  readonly fatiguePerToolError: number;
  readonly maxFatiguePerTurn: number;
  readonly highFatigueValenceThreshold: number;
  readonly maxFatigueValencePenalty: number;
  private readonly clock: () => number;

  constructor(options: EmotionEngineOptions = {}) {
    this.identity = resolveIdentity(options.identity);
    const storagePath =
      options.storagePath ?? resolveStoragePath(this.identity);
    this.storage = new EmotionStorage(storagePath, options.baseline);
    this.baseDecayMs = finiteOr(options.baseDecayMs, BASE_DECAY_MS, 0);
    this.contextDecayMs = finiteOr(options.contextDecayMs, CONTEXT_DECAY_MS, 0);
    this.maxGravityDelta = finiteOr(
      options.maxGravityDelta,
      DEFAULT_MAX_GRAVITY_DELTA,
      0,
      10,
    );
    this.contextWeight = finiteOr(
      options.contextWeight,
      DEFAULT_CONTEXT_WEIGHT,
      0,
      1,
    );
    this.decayCurve = options.decayCurve === "exponential" ? "exponential" : "linear";
    this.fatigueRecoveryPerHour = finiteOr(
      options.fatigueRecoveryPerHour,
      DEFAULT_FATIGUE_RECOVERY_PER_HOUR,
      0,
    );
    this.fatiguePerTurn = finiteOr(options.fatiguePerTurn, DEFAULT_FATIGUE_PER_TURN, 0);
    this.fatiguePerToolCall = finiteOr(
      options.fatiguePerToolCall,
      DEFAULT_FATIGUE_PER_TOOL_CALL,
      0,
    );
    this.fatiguePerToolError = finiteOr(
      options.fatiguePerToolError,
      DEFAULT_FATIGUE_PER_TOOL_ERROR,
      0,
    );
    this.maxFatiguePerTurn = finiteOr(
      options.maxFatiguePerTurn,
      DEFAULT_MAX_FATIGUE_PER_TURN,
      0,
      100,
    );
    this.highFatigueValenceThreshold = finiteOr(
      options.highFatigueValenceThreshold,
      DEFAULT_HIGH_FATIGUE_VALENCE_THRESHOLD,
      0,
      100,
    );
    this.maxFatigueValencePenalty = finiteOr(
      options.maxFatigueValencePenalty,
      DEFAULT_MAX_FATIGUE_VALENCE_PENALTY,
      0,
      10,
    );
    this.clock = options.now ?? (() => Date.now());
  }

  private now(nowOverride?: number): number {
    return typeof nowOverride === "number" && Number.isFinite(nowOverride)
      ? nowOverride
      : this.clock();
  }

  private isContextExpired(ctx: ContextMoodState, currentTime: number): boolean {
    return Math.max(0, currentTime - ctx.updatedAt) >= this.contextDecayMs;
  }

  private pruneExpiredContext(
    state: EmotionPersistedState,
    currentTime: number,
  ): boolean {
    if (state.context && this.isContextExpired(state.context, currentTime)) {
      state.context = null;
      return true;
    }
    return false;
  }

  /**
   * Load persisted state, lazily pruning an expired shared Context Mood on disk
   * under the storage lock so concurrent writes are never clobbered.
   */
  private loadState(currentTime: number): EmotionPersistedState {
    const state = this.storage.load(currentTime);
    if (state.context && this.isContextExpired(state.context, currentTime)) {
      return this.storage.withLock(() => {
        const fresh = this.storage.load(currentTime);
        if (this.pruneExpiredContext(fresh, currentTime)) {
          this.storage.save(fresh);
        }
        return fresh;
      });
    }
    return state;
  }

  /**
   * Atomically load state under a cross-process lock, prune expired context,
   * run a mutator, and persist the updated state.
   */
  private withMutableState<T>(
    currentTime: number,
    fn: (state: EmotionPersistedState) => T,
  ): T {
    return this.storage.withLock(() => {
      const state = this.storage.load(currentTime);
      this.pruneExpiredContext(state, currentTime);
      const result = fn(state);
      this.storage.save(state);
      return result;
    });
  }

  private transact(
    currentTime: number,
    mutate: (state: EmotionPersistedState) => void,
  ): BlendedEmotionResult {
    return this.withMutableState(currentTime, (state) => {
      mutate(state);
      return this.computeBlend(state, currentTime);
    });
  }

  /**
   * Compute lazily recovered fatigue and derived energy cap at `currentTime`.
   */
  private computeEffectiveFatigue(
    fatigue: FatigueState,
    currentTime: number,
  ): BlendedEmotionResult["fatigue"] {
    const elapsed = Math.max(0, currentTime - fatigue.updatedAt);
    const value = computeRecoveredFatigue(
      fatigue.fatigue,
      elapsed,
      this.fatigueRecoveryPerHour,
    );
    return {
      value,
      energyCap: computeEnergyCapFromFatigue(value),
      updatedAt: fatigue.updatedAt,
    };
  }

  /**
   * Compute lazily decayed Base Mood values before applying the fatigue energy cap.
   */
  private computeDecayedBase(
    state: EmotionPersistedState,
    currentTime: number,
  ): BlendedEmotionResult["base"] {
    const { base, baseline } = state;
    const elapsed = Math.max(0, currentTime - base.updatedAt);
    // Keep the unrounded factor for the boundary comparison: rounding first
    // would trigger full revert up to ~40min early under the exponential curve.
    const decayFactor = computeDecayFactor(
      elapsed,
      this.baseDecayMs,
      this.decayCurve,
    );

    if (decayFactor >= 1) {
      return {
        mood: baseline.mood,
        valence: baseline.valence,
        energy: baseline.energy,
        description: baseline.description,
        updatedAt: base.updatedAt,
        decayProgress: 1,
      };
    }

    return {
      mood: base.mood,
      valence: round(base.valence + (baseline.valence - base.valence) * decayFactor, 1),
      energy: round(base.energy + (baseline.energy - base.energy) * decayFactor, 1),
      description: base.description,
      updatedAt: base.updatedAt,
      decayProgress: round(decayFactor, 2),
    };
  }

  /**
   * Compute decayed shared Context Mood at `currentTime`, along with its
   * unrounded remaining weight factor for accurate valence blending.
   */
  private computeDecayedContext(
    ctx: ContextMoodState | null,
    currentTime: number,
  ): {
    context: NonNullable<BlendedEmotionResult["context"]>;
    remainingFactor: number;
  } | null {
    if (!ctx) return null;

    const elapsed = Math.max(0, currentTime - ctx.updatedAt);
    const remainingFactor =
      1 - computeDecayFactor(elapsed, this.contextDecayMs, this.decayCurve);
    if (remainingFactor <= 0) return null;

    return {
      remainingFactor,
      context: {
        mood: ctx.mood,
        valence: ctx.valence,
        trigger: ctx.trigger,
        updatedAt: ctx.updatedAt,
        remainingWeight: round(remainingFactor, 2),
      },
    };
  }

  /**
   * Compute the blended emotion snapshot for an already-loaded state:
   * lazy idle Fatigue recovery, lazy Base decay, shared-Context expiration/decay,
   * Emotional Gravity clamping & weighted blending, Fatigue-to-Energy cap,
   * and high-fatigue valence drag.
   */
  private computeBlend(
    state: EmotionPersistedState,
    currentTime: number,
  ): BlendedEmotionResult {
    const fatigue = this.computeEffectiveFatigue(state.fatigue, currentTime);
    const rawBase = this.computeDecayedBase(state, currentTime);
    const base: BlendedEmotionResult["base"] = {
      ...rawBase,
      energy: Math.min(rawBase.energy, fatigue.energyCap),
    };
    const decayedCtx = this.computeDecayedContext(state.context, currentTime);
    const valencePenalty = computeFatigueValencePenalty(
      fatigue.value,
      this.highFatigueValenceThreshold,
      this.maxFatigueValencePenalty,
    );

    let context: BlendedEmotionResult["context"] = null;
    let blendedMood = base.mood;
    let rawValence = base.valence;

    if (decayedCtx) {
      const clampedContext = clampValenceByGravity(
        decayedCtx.context.valence,
        base.valence,
        this.maxGravityDelta,
      );
      const weight = this.contextWeight * decayedCtx.remainingFactor;
      rawValence = base.valence * (1 - weight) + clampedContext * weight;
      blendedMood = decayedCtx.context.mood;
      context = {
        ...decayedCtx.context,
        valence: clampedContext,
      };
    }

    return {
      base,
      context,
      blended: {
        mood: blendedMood,
        valence: round(clamp(rawValence - valencePenalty, 0, 10), 1),
        energy: base.energy,
      },
      fatigue,
    };
  }

  /**
   * Core read-time computation (`getBlendedEmotion()`).
   */
  getBlendedEmotion(nowOverride?: number): BlendedEmotionResult {
    const currentTime = this.now(nowOverride);
    return this.computeBlend(this.loadState(currentTime), currentTime);
  }

  /**
   * Return global status across Base Mood, shared Context Mood, Blended state, and Fatigue.
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
      context: result.context,
      blended: result.blended,
      fatigue: {
        ...result.fatigue,
        raw: { ...state.fatigue },
      },
    };
  }

  /**
   * Update global Base Mood (`emotion_set_base`).
   * Raw energy is stored intact while effective energy is dynamically capped by
   * current recovered Fatigue on read, allowing energy to rebound as fatigue clears.
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
      const decayed = this.computeDecayedBase(state, currentTime);
      state.base = {
        mood: normalizeText(params.mood, decayed.mood),
        energy: round(finiteOr(params.energy, decayed.energy, 0, 10), 1),
        valence: round(finiteOr(params.valence, decayed.valence, 0, 10), 1),
        description: normalizeText(params.description, decayed.description),
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
      const decayed = this.computeDecayedBase(state, currentTime);
      const rawValence = round(finiteOr(params.valence, decayed.valence, 0, 10), 1);

      state.context = {
        mood: normalizeText(params.mood, "neutral"),
        valence: clampValenceByGravity(
          rawValence,
          decayed.valence,
          this.maxGravityDelta,
        ),
        trigger: normalizeText(params.trigger, "conversation shift"),
        updatedAt: currentTime,
      };
    });
  }

  /**
   * Accumulate workload fatigue after a completed turn / tool batch.
   * First applies unrounded lazy idle recovery up to `currentTime` so rest
   * between turns is never lost or double-rounded, then adds capped workload fatigue.
   */
  recordWorkload(
    workload: WorkloadInput = {},
    nowOverride?: number,
  ): BlendedEmotionResult {
    const currentTime = this.now(nowOverride);

    const turns = finiteOr(workload.turns, 1, 0);
    const toolCalls = finiteOr(workload.toolCalls, 0, 0);
    const toolErrors = finiteOr(workload.toolErrors, 0, 0);
    const delta =
      workload.fatigueDelta !== undefined
        ? finiteOr(workload.fatigueDelta, 0, 0, 100)
        : Math.min(
            100,
            this.maxFatiguePerTurn * Math.max(1, turns),
            turns * this.fatiguePerTurn +
              toolCalls * this.fatiguePerToolCall +
              toolErrors * this.fatiguePerToolError,
          );

    if (delta <= 0) {
      return this.getBlendedEmotion(currentTime);
    }

    return this.transact(currentTime, (state) => {
      const elapsed = Math.max(0, currentTime - state.fatigue.updatedAt);
      const recoveredRaw = computeRawRecoveredFatigue(
        state.fatigue.fatigue,
        elapsed,
        this.fatigueRecoveryPerHour,
      );
      state.fatigue = {
        fatigue: round(clamp(recoveredRaw + delta, 0, 100), 3),
        updatedAt: currentTime,
      };
    });
  }

  /**
   * Full recovery (`rest()`):
   * - Resets fatigue to 0
   * - Boosts Base Mood energy (at least max(baseline.energy, 8)) and restores
   *   valence to at least baseline.valence
   */
  rest(nowOverride?: number): BlendedEmotionResult {
    const currentTime = this.now(nowOverride);
    return this.transact(currentTime, (state) => {
      const decayed = this.computeDecayedBase(state, currentTime);
      state.fatigue = { fatigue: 0, updatedAt: currentTime };
      state.base = {
        mood: decayed.mood,
        energy: Math.max(decayed.energy, state.baseline.energy, 8),
        valence: Math.max(decayed.valence, state.baseline.valence),
        description: decayed.description,
        updatedAt: currentTime,
      };
    });
  }

  /**
   * Set fatigue value (0–100) directly. Ignores non-finite inputs.
   * Persisted Base Mood energy is left intact because `computeBlend()`
   * applies the fatigue energy cap dynamically, allowing energy to rebound
   * naturally as fatigue recovers over idle time.
   */
  setFatigue(
    fatigueValue: number,
    nowOverride?: number,
  ): BlendedEmotionResult {
    const currentTime = this.now(nowOverride);
    if (!Number.isFinite(fatigueValue)) {
      return this.getBlendedEmotion(currentTime);
    }
    return this.transact(currentTime, (state) => {
      state.fatigue = {
        fatigue: round(clamp(fatigueValue, 0, 100), 3),
        updatedAt: currentTime,
      };
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
    return this.withMutableState(currentTime, (state) => {
      state.baseline = normalizeBaseline(baseline, state.baseline);
      return { ...state.baseline };
    });
  }
}
