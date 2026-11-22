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

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

const OS_USERNAME: string | undefined = (() => {
  try {
    return nonEmpty(os.userInfo().username);
  } catch {
    return undefined;
  }
})();

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
    OS_USERNAME ??
    "default"
  );
}

/**
 * Whether an identity is a custom persona (neither "default" nor the OS login),
 * used to decide whether the TUI status badge includes a persona prefix.
 */
export function isCustomIdentity(identity: string): boolean {
  const trimmed = nonEmpty(identity);
  return !!trimmed && trimmed !== "default" && trimmed !== OS_USERNAME;
}

/**
 * Resolve the state file path for a given user identity.
 *
 * Precedence:
 * 1. `PI_EMOTION_STATE_PATH` env var (explicit file override)
 * 2. `<PI_EMOTION_STATE_DIR or ~/.pi/agent/emotion-state>/<identity>.json`
 */
export function resolveStoragePath(identity?: string): string {
  const envPath = nonEmpty(process.env.PI_EMOTION_STATE_PATH);
  if (envPath) {
    return path.resolve(envPath);
  }

  const dir =
    nonEmpty(process.env.PI_EMOTION_STATE_DIR) ??
    path.join(os.homedir(), ".pi", "agent", "emotion-state");
  const id = resolveIdentity(identity);
  return path.resolve(dir, `${sanitizeIdentity(id)}.json`);
}

function sanitizeIdentity(identity: string): string {
  const cleaned = identity
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_")
    .replace(/^\.+/, "");
  if (cleaned === identity && cleaned.length > 0) {
    return cleaned;
  }
  const hash8 = crypto
    .createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 8);
  return `${cleaned || "default"}-${hash8}`;
}

export function clamp(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.min(max, Math.max(min, val));
}

export function round(val: number, decimals: number = 1): number {
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor || 0;
}

export function finiteOr(
  value: unknown,
  fallback: number,
  min: number = Number.NEGATIVE_INFINITY,
  max: number = Number.POSITIVE_INFINITY,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

const RECLAIM_STALE_MS = 2_000;
const LOCK_STALE_MS = 4_000;
const LOCK_TIMEOUT_MS = 7_000;
const LOCK_RETRY_BASE_MS = 5;
const LOCK_SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(LOCK_SLEEP_ARRAY, 0, 0, Math.max(1, ms));
}

function releaseLockFile(filePath: string, token: string): void {
  try {
    if (fs.readFileSync(filePath, "utf8") === token) {
      fs.rmSync(filePath, { force: true });
    }
  } catch {
    // Ignore if already removed or unreadable
  }
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

export function normalizeBaseline(
  raw: Partial<PersonalityBaseline> | undefined,
  fallback: PersonalityBaseline,
): PersonalityBaseline {
  return {
    mood: normalizeText(raw?.mood, fallback.mood),
    energy: round(finiteOr(raw?.energy, fallback.energy, 0, 10), 1),
    valence: round(finiteOr(raw?.valence, fallback.valence, 0, 10), 1),
    description: normalizeText(raw?.description, fallback.description),
  };
}

function createInitialState(
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
    this.filePath = filePath
      ? path.resolve(filePath)
      : resolveStoragePath();
    this.defaultBaseline = normalizeBaseline(defaultBaseline, DEFAULT_BASELINE);
  }

  /**
   * Serialize stale-lock reclamation with a short-lived `.reclaim` guard so
   * concurrent contenders cannot unlink a lock freshly acquired by another process.
   * Returns `true` when the lock is gone (reclaimed or already released) and the
   * caller should retry immediately.
   */
  private tryReclaimStaleLock(lockPath: string): boolean {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(lockPath);
    } catch (err) {
      return isErrnoCode(err, "ENOENT");
    }

    if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) {
      return false;
    }

    const reclaimPath = `${lockPath}.reclaim`;
    const reclaimToken = `${process.pid}:${crypto.randomBytes(6).toString("hex")}:${Date.now()}`;
    let removed = false;
    try {
      fs.writeFileSync(reclaimPath, reclaimToken, {
        flag: "wx",
        encoding: "utf8",
      });
      try {
        const currentStat = fs.statSync(lockPath);
        if (Date.now() - currentStat.mtimeMs >= LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          removed = true;
        }
      } catch (err) {
        if (isErrnoCode(err, "ENOENT")) {
          removed = true;
        }
      } finally {
        releaseLockFile(reclaimPath, reclaimToken);
      }
    } catch (err) {
      if (isErrnoCode(err, "EEXIST")) {
        try {
          const reclaimStat = fs.statSync(reclaimPath);
          if (Date.now() - reclaimStat.mtimeMs >= RECLAIM_STALE_MS) {
            fs.rmSync(reclaimPath, { force: true });
          }
        } catch {
          // Ignore if already removed
        }
      }
    }

    return removed;
  }

  /**
   * Execute `fn` under a re-entrant cross-process lockfile (`<filePath>.lock`)
   * to prevent lost updates across concurrent sessions / subagents.
   */
  withLock<T>(fn: () => T, timeoutMs: number = LOCK_TIMEOUT_MS): T {
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
    const deadline = Date.now() + timeoutMs;

    while (true) {
      try {
        fs.writeFileSync(lockPath, token, { flag: "wx", encoding: "utf8" });
        break;
      } catch (err) {
        if (!isErrnoCode(err, "EEXIST")) {
          throw err;
        }
      }

      const retryNow = this.tryReclaimStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring emotion state lock: ${lockPath}`);
      }

      if (!retryNow) {
        sleepSync(LOCK_RETRY_BASE_MS + Math.floor(Math.random() * 10));
      }
    }

    this.lockDepth += 1;
    try {
      return fn();
    } finally {
      this.lockDepth -= 1;
      releaseLockFile(lockPath, token);
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    if (!isPlainObject(parsed)) {
      return null;
    }

    return this.normalizeState(parsed as Partial<EmotionPersistedState>, now);
  }

  load(now: number = Date.now()): EmotionPersistedState {
    const existing = this.tryReadNormalized(now);
    if (existing) {
      return existing;
    }

    return this.withLock(() => {
      const rechecked = this.tryReadNormalized(now);
      if (rechecked) {
        return rechecked;
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
      energy: round(finiteOr(parsed.base?.energy, baseline.energy, 0, 10), 1),
      valence: round(finiteOr(parsed.base?.valence, baseline.valence, 0, 10), 1),
      description: normalizeText(parsed.base?.description, baseline.description),
      updatedAt: finiteOr(parsed.base?.updatedAt, now),
    };

    const context: ContextMoodState | null = normalizeContext(
      parsed.context,
      now,
    );

    const fatigue: FatigueState = {
      fatigue: round(finiteOr(parsed.fatigue?.fatigue, 0, 0, 100), 3),
      updatedAt: finiteOr(parsed.fatigue?.updatedAt, now),
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

function normalizeContext(
  raw: unknown,
  now: number,
): ContextMoodState | null {
  if (!isPlainObject(raw) || !("mood" in raw)) return null;

  return {
    mood: normalizeText(raw.mood, "neutral"),
    valence: round(finiteOr(raw.valence, 5, 0, 10), 1),
    trigger: typeof raw.trigger === "string" ? raw.trigger.trim() : "",
    updatedAt: finiteOr(raw.updatedAt, now),
  };
}
