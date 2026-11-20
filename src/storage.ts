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
  if (process.env.PI_EMOTION_STATE_PATH) {
    return path.resolve(process.env.PI_EMOTION_STATE_PATH);
  }
  return path.join(os.homedir(), ".pi", "agent", "emotion-state.json");
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
  return identity !== "default" && identity !== osUsername();
}

/**
 * Resolve the state file path for a given user identity.
 *
 * - identity "default" or the OS username -> `~/.pi/agent/emotion-state.json` (shared file)
 * - custom identity (PI_EMOTION_USER)     -> `~/.pi/agent/emotion-state/users/<identity>.json`
 */
export function resolveStoragePath(identity?: string): string {
  const customIdentity =
    identity && isCustomIdentity(identity)
      ? sanitizeIdentity(identity)
      : undefined;

  if (customIdentity) {
    const dir =
      process.env.PI_EMOTION_STATE_DIR ??
      path.join(os.homedir(), ".pi", "agent", "emotion-state");
    return path.join(dir, "users", `${customIdentity}.json`);
  }

  return resolveDefaultStoragePath();
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
  return typeof value === "number" && Number.isFinite(value)
    ? round1(clampNumber(value, min, max))
    : fallback;
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function createInitialState(
  baselineOverrides?: Partial<PersonalityBaseline>,
  now: number = Date.now(),
): EmotionPersistedState {
  const baseline: PersonalityBaseline = {
    mood: normalizeText(baselineOverrides?.mood, DEFAULT_BASELINE.mood),
    energy: normalizeNumber(baselineOverrides?.energy, DEFAULT_BASELINE.energy, 0, 10),
    valence: normalizeNumber(baselineOverrides?.valence, DEFAULT_BASELINE.valence, 0, 10),
    description: normalizeText(baselineOverrides?.description, DEFAULT_BASELINE.description),
  };

  const base: BaseMoodState = {
    mood: baseline.mood,
    energy: baseline.energy,
    valence: baseline.valence,
    description: baseline.description,
    updatedAt: now,
  };

  const fatigue: FatigueState = {
    status: "AWAKE",
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
  private readonly defaultBaseline?: Partial<PersonalityBaseline>;

  constructor(filePath?: string, defaultBaseline?: Partial<PersonalityBaseline>) {
    this.filePath = filePath ? path.resolve(filePath) : resolveDefaultStoragePath();
    this.defaultBaseline = defaultBaseline;
  }

  load(now: number = Date.now()): EmotionPersistedState {
    if (!fs.existsSync(this.filePath)) {
      const initial = createInitialState(this.defaultBaseline, now);
      this.save(initial);
      return initial;
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid persisted emotion state root");
      }
      return this.normalizeState(parsed as Partial<EmotionPersistedState>, now);
    } catch {
      const fallback = createInitialState(this.defaultBaseline, now);
      this.save(fallback);
      return fallback;
    }
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
    const initial = createInitialState(this.defaultBaseline, now);

    const baseline: PersonalityBaseline = {
      mood: normalizeText(parsed.baseline?.mood, initial.baseline.mood),
      energy: normalizeNumber(parsed.baseline?.energy, initial.baseline.energy, 0, 10),
      valence: normalizeNumber(parsed.baseline?.valence, initial.baseline.valence, 0, 10),
      description: normalizeText(parsed.baseline?.description, initial.baseline.description),
    };

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

    const fatigue: FatigueState = {
      status: parsed.fatigue?.status === "SLEEPING" ? "SLEEPING" : "AWAKE",
      fatigue: normalizeNumber(parsed.fatigue?.fatigue, 0, 0, 100),
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
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  let candidate: Record<string, unknown>;

  // Legacy migration: a map of chatId -> ContextMoodState.
  // Keep the freshest entry as the shared context.
  if (!("mood" in raw)) {
    const entries = Object.values(raw).filter(
      (c): c is Record<string, unknown> =>
        !!c && typeof c === "object" && !Array.isArray(c) && "mood" in c,
    );
    if (entries.length === 0) return null;
    candidate = entries.reduce((best, item) => {
      const bestTime =
        typeof best.updatedAt === "number" && Number.isFinite(best.updatedAt)
          ? best.updatedAt
          : -Infinity;
      const itemTime =
        typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt)
          ? item.updatedAt
          : -Infinity;
      return itemTime > bestTime ? item : best;
    });
  } else {
    candidate = raw as Record<string, unknown>;
  }

  return {
    mood: normalizeText(candidate.mood, "neutral"),
    valence: normalizeNumber(candidate.valence, 5, 0, 10),
    trigger: typeof candidate.trigger === "string" ? candidate.trigger.trim() : "",
    updatedAt: normalizeTimestamp(candidate.updatedAt, now),
  };
}
