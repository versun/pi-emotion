import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EmotionEngine } from "./engine.ts";
import { formatEmotionStatusBadge } from "./prompt.ts";
import { isCustomIdentity } from "./storage.ts";
import type { BlendedEmotionResult } from "./types.ts";

export const EMOTION_TOOL_NAMES = new Set([
  "emotion_status",
  "emotion_get",
  "emotion_set_base",
  "emotion_set_context",
  "rest",
  "fatigue_status",
]);

const CLI_SUBCOMMANDS = [
  "status",
  "get",
  "set-base",
  "set-context",
  "rest",
  "fatigue",
  "workload",
] as const;

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

function requireFiniteNumber(value: unknown, errorMessage: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  throw new Error(errorMessage);
}

export function refreshUiStatus(
  engine: EmotionEngine,
  ctx?: ExtensionContext,
  state?: BlendedEmotionResult,
): void {
  if (!ctx?.hasUI) return;
  const blended = state ?? engine.getBlendedEmotion();
  const persona = isCustomIdentity(engine.identity) ? engine.identity : undefined;
  ctx.ui.setStatus("pi-emotion", formatEmotionStatusBadge(blended, persona));
}

/**
 * Register all Emotion & Fatigue tools and slash commands on Pi ExtensionAPI.
 */
export function registerEmotionToolsAndCommands(
  pi: ExtensionAPI,
  engine: EmotionEngine,
): void {
  // 1. emotion_status
  pi.registerTool({
    name: "emotion_status",
    label: "Emotion Status",
    description:
      "View current global Base Mood, the shared Context Mood, and workload Fatigue status.",
    promptSnippet: "Inspect global Base mood, the shared Context mood, and Fatigue status",
    parameters: EMPTY_OBJECT_SCHEMA,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const status = engine.getStatus();
      refreshUiStatus(engine, ctx, status);
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
      const errMsg = "emotion_set_base: energy and valence must be finite numbers";
      const energy = requireFiniteNumber(params.energy, errMsg);
      const valence = requireFiniteNumber(params.valence, errMsg);
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
      const valence = requireFiniteNumber(
        params.valence,
        "emotion_set_context: valence must be a finite number",
      );
      const result = engine.setContext({
        mood: params.mood,
        valence,
        trigger: params.trigger,
      });
      refreshUiStatus(engine, ctx, result);
      return jsonToolResult(result);
    },
  });

  // 5. rest()
  pi.registerTool({
    name: "rest",
    label: "Rest",
    description:
      "Full recovery: reset workload fatigue to 0 and boost Base Mood energy.",
    promptSnippet: "Fully recover (fatigue = 0) and boost emotion energy",
    promptGuidelines: [
      "Only call rest when the user explicitly invites you to take a break or reset fatigue; do not self-reset workload fatigue on your own.",
    ],
    parameters: EMPTY_OBJECT_SCHEMA,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const result = engine.rest();
      refreshUiStatus(engine, ctx, result);
      return jsonToolResult(result);
    },
  });

  // 6. fatigue_status()
  pi.registerTool({
    name: "fatigue_status",
    label: "Fatigue Status",
    description:
      "Query current workload fatigue (0-100, passively recovers over idle time) and energy cap.",
    promptSnippet: "Query current workload fatigue level and energy cap",
    parameters: EMPTY_OBJECT_SCHEMA,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const blended = engine.getBlendedEmotion();
      refreshUiStatus(engine, ctx, blended);
      return jsonToolResult(blended.fatigue);
    },
  });

  // Register `/emotion` slash command for interactive CLI / TUI use
  pi.registerCommand("emotion", {
    description: `Manage Emotion & Fatigue System: /emotion <${CLI_SUBCOMMANDS.join("|")}>`,
    getArgumentCompletions: (prefix) => {
      const matches = CLI_SUBCOMMANDS.filter((s) => s.startsWith(prefix));
      return matches.length > 0 ? matches.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      try {
        const { data, blended } = runCliCommand(engine, tokenizeArgs(args));
        refreshUiStatus(engine, ctx, blended);
        if (ctx.hasUI) {
          ctx.ui.notify(JSON.stringify(data, null, 2), "info");
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

function runCliCommand(
  engine: EmotionEngine,
  argv: string[],
): { data: unknown; blended: BlendedEmotionResult } {
  const [sub = "status", ...rest] = argv;

  switch (sub) {
    case "status": {
      const status = engine.getStatus();
      return { data: status, blended: status };
    }

    case "get": {
      const blended = engine.getBlendedEmotion();
      return { data: blended, blended };
    }

    case "set-base": {
      if (rest.length < 4) {
        throw new Error(
          "Usage: emotion set-base <mood> <energy:0-10> <valence:0-10> <description>",
        );
      }
      const [mood, energyStr, valenceStr, ...descParts] = rest;
      const errMsg =
        "Usage: emotion set-base <mood> <energy:0-10> <valence:0-10> <description> — energy and valence must be numbers";
      const blended = engine.setBase({
        mood,
        energy: requireFiniteNumber(energyStr, errMsg),
        valence: requireFiniteNumber(valenceStr, errMsg),
        description: descParts.join(" "),
      });
      return { data: blended, blended };
    }

    case "set-context": {
      if (rest.length < 3) {
        throw new Error(
          "Usage: emotion set-context <mood> <valence:0-10> <trigger>",
        );
      }
      const [mood, valenceStr, ...triggerParts] = rest;
      const valence = requireFiniteNumber(
        valenceStr,
        "Usage: emotion set-context <mood> <valence:0-10> <trigger> — valence must be a number",
      );
      const blended = engine.setContext({
        mood,
        valence,
        trigger: triggerParts.join(" "),
      });
      return { data: blended, blended };
    }

    case "rest": {
      const blended = engine.rest();
      return { data: blended, blended };
    }

    case "workload": {
      const errMsg =
        "Usage: emotion workload [turns=1] [toolCalls=0] [toolErrors=0] — values must be numbers (>= 0)";
      const parseNonNeg = (raw: string | undefined, fallback: number) => {
        if (raw === undefined) return fallback;
        const n = requireFiniteNumber(raw, errMsg);
        if (n < 0) throw new Error(errMsg);
        return n;
      };
      const blended = engine.recordWorkload({
        turns: parseNonNeg(rest[0], 1),
        toolCalls: parseNonNeg(rest[1], 0),
        toolErrors: parseNonNeg(rest[2], 0),
      });
      return { data: blended, blended };
    }

    case "fatigue": {
      if (rest[0] === undefined) {
        const blended = engine.getBlendedEmotion();
        return { data: blended.fatigue, blended };
      }
      const value = requireFiniteNumber(
        rest[0],
        "Usage: emotion fatigue [0-100] — value must be a number",
      );
      const blended = engine.setFatigue(value);
      return { data: blended, blended };
    }

    default:
      throw new Error(
        `Unknown emotion command "${sub}". Supported: ${CLI_SUBCOMMANDS.join(", ")}`,
      );
  }
}

/**
 * Shared CLI command dispatcher for both `/emotion` slash command and `bin/emotion.ts`.
 */
export function executeCliCommand(
  engine: EmotionEngine,
  argv: string[],
): string {
  return JSON.stringify(runCliCommand(engine, argv).data, null, 2);
}
