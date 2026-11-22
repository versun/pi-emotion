import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  BaseMoodState,
  ContextMoodState,
  EmotionPersistedState,
  FatigueState,
  PersonalityBaseline,
} from "./types.ts";

export const DEFAULT_BASELINE: PersonalityBaseline = {
  mood: "cheerful",
  energy: 7,
  valence: 7,
  description: "curious, slightly sassy, warm",
};

export function resolveDefaultStoragePath(): string {
  return resolveStoragePath();
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the current user identity for multi-user isolation.
 * Priority: explicit option > PI_EMOTION_USER env > OS username > "default".
 *
 * Intended for shared machines / shared OS accounts where several people
 * use the same Pi install: each person sets PI_EMOTION_USER (or has a
 * distinct OS login) and gets a private state file.
 */
export function resolveIdentity(explicit?: string): string {
  return (
    nonEmpty(explicit) ??
    nonEmpty(process.env.PI_EMOTION_USER) ??
    nonEmpty(osUsername()) ??
    "default"
  );
}

function osUsername(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return undefined;
  }
}

/**
 * Whether an identity maps to a private per-user state file rather than
 * the shared default file (i.e. it is neither "default" nor the OS login).
 */
export function isCustomIdentity(identity: string): boolean {
  const trimmed = nonEmpty(identity);
  return !!trimmed && trimmed !== "default" && trimmed !== osUsername();
}

/**
 * Resolve the state file path for a given user identity.
 *
 * Precedence:
 * 1. `PI_EMOTION_STATE_PATH` env var (explicit file override)
 * 2. Custom identity (e.g. `PI_EMOTION_USER`) -> `<PI_EMOTION_STATE_DIR or ~/.pi/agent/emotion-state>/users/<identity>.json`
 * 3. Default / OS login -> `~/.pi/agent/emotion-state.json`
 */
export function resolveStoragePath(identity?: string): string {
  const envPath = nonEmpty(process.env.PI_EMOTION_STATE_PATH);
  if (envPath) {
    return path.resolve(envPath);
  }

  const trimmed = nonEmpty(identity);
  if (trimmed && isCustomIdentity(trimmed)) {
    const dir =
      nonEmpty(process.env.PI_EMOTION_STATE_DIR) ??
      path.join(os.homedir(), ".pi", "agent", "emotion-state");
    return path.join(dir, "users", `${sanitizeIdentity(trimmed)}.json`);
  }

  return path.join(os.homedir(), ".pi", "agent", "emotion-state.json");
}

function sanitizeIdentity(identity: string): string {
  return (
    identity.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "") || "default"
  );
}

export function clampNumber(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.min(max, Math.max(min, val));
}

export function round1(val: number): number {
  return Math.round(val * 10) / 10 || 0;
}

export function round2(val: number): number {
  return Math.round(val * 100) / 100 || 0;
}

export function round3(val: number): number {
  return Math.round(val * 1000) / 1000 || 0;
}

const LOCK_STALE_MS = 2_000;
const LOCK_TIMEOUT_MS = 3_000;
const LOCK_RETRY_BASE_MS = 5;
const LOCK_SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(LOCK_SLEEP_ARRAY, 0, 0, Math.max(1, ms));
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function normalizeText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

export function normalizeNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  return isFiniteNum(value) ? round1(clampNumber(value, min, max)) : fallback;
}

function normalizeFatigueValue(value: unknown, fallback: number): number {
  return isFiniteNum(value) ? round3(clampNumber(value, 0, 100)) : fallback;
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  return isFiniteNum(value) ? value : fallback;
}

export function normalizeBaseline(
  raw: Partial<PersonalityBaseline> | undefined,
  fallback: PersonalityBaseline,
): PersonalityBaseline {
  return {
    mood: normalizeText(raw?.mood, fallback.mood),
    energy: normalizeNumber(raw?.energy, fallback.energy, 0, 10),
    valence: normalizeNumber(raw?.valence, fallback.valence, 0, 10),
    description: normalizeText(raw?.description, fallback.description),
  };
}

export function createInitialState(
  baselineOverrides?: Partial<PersonalityBaseline>,
  now: number = Date.now(),
): EmotionPersistedState {
  const baseline = normalizeBaseline(baselineOverrides, DEFAULT_BASELINE);

  const base: BaseMoodState = {
    ...baseline,
    updatedAt: now,
  };

  const fatigue: FatigueState = {
    fatigue: 0,
    updatedAt: now,
  };

  return {
    version: 1,
    baseline,
    base,
    context: null,
    fatigue,
  };
}

export class EmotionStorage {
  readonly filePath: string;
  private readonly defaultBaseline: PersonalityBaseline;
  private lockDepth = 0;

  constructor(filePath?: string, defaultBaseline?: Partial<PersonalityBaseline>) {
    this.filePath = filePath ? path.resolve(filePath) : resolveDefaultStoragePath();
    this.defaultBaseline = normalizeBaseline(defaultBaseline, DEFAULT_BASELINE);
  }

