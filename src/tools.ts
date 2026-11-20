import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EmotionEngine } from "./engine.ts";
import { formatEmotionStatusBadge } from "./prompt.ts";
import { isCustomIdentity } from "./storage.ts";
import type { BlendedEmotionResult } from "./types.ts";

function jsonSchema<T extends Record<string, unknown>>(schema: T): any {
  return schema;
}

const EMPTY_OBJECT_SCHEMA = jsonSchema({
  type: "object",
  properties: {},
  additionalProperties: false,
});

function jsonToolResult<T>(data: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

export function resolveChatId(ctx?: Pick<ExtensionContext, "sessionManager">, explicitChatId?: string): string {
  if (explicitChatId && explicitChatId.trim().length > 0) {
    return explicitChatId.trim();
  }
  try {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (sessionId && sessionId.trim().length > 0) {
      return sessionId.trim();
    }
  } catch {
    // Ignore if sessionManager is not bound in test/CLI context
  }
  return "default";
}

export function refreshUiStatus(
  engine: EmotionEngine,
  ctx?: ExtensionContext,
  state?: BlendedEmotionResult,
): void {
  if (!ctx?.hasUI) return;
  try {
    const blended = state ?? engine.getBlendedEmotion();
    const persona = isCustomIdentity(engine.identity) ? engine.identity : undefined;
    ctx.ui.setStatus("pi-emotion", formatEmotionStatusBadge(blended, persona));
  } catch {
    // Non-fatal UI status update
  }
}

export type EngineResolver = (ctx?: ExtensionContext) => EmotionEngine;

/**
 * Register all Emotion & Fatigue tools and slash commands on Pi ExtensionAPI.
 * Accepts either a single EmotionEngine or a resolver that picks the right
 * engine for the calling context.
 */
export function registerEmotionToolsAndCommands(
  pi: ExtensionAPI,
  engineOrResolver: EmotionEngine | EngineResolver,
): void {
  const engineFor: EngineResolver =
    typeof engineOrResolver === "function"
      ? engineOrResolver
      : () => engineOrResolver;
  // 1. emotion_status
  pi.registerTool({
    name: "emotion_status",
    label: "Emotion Status",
    description:
      "View current global Base Mood, the shared Context Mood, and Fatigue & Sleep status.",
    promptSnippet: "Inspect global Base mood, the shared Context mood, and Fatigue status",
    parameters: EMPTY_OBJECT_SCHEMA,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const engine = engineFor(ctx);
      const status = engine.getStatus();
      refreshUiStatus(engine, ctx);
      return jsonToolResult(status);
    },
  });

  // 2. emotion_get()
  pi.registerTool({
    name: "emotion_get",
    label: "Get Blended Emotion",
    description:
      "Get the lazily decayed and gravity-blended emotion & fatigue state.",
    promptSnippet: "Get blended emotion and fatigue JSON state",
    parameters: EMPTY_OBJECT_SCHEMA,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const engine = engineFor(ctx);
      const result = engine.getBlendedEmotion();
      refreshUiStatus(engine, ctx, result);
      return jsonToolResult(result);
    },
  });

  // 3. emotion_set_base(mood, energy, valence, description)
  pi.registerTool({
    name: "emotion_set_base",
    label: "Set Base Mood",
    description:
      "Update the global Base Mood (6-hour decay back to personality baseline). Call only when a major event shifts overall mood baseline.",
    promptSnippet: "Update global Base Mood (mood, energy 0-10, valence 0-10, description)",
    promptGuidelines: [
      "Use emotion_set_base only when a significant event alters overall baseline mood (6h decay); do not call it on routine turns.",
    ],
    parameters: jsonSchema({
      type: "object",
      properties: {
        mood: {
          type: "string",
          description: "Base mood label (e.g. 'cheerful', 'melancholy', 'focused', 'irritated')",
        },
        energy: {
          type: "number",
          description: "Base energy/activity level from 0 to 10 (automatically capped by fatigue)",
          minimum: 0,
          maximum: 10,
        },
        valence: {
          type: "number",
          description: "Emotional positivity/pleasure level from 0 (very negative) to 10 (very positive)",
          minimum: 0,
          maximum: 10,
        },
        description: {
          type: "string",
          description: "Short nuanced description of the underlying mood and demeanor",
        },
      },
      required: ["mood", "energy", "valence", "description"],
      additionalProperties: false,
    }),
    async execute(
      _toolCallId,
      params: { mood: string; energy: number; valence: number; description: string },
      _signal,
      _onUpdate,
      ctx,
    ) {
      const energy = Number(params.energy);
      const valence = Number(params.valence);
      if (!Number.isFinite(energy) || !Number.isFinite(valence)) {
        throw new Error("emotion_set_base: energy and valence must be finite numbers");
      }
      const engine = engineFor(ctx);
      const result = engine.setBase({
        mood: params.mood,
        energy,
        valence,
        description: params.description,
      });
      refreshUiStatus(engine, ctx, result);
      return jsonToolResult(result);
    },
  });

  // 4. emotion_set_context(mood, valence, trigger)
  pi.registerTool({
    name: "emotion_set_context",
    label: "Set Context Mood",
    description:
      "Update the shared short-term Context Mood (2-hour decay, constrained by Base Mood's emotional gravity). Visible to all sessions of this user.",
    promptSnippet: "Update shared short-term Context Mood (constrained by Base emotional gravity)",
    promptGuidelines: [
      "Use emotion_set_context only when the current conversation genuinely triggers a short-term mood shift, respecting Base mood's emotional gravity.",
    ],
    parameters: jsonSchema({
      type: "object",
      properties: {
        mood: {
          type: "string",
          description: "Short-term context mood label (e.g. 'amused', 'frustrated', 'touched', 'excited')",
        },
        valence: {
          type: "number",
          description: "Target context valence from 0 to 10 (will be clamped & blended by Base mood gravity)",
          minimum: 0,
          maximum: 10,
        },
        trigger: {
          type: "string",
          description: "What happened in the conversation that triggered this mood shift",
        },
      },
      required: ["mood", "valence", "trigger"],
      additionalProperties: false,
    }),
    async execute(
      _toolCallId,
      params: { mood: string; valence: number; trigger: string },
      _signal,
      _onUpdate,
      ctx,
    ) {
      const valence = Number(params.valence);
      if (!Number.isFinite(valence)) {
        throw new Error("emotion_set_context: valence must be a finite number");
      }
      const engine = engineFor(ctx);
      const result = engine.setContext({
        mood: params.mood,
        valence,
        trigger: params.trigger,
      });
      refreshUiStatus(engine, ctx, result);
      return jsonToolResult(result);
    },
  });

  // 5a. sleep()
  pi.registerTool({
    name: "sleep",
    label: "Sleep",
    description:
      "Enter SLEEPING status and synchronously lower Base Mood energy to <= 1. Must be called in the same turn when saying goodnight or going to sleep.",
    promptSnippet: "Enter SLEEPING status and lower emotion energy",
    promptGuidelines: [
      "When saying you are going to sleep or falling asleep, call sleep in the same turn to keep fatigue status and emotion energy synchronized.",
    ],
    parameters: EMPTY_OBJECT_SCHEMA,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const engine = engineFor(ctx);
      const result = engine.sleep();
      refreshUiStatus(engine, ctx, result);
      return jsonToolResult(result);
    },
  });

  // 5b. wake()
  pi.registerTool({
    name: "wake",
    label: "Wake",
    description:
      "Wake up from sleep (status -> AWAKE), reduce fatigue, and moderately restore Base Mood energy. Must be called in the same turn when waking up.",
    promptSnippet: "Wake up (AWAKE), reduce fatigue, and moderately restore emotion energy",
    promptGuidelines: [
      "When waking up from sleep, call wake in the same turn to synchronize AWAKE status and restore emotion energy.",
    ],
    parameters: EMPTY_OBJECT_SCHEMA,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const engine = engineFor(ctx);
      const result = engine.wake();
      refreshUiStatus(engine, ctx, result);
      return jsonToolResult(result);
    },
  });

  // 5c. rest()
  pi.registerTool({
    name: "rest",
    label: "Rest",
    description:
      "Full recovery: reset fatigue to 0, set status to AWAKE, and boost Base Mood energy.",
    promptSnippet: "Fully recover (fatigue = 0, AWAKE) and boost emotion energy",
    parameters: EMPTY_OBJECT_SCHEMA,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const engine = engineFor(ctx);
      const result = engine.rest();
      refreshUiStatus(engine, ctx, result);
      return jsonToolResult(result);
    },
  });

  // 5d. fatigue_status()
  pi.registerTool({
    name: "fatigue_status",
    label: "Fatigue Status",
    description: "Query current fatigue value (0-100), sleep status (AWAKE/SLEEPING), and energy cap.",
    promptSnippet: "Query current fatigue level and sleep status",
    parameters: EMPTY_OBJECT_SCHEMA,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const engine = engineFor(ctx);
      const fatigue = engine.getFatigueStatus();
      refreshUiStatus(engine, ctx);
      return jsonToolResult(fatigue);
    },
  });

  // Register `/emotion` slash command for interactive CLI / TUI use
  pi.registerCommand("emotion", {
    description:
      "Manage Emotion & Fatigue System: /emotion <status|get|set-base|set-context|sleep|wake|rest|fatigue>",
    getArgumentCompletions: (prefix) => {
      const subcommands = [
        "status",
        "get",
        "set-base",
        "set-context",
        "sleep",
        "wake",
        "rest",
        "fatigue",
      ];
      const matches = subcommands.filter((s) => s.startsWith(prefix));
      return matches.length > 0 ? matches.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      const engine = engineFor(ctx);
      try {
        const output = executeCliCommand(engine, tokenizeArgs(args));
        refreshUiStatus(engine, ctx);
        if (ctx.hasUI) {
          ctx.ui.notify(output, "info");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) {
          ctx.ui.notify(message, "error");
        } else {
          throw err;
        }
      }
    },
  });
}

