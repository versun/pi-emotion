# pi-emotion — Layered Emotion & Fatigue System Plugin for Pi Agent

A lightweight, state-persistent **Emotion & Fatigue System Plugin** for Pi Agent (`@earendil-works/pi-coding-agent`), designed around:
1. **Persistent State + Lazy Time Decay** (no background polling timers or per-turn sentiment model calls)
2. **6-Hour Base Mood Decay** back to configurable Default Personality Baseline
3. **2-Hour Shared Context Mood Decay** with **Emotional Gravity** clamping & weighted blending
4. **Time & Workload-Driven Fatigue** (`0–100`): automatically accumulates on `turn_end` based on turns, tool calls, and tool errors (with a per-turn cap), lazily recovers over idle time (`15 pts/hour` by default), caps effective `energy`, and gently weighs on `valence` under high exhaustion (`> 60`)
5. **Pre-Prompt Hook (`before_agent_start`)** injecting current blended mood, fatigue state, English behavioral tone mapping, and tool update guidelines
6. **Dual Interface**: AI Function-Calling Tools + CLI / Slash Commands

---

## Directory Structure

```text
pi-emotion/
├── package.json          # Pi Package manifest & scripts
├── src/
│   ├── types.ts          # Data models (Baseline, BaseMood, ContextMood, Fatigue, WorkloadInput, BlendedEmotionResult)
│   ├── storage.ts        # Atomic JSON persistence & state normalization
│   ├── engine.ts         # Core math (6h/2h lazy decay, emotional gravity clamp & blend, workload & idle fatigue recovery)
│   ├── prompt.ts         # Pre-Prompt Hook template generator (Emotion & Fatigue Context Block)
│   ├── tools.ts          # Pi AI Tool definitions + `/emotion` slash command + CLI dispatcher
│   └── index.ts          # Pi Extension entry point (`before_agent_start`, `turn_end`, `session_start` hooks)
├── bin/
│   └── emotion.ts        # Standalone CLI (`emotion status`, `emotion get`, etc.)
└── test/
    └── emotion.test.ts   # Unit test suite (node:test)
```

---

## Quick Start

### 1. Run Unit Tests
```bash
npm test
```

### 2. Load in Pi Agent
```bash
pi -e ./src/index.ts
```
Or install as a local Pi package:
```bash
pi install .
```

### 3. CLI Usage
```bash
npm run emotion -- status
npm run emotion -- get
npm run emotion -- set-base melancholy 3 2 "drained after debugging"
npm run emotion -- set-context amused 8 "user told a clever joke"
npm run emotion -- workload 1 4 1
npm run emotion -- rest
npm run emotion -- fatigue
npm run emotion -- fatigue 50
```

---

## Isolation Model

| Layer | Scope | Evolution |
|---|---|---|
| Baseline personality | per identity file | static config |
| Base Mood | shared within identity | 6h lazy decay → baseline |
| Context Mood | shared within identity | 2h lazy decay → expires |
| Fatigue | shared within identity | grows with `turn_end` workload, passively recovers over idle time (`15/hr`), or resets via `rest` |

For a single user, every Pi session sees the same mood — a Context Mood
shift set in one window carries over to the next for up to two hours.

---

## Isolation: Multi-User Identity

Several people using the same Pi install on a shared machine / shared OS
account each get a private persona via `PI_EMOTION_USER`:

```bash
export PI_EMOTION_USER=alice   # in each user's shell profile
```

Resolution order: `PI_EMOTION_USER` > OS login username > `default`.
A custom identity is stored at
`~/.pi/agent/emotion-state/users/<identity>.json`. The default (unset)
identity keeps using the legacy shared `~/.pi/agent/emotion-state.json`,
so nothing breaks for single-user setups. The TUI status badge prefixes
`alice·` when a custom identity is active.

Within one identity, Base Mood, Context Mood, and Fatigue are all shared
across sessions.
