import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EmotionEngine } from "./engine.ts";
import { buildEmotionContextBlock } from "./prompt.ts";
import {
  refreshUiStatus,
  registerEmotionToolsAndCommands,
  resolveChatId,
} from "./tools.ts";
import type { EmotionEngineOptions } from "./types.ts";

export * from "./types.ts";
export * from "./storage.ts";
export * from "./engine.ts";
export * from "./prompt.ts";
export * from "./tools.ts";

/**
 * Factory to create a configured Pi Emotion & Fatigue Extension.
 *
 * For multi-user isolation on a shared machine / shared OS account, each
 * person sets `PI_EMOTION_USER=<name>` (or has a distinct OS login) and gets
 * a private state file under `~/.pi/agent/emotion-state/users/`.
 * With no custom identity, all sessions share the single legacy file
 * `~/.pi/agent/emotion-state.json`.
 */
export function createEmotionExtension(options: EmotionEngineOptions = {}) {
  let engine: EmotionEngine | undefined;

  const engineFor = (): EmotionEngine => (engine ??= new EmotionEngine(options));

  const extensionFactory = (pi: ExtensionAPI) => {
    // Register AI tools + `/emotion` slash command
    registerEmotionToolsAndCommands(pi, engineFor);

    // Update TUI footer status when a session starts
    pi.on("session_start", async (_event, ctx) => {
      refreshUiStatus(engineFor(), ctx);
    });

    // Pre-Prompt Hook: lazily evaluate decayed/blended emotion & inject into system prompt
    pi.on("before_agent_start", async (event, ctx) => {
      const eng = engineFor();
      const state = eng.getBlendedEmotion();
      const contextBlock = buildEmotionContextBlock(state, resolveChatId(ctx));

      refreshUiStatus(eng, ctx, state);

      if (event.systemPromptOptions?.sections) {
        // Preferred path: patch a prompt section. Pi diffs it and sends only
        // the changed section as a mid-conversation patch, preserving the
        // cached prompt prefix.
        event.systemPromptOptions.sections.emotion_and_fatigue = contextBlock;
        return undefined;
      }

      // Fallback for contexts where prompt sections are unavailable:
      // append once to the forced system prompt.
      return {
        systemPrompt: `${event.systemPrompt}\n\n${contextBlock}`,
      };
    });
  };

  return Object.assign(extensionFactory, {
    engineFor,
    /** Convenience: the resolved EmotionEngine instance. */
    get engine(): EmotionEngine {
      return engineFor();
    },
  });
}

/**
 * Default export for Pi Extension auto-discovery (`.pi/extensions/` or `pi -e ./src/index.ts`).
 */
export default createEmotionExtension();