/**
 * Simple shell-like tokenizer supporting quoted strings for CLI / slash commands.
 */
export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"]*)"|'([^']*)'|\S+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[0]);
  }
  return tokens;
}

/**
 * Shared CLI command dispatcher for both `/emotion` slash command and `bin/emotion.ts`.
 */
export function executeCliCommand(
  engine: EmotionEngine,
  argv: string[],
): string {
  const [sub = "status", ...rest] = argv;

  switch (sub) {
    case "status":
    case "emotion_status": {
      return JSON.stringify(engine.getStatus(), null, 2);
    }

    case "get":
    case "emotion_get": {
      return JSON.stringify(engine.getBlendedEmotion(), null, 2);
    }

    case "set-base":
    case "emotion_set_base": {
      if (rest.length < 4) {
        throw new Error(
          "Usage: emotion set-base <mood> <energy:0-10> <valence:0-10> <description>",
        );
      }
      const [mood, energyStr, valenceStr, ...descParts] = rest;
      const energy = Number(energyStr);
      const valence = Number(valenceStr);
      if (!Number.isFinite(energy) || !Number.isFinite(valence)) {
        throw new Error(
          "Usage: emotion set-base <mood> <energy:0-10> <valence:0-10> <description> — energy and valence must be numbers",
        );
      }
      const result = engine.setBase({
        mood,
        energy,
        valence,
        description: descParts.join(" "),
      });
      return JSON.stringify(result, null, 2);
    }

    case "set-context":
    case "emotion_set_context": {
      if (rest.length < 3) {
        throw new Error(
          "Usage: emotion set-context <mood> <valence:0-10> <trigger>",
        );
      }
      const [mood, valenceStr, ...triggerParts] = rest;
      const valence = Number(valenceStr);
      if (!Number.isFinite(valence)) {
        throw new Error(
          "Usage: emotion set-context <mood> <valence:0-10> <trigger> — valence must be a number",
        );
      }
      const result = engine.setContext({
        mood,
        valence,
        trigger: triggerParts.join(" "),
      });
      return JSON.stringify(result, null, 2);
    }

    case "sleep": {
      return JSON.stringify(engine.sleep(), null, 2);
    }

    case "wake": {
      return JSON.stringify(engine.wake(), null, 2);
    }

    case "rest": {
      return JSON.stringify(engine.rest(), null, 2);
    }

    case "fatigue":
    case "fatigue-status":
    case "fatigue_status": {
      if (rest[0] === undefined) {
        return JSON.stringify(engine.getFatigueStatus(), null, 2);
      }
      const value = Number(rest[0]);
      if (!Number.isFinite(value)) {
        throw new Error("Usage: emotion fatigue [0-100] — value must be a number");
      }
      return JSON.stringify(engine.setFatigue(value), null, 2);
    }

    default:
      throw new Error(
        `Unknown emotion command "${sub}". Supported: status, get, set-base, set-context, sleep, wake, rest, fatigue`,
      );
  }
}
