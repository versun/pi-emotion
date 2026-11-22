import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EmotionEngine } from "./engine.ts";
import { buildEmotionContextBlock } from "./prompt.ts";
import {
  EMOTION_TOOL_NAMES,
  refreshUiStatus,
  registerEmotionToolsAndCommands,
} from "./tools.ts";
import type { EmotionEngineOptions } from "./types.ts";

export type {
  BaseMoodState,
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
export {
  DEFAULT_BASELINE,
  EmotionStorage,
  isCustomIdentity,
  resolveIdentity,
  resolveStoragePath,
} from "./storage.ts";
export {
  BASE_DECAY_MS,
  CONTEXT_DECAY_MS,
  DEFAULT_CONTEXT_WEIGHT,
  DEFAULT_FATIGUE_PER_TOOL_CALL,
  DEFAULT_FATIGUE_PER_TOOL_ERROR,
  DEFAULT_FATIGUE_PER_TURN,
  DEFAULT_FATIGUE_RECOVERY_PER_HOUR,
  DEFAULT_HIGH_FATIGUE_VALENCE_THRESHOLD,
  DEFAULT_MAX_FATIGUE_PER_TURN,
  DEFAULT_MAX_FATIGUE_VALENCE_PENALTY,
  DEFAULT_MAX_GRAVITY_DELTA,
  EmotionEngine,
  clampValenceByGravity,
  computeDecayFactor,
  computeEnergyCapFromFatigue,
  computeFatigueValencePenalty,
  computeRecoveredFatigue,
} from "./engine.ts";
export {
  buildEmotionContextBlock,
  describeEnergyBehavior,
  describeValenceBehavior,
  formatEmotionStatusBadge,
} from "./prompt.ts";
export { executeCliCommand, tokenizeArgs } from "./tools.ts";

/**
 * Factory to create a configured Pi Emotion & Fatigue Extension.
 *
 * For multi-user isolation on a shared machine / shared OS account, each
 * identity resolves via `PI_EMOTION_USER` > OS login username > `"default"`
 * and is stored at `~/.pi/agent/emotion-state/<identity>.json` (or under
 * `PI_EMOTION_STATE_DIR` / overridden by `PI_EMOTION_STATE_PATH`).
 */
export function createEmotionExtension(options: EmotionEngineOptions = {}) {
  let engine: EmotionEngine | undefined;
  const getEngine = (): EmotionEngine => (engine ??= new EmotionEngine(options));

  const extensionFactory = (pi: ExtensionAPI) => {
    const eng = getEngine();

    // Register AI tools + `/emotion` slash command
    registerEmotionToolsAndCommands(pi, eng);

    // Update TUI footer status when a session starts
    pi.on("session_start", async (_event, ctx) => {
      refreshUiStatus(eng, ctx);
    });

    // Pre-Prompt Hook: lazily evaluate decayed/blended emotion & inject into system prompt
    pi.on("before_agent_start", async (event, ctx) => {
      const state = eng.getBlendedEmotion();
      const contextBlock = buildEmotionContextBlock(state);

      refreshUiStatus(eng, ctx, state);

      if (
        event.systemPromptOptions?.sections &&
        event.systemPromptOptions.forceSystemPrompt === undefined
      ) {
        // Preferred path: patch a prompt section. Pi diffs it and sends only
        // the changed section as a mid-conversation patch, preserving the
        // cached prompt prefix.
        event.systemPromptOptions.sections.emotion_and_fatigue = contextBlock;
        return undefined;
      }

      // Fallback when prompt sections are unavailable or a forced system prompt
      // is active: append once to the forced system prompt.
      return {
        systemPrompt: `${event.systemPrompt}\n\n${contextBlock}`,
      };
    });

    // Post-Turn Hook: automatically accumulate workload fatigue from completed turns & tools
    pi.on("turn_end", async (event, ctx) => {
      const toolResults = event?.toolResults ?? [];

      // Skip cancelled or provider-errored turns that performed no work
      if (
        (event?.outcome === "aborted" || event?.outcome === "error") &&
        toolResults.length === 0
      ) {
        return;
      }

      // If this turn successfully invoked `rest`, keep fatigue at 0 instead of immediately adding back
      if (toolResults.some((r) => r?.toolName === "rest" && !r.isError)) {
        refreshUiStatus(eng, ctx);
        return;
      }

      let toolCalls = 0;
      let toolErrors = 0;
      for (const result of toolResults) {
        if (!result || EMOTION_TOOL_NAMES.has(result.toolName)) continue;
        toolCalls += 1;
        if (result.isError) toolErrors += 1;
      }

      const state = eng.recordWorkload({ turns: 1, toolCalls, toolErrors });
      refreshUiStatus(eng, ctx, state);
    });
  };

  return Object.assign(extensionFactory, {
    /** Convenience: the resolved EmotionEngine instance. */
    get engine(): EmotionEngine {
      return getEngine();
    },
  });
}

/**
 * Default export for Pi Extension auto-discovery (`.pi/extensions/` or `pi -e ./src/index.ts`).
 */
export default createEmotionExtension();