  /**
   * Execute `fn` under a re-entrant cross-process lockfile (`<filePath>.lock`)
   * to prevent lost updates across concurrent sessions / subagents.
   */
  withLock<T>(fn: () => T): T {
    if (this.lockDepth > 0) {
      this.lockDepth += 1;
      try {
        return fn();
      } finally {
        this.lockDepth -= 1;
      }
    }

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    const token = `${process.pid}:${crypto.randomBytes(6).toString("hex")}:${Date.now()}`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    let acquired = false;
    while (!acquired) {
      try {
        fs.writeFileSync(lockPath, token, { flag: "wx", encoding: "utf8" });
        acquired = true;
        break;
      } catch (err) {
        if (!isErrnoCode(err, "EEXIST")) {
          throw err;
        }
      }

      // Reclaim abandoned lock files left by crashed processes
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs >= LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch (err) {
        if (isErrnoCode(err, "ENOENT")) {
          continue;
        }
      }

      if (Date.now() >= deadline) {
        break;
      }

      sleepSync(LOCK_RETRY_BASE_MS + Math.floor(Math.random() * 10));
    }

    this.lockDepth += 1;
    try {
      return fn();
    } finally {
      this.lockDepth -= 1;
      if (acquired) {
        try {
          if (fs.readFileSync(lockPath, "utf8") === token) {
            fs.rmSync(lockPath, { force: true });
          }
        } catch {
          // Ignore if already removed
        }
      }
    }
  }

  private tryReadNormalized(now: number): EmotionPersistedState | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return null;
      throw err;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      throw new Error("Invalid persisted emotion state root");
    }
    return this.normalizeState(parsed as Partial<EmotionPersistedState>, now);
  }

  load(now: number = Date.now()): EmotionPersistedState {
    try {
      const existing = this.tryReadNormalized(now);
      if (existing) {
        return existing;
      }
    } catch {
      // Fall through to locked recovery below
    }

    return this.withLock(() => {
      try {
        const rechecked = this.tryReadNormalized(now);
        if (rechecked) {
          return rechecked;
        }
      } catch {
        // Still corrupted under lock: overwrite with a fresh initial state
      }
      const initial = createInitialState(this.defaultBaseline, now);
      this.save(initial);
      return initial;
    });
  }

  save(state: EmotionPersistedState): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const nonce = crypto.randomBytes(6).toString("hex");
    const tempPath = `${this.filePath}.${process.pid}.${nonce}.tmp`;
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // Ignore cleanup failure
      }
      throw err;
    }
  }

  private normalizeState(
    parsed: Partial<EmotionPersistedState>,
    now: number,
  ): EmotionPersistedState {
    const baseline = normalizeBaseline(parsed.baseline, this.defaultBaseline);

    const base: BaseMoodState = {
      mood: normalizeText(parsed.base?.mood, baseline.mood),
      energy: normalizeNumber(parsed.base?.energy, baseline.energy, 0, 10),
      valence: normalizeNumber(parsed.base?.valence, baseline.valence, 0, 10),
      description: normalizeText(parsed.base?.description, baseline.description),
      updatedAt: normalizeTimestamp(parsed.base?.updatedAt, now),
    };

    const context: ContextMoodState | null = normalizeContext(
      parsed.context ?? (parsed as { contexts?: unknown }).contexts,
      now,
    );

    // Legacy files may include a `status` ("AWAKE" | "SLEEPING") field; drop it
    // cleanly while preserving the recorded fatigue level and timestamp.
    const fatigue: FatigueState = {
      fatigue: normalizeFatigueValue(parsed.fatigue?.fatigue, 0),
      updatedAt: normalizeTimestamp(parsed.fatigue?.updatedAt, now),
    };

    return {
      version: 1,
      baseline,
      base,
      context,
      fatigue,
    };
  }
}

/**
 * Normalize whatever context shape is on disk to the current shared
 * single-context model. Migrates the legacy per-chatId `contexts` map by
 * keeping the most recently updated entry.
 */
function normalizeContext(
  raw: unknown,
  now: number,
): ContextMoodState | null {
  if (!isPlainObject(raw)) return null;

  let candidate: Record<string, unknown>;

  // Legacy migration: a map of chatId -> ContextMoodState.
  // Keep the freshest entry as the shared context.
  if (!("mood" in raw)) {
    const entries = Object.values(raw).filter(
      (c): c is Record<string, unknown> => isPlainObject(c) && "mood" in c,
    );
    if (entries.length === 0) return null;
    candidate = entries.reduce((best, item) => {
      const bestTime = isFiniteNum(best.updatedAt) ? best.updatedAt : -Infinity;
      const itemTime = isFiniteNum(item.updatedAt) ? item.updatedAt : -Infinity;
      return itemTime > bestTime ? item : best;
    });
  } else {
    candidate = raw;
  }

  return {
    mood: normalizeText(candidate.mood, "neutral"),
    valence: normalizeNumber(candidate.valence, 5, 0, 10),
    trigger: typeof candidate.trigger === "string" ? candidate.trigger.trim() : "",
    updatedAt: normalizeTimestamp(candidate.updatedAt, now),
  };
}
