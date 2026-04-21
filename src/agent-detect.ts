// Cross-agent skill/settings directory discovery.
//
// Probes canonical paths under $HOME and returns one AgentTarget record per
// agent whose parent directory exists. The `skills/` leaf may be absent --
// installSkill() creates it.
//
// NOTE: `homedir()` is called per-invocation (via `homeOverride ?? homedir()`)
// and NEVER hoisted to a module-level constant. Tests override
// `process.env.HOME` in `beforeEach`; hoisting would freeze the harness's
// original HOME at import time and detection would run against the real $HOME.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AgentTarget = {
  agent: "claude-code" | "cursor" | "cline" | "windsurf" | "opencode";
  skillsDir: string;
  settingsFile: string;
  hookSupport: "claude-code" | "notice";
};

type AgentSpec = {
  agent: AgentTarget["agent"];
  skillsRel: string[];
  settingsRel: string[];
  hookSupport: AgentTarget["hookSupport"];
};

// Deterministic order: claude-code first (only agent with hook support),
// then cursor, cline, windsurf, opencode.
const AGENT_SPECS: readonly AgentSpec[] = [
  {
    agent: "claude-code",
    skillsRel: [".claude", "skills"],
    settingsRel: [".claude", "settings.json"],
    hookSupport: "claude-code",
  },
  {
    agent: "cursor",
    skillsRel: [".cursor", "skills"],
    settingsRel: [".cursor", "settings.json"],
    hookSupport: "notice",
  },
  {
    agent: "cline",
    skillsRel: [".cline", "skills"],
    settingsRel: [".cline", "settings.json"],
    hookSupport: "notice",
  },
  {
    agent: "windsurf",
    skillsRel: [".windsurf", "skills"],
    settingsRel: [".windsurf", "settings.json"],
    hookSupport: "notice",
  },
  {
    agent: "opencode",
    skillsRel: [".config", "opencode", "skills"],
    settingsRel: [".config", "opencode", "settings.json"],
    hookSupport: "notice",
  },
];

export function detectAgents(homeOverride?: string): AgentTarget[] {
  const home = homeOverride ?? homedir();
  const results: AgentTarget[] = [];
  for (const spec of AGENT_SPECS) {
    const skillsDir = join(home, ...spec.skillsRel);
    const settingsFile = join(home, ...spec.settingsRel);
    // "Detected" iff the parent of skills/ exists (e.g. ~/.claude/).
    // skills/ itself may be absent; installer creates it.
    if (existsSync(dirname(skillsDir))) {
      results.push({
        agent: spec.agent,
        skillsDir,
        settingsFile,
        hookSupport: spec.hookSupport,
      });
    }
  }
  return results;
}
