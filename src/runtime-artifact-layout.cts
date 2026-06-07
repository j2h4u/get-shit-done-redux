'use strict';

/**
 * Runtime artifact layout module — resolves the artifact directory shapes
 * (commands, agents, skills) for each supported runtime.
 *
 * grok is intentionally absent: it is in runtime-homes.cjs but not wired
 * here. The TypeError on unknown runtime is the loud-fail signal that a
 * runtime was added to the homes list without a layout entry.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/runtime-artifact-layout.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import installProfiles = require('./install-profiles.cjs');
const {
  stageSkillsForProfile,
  stageAgentsForProfile,
  stageSkillsForRuntimeAsSkills,
} = installProfiles;

// In .cts (CommonJS output) files, `require` is available as a global.
const _require: NodeRequire = require;

// ---------------------------------------------------------------------------
// Lazy installer exports (avoids GSD_TEST_MODE env mutation at module load)
// ---------------------------------------------------------------------------

interface InstallExports {
  readGsdCommandNames: () => string[];
  [converterName: string]: unknown;
}

/**
 * Load bin/install.js exports in a test-safe way.
 * Sets GSD_TEST_MODE only for the duration of the require() call and only if
 * it was not already set, restoring the original value in a finally block so
 * the module-level environment is never permanently mutated.
 */
function loadInstallExports(): InstallExports {
  const savedTestMode = process.env['GSD_TEST_MODE'];
  if (savedTestMode === undefined) process.env['GSD_TEST_MODE'] = '1';
  try {
    return _require('../../../bin/install.js') as InstallExports;
  } finally {
    if (savedTestMode === undefined) delete process.env['GSD_TEST_MODE'];
    else process.env['GSD_TEST_MODE'] = savedTestMode;
  }
}

/** Cache after first successful load. */
let _installExports: InstallExports | null = null;
function getInstallExports(): InstallExports {
  if (!_installExports) _installExports = loadInstallExports();
  return _installExports;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ArtifactKindName = 'commands' | 'agents' | 'skills';
type KimiArtifactKindName = ArtifactKindName | 'kimi-agents';

// Mirrors the (unexported) ResolvedProfile in install-profiles.cts.
// Must stay in sync if that shape changes.
interface ResolvedProfile {
  name: string;
  skills: Set<string> | '*';
  agents: Set<string>;
}

interface ArtifactKind {
  kind: KimiArtifactKindName;
  destSubpath: string;
  prefix: string;
  stage: (resolvedProfile: ResolvedProfile) => string;
}

interface Layout {
  runtime: string;
  configDir: string;
  kinds: ArtifactKind[];
}

// ---------------------------------------------------------------------------
// Source root finders
// ---------------------------------------------------------------------------

/**
 * Locate the GSD commands/gsd source directory.
 *
 * Resolution order:
 * 1. If runtimeConfigDir provided, check <runtimeConfigDir>/.gsd-source marker.
 * 2. Walk up from __dirname using path.dirname (no literal .. segments).
 * 3. Throw a descriptive error if neither succeeds.
 */
function findInstallSourceRoot(runtimeConfigDir?: string): string {
  // Step 1: marker check
  if (runtimeConfigDir) {
    const markerPath = path.join(runtimeConfigDir, '.gsd-source');
    if (fs.existsSync(markerPath)) {
      try {
        const src = fs.readFileSync(markerPath, 'utf8').trim();
        if (src && fs.existsSync(src)) return src;
      } catch { /* fall through */ }
    }
  }

  // Step 2: walk up from __dirname
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'commands', 'gsd');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`findInstallSourceRoot: could not locate commands/gsd from ${__dirname}`);
}

/**
 * Locate the GSD agents source directory.
 *
 * Resolution order:
 * 1. If runtimeConfigDir provided, check <runtimeConfigDir>/.gsd-source marker.
 * 2. Walk up from __dirname using path.dirname (no literal .. segments).
 * 3. Throw a descriptive error if neither succeeds.
 */
function findAgentsSourceRoot(runtimeConfigDir?: string): string {
  // Step 1: marker check
  if (runtimeConfigDir) {
    const markerPath = path.join(runtimeConfigDir, '.gsd-source');
    if (fs.existsSync(markerPath)) {
      try {
        const src = fs.readFileSync(markerPath, 'utf8').trim();
        if (src && fs.existsSync(src)) {
          // Marker points to commands/gsd; agents/ is a sibling of commands/
          const agentsCandidate = path.resolve(path.dirname(src), '..', 'agents');
          if (fs.existsSync(agentsCandidate)) return agentsCandidate;
        }
      } catch { /* fall through */ }
    }
  }

  // Step 2: walk up from __dirname
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'agents');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`findAgentsSourceRoot: could not locate agents/ from ${__dirname}`);
}

// ---------------------------------------------------------------------------
// Allowlisted runtimes
// ---------------------------------------------------------------------------

const ALLOWED_RUNTIMES = new Set([
  'claude', 'cursor', 'gemini', 'codex', 'copilot', 'antigravity',
  'windsurf', 'augment', 'trae', 'qwen', 'hermes', 'codebuddy',
  'cline', 'kimi', 'opencode', 'kilo',
]);

// ---------------------------------------------------------------------------
// Layout table builders
// ---------------------------------------------------------------------------

function commandsKind(destSubpath: string, prefix: string, configDir: string): ArtifactKind {
  return {
    kind: 'commands',
    destSubpath,
    prefix,
    stage: (resolved) => stageSkillsForProfile(findInstallSourceRoot(configDir), resolved),
  };
}

function agentsKind(destSubpath: string, prefix: string, configDir: string): ArtifactKind {
  return {
    kind: 'agents',
    destSubpath,
    prefix,
    stage: (resolved) => stageAgentsForProfile(findAgentsSourceRoot(configDir), resolved),
  };
}

function kimiAgentsKind(destSubpath: string, prefix: string, configDir: string): ArtifactKind {
  return {
    kind: 'kimi-agents',
    destSubpath,
    prefix,
    stage: (resolved) => {
      const installExports = getInstallExports();
      const buildKimiAgentArtifacts = installExports['buildKimiAgentArtifacts'] as (opts: {
        rootAgent?: string;
        subagents?: Array<{ path: string; content: string }>;
      }) => {
        root: { yaml: string; prompt: string };
        subagents: Array<{ name: string; yaml: string; prompt: string }>;
      };
      const stagedAgents = stageAgentsForProfile(findAgentsSourceRoot(configDir), resolved);
      const subagents: Array<{ path: string; content: string }> = [];
      if (fs.existsSync(stagedAgents)) {
        for (const entry of fs.readdirSync(stagedAgents, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
          const agentPath = path.join(stagedAgents, entry.name);
          subagents.push({
            path: path.join('agents', entry.name).replace(/\\/g, '/'),
            content: fs.readFileSync(agentPath, 'utf8'),
          });
        }
      }

      const rootAgent = `---\nname: gsd\ndescription: Run GSD workflows in Kimi CLI.\ntools: Agent\n---\n\n# GSD for Kimi CLI\n\nCoordinate installed /skill:gsd-* workflows and route work to generated GSD subagents when a workflow requires an agent handoff.\n`;
      const artifacts = buildKimiAgentArtifacts({ rootAgent, subagents });
      const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-agents-'));
      installProfiles.STAGED_DIRS.add(stageDir);
      fs.writeFileSync(path.join(stageDir, 'gsd.yaml'), artifacts.root.yaml);
      fs.writeFileSync(path.join(stageDir, 'gsd.md'), artifacts.root.prompt);
      const subagentsDir = path.join(stageDir, 'subagents');
      fs.mkdirSync(subagentsDir, { recursive: true });
      for (const artifact of artifacts.subagents) {
        fs.writeFileSync(path.join(subagentsDir, `${artifact.name}.yaml`), artifact.yaml);
        fs.writeFileSync(path.join(subagentsDir, `${artifact.name}.md`), artifact.prompt);
      }
      return stageDir;
    },
  };
}

/**
 * Build a skills kind descriptor.
 *
 * @param destSubpath
 * @param prefix
 * @param converterName  name of converter function in bin/install.js exports
 * @param runtime        canonical runtime ID (gates Hermes/Qwen branding in converter)
 * @param configDir      runtime config dir (for .gsd-source marker resolution)
 */
function skillsKind(
  destSubpath: string,
  prefix: string,
  converterName: string,
  runtime: string,
  configDir: string,
): ArtifactKind {
  return {
    kind: 'skills',
    destSubpath,
    prefix,
    stage: (resolved) => {
      const installExports = getInstallExports();
      const realConverter = installExports[converterName] as (content: string, skillName: string, runtime: string, cmdNames: string[]) => string;
      // Compute cmdNames once per stage call for performance (#3583).
      // Extra args are ignored by converters that don't need runtime/cmdNames.
      const cmdNames = installExports.readGsdCommandNames();
      const wrappedConverter = (content: string, skillName: string): string =>
        realConverter(content, skillName, runtime, cmdNames);
      return stageSkillsForRuntimeAsSkills(findInstallSourceRoot(configDir), resolved, wrappedConverter, prefix);
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the artifact layout for a given runtime and config directory.
 */
function resolveRuntimeArtifactLayout(runtime: string, configDir: string, scope: 'local' | 'global' = 'global'): Layout {
  if (typeof configDir !== 'string' || configDir === '') {
    throw new TypeError('configDir must be a non-empty string');
  }
  if (scope !== 'local' && scope !== 'global') {
    throw new TypeError('scope must be "local" or "global"');
  }
  if (!ALLOWED_RUNTIMES.has(runtime)) {
    throw new TypeError(`Unknown runtime: '${runtime}' — add to runtime-artifact-layout.cjs table`);
  }

  let kinds: ArtifactKind[];
  switch (runtime) {
    case 'claude':
      if (scope === 'local') {
        kinds = [
          commandsKind('commands/gsd', 'gsd-', configDir),
          agentsKind('agents', 'gsd-', configDir),
        ];
      } else {
        kinds = [skillsKind('skills', 'gsd-', 'convertClaudeCommandToClaudeSkill', 'claude', configDir)];
      }
      break;

    case 'cursor':
      kinds = [skillsKind('skills', 'gsd-', 'convertClaudeCommandToCursorSkill', 'cursor', configDir)];
      break;

    case 'gemini':
      kinds = [commandsKind('commands/gsd', 'gsd-', configDir)];
      break;

    case 'codex':
      kinds = [skillsKind('skills', 'gsd-', 'convertClaudeCommandToCodexSkill', 'codex', configDir)];
      break;

    case 'copilot':
      kinds = [skillsKind('skills', 'gsd-', 'convertClaudeCommandToCopilotSkill', 'copilot', configDir)];
      break;

    case 'antigravity':
      kinds = [skillsKind('skills', 'gsd-', 'convertClaudeCommandToAntigravitySkill', 'antigravity', configDir)];
      break;

    case 'windsurf':
      kinds = [skillsKind('skills', 'gsd-', 'convertClaudeCommandToWindsurfSkill', 'windsurf', configDir)];
      break;

    case 'augment':
      kinds = [skillsKind('skills', 'gsd-', 'convertClaudeCommandToAugmentSkill', 'augment', configDir)];
      break;

    case 'trae':
      kinds = [skillsKind('skills', 'gsd-', 'convertClaudeCommandToTraeSkill', 'trae', configDir)];
      break;

    case 'qwen':
      kinds = [skillsKind('skills', 'gsd-', 'convertClaudeCommandToClaudeSkill', 'qwen', configDir)];
      break;

    case 'hermes':
      kinds = [skillsKind('skills/gsd', '', 'convertClaudeCommandToClaudeSkill', 'hermes', configDir)];
      break;

    case 'codebuddy':
      kinds = [skillsKind('skills', 'gsd-', 'convertClaudeCommandToCodebuddySkill', 'codebuddy', configDir)];
      break;

    case 'cline':
      kinds = [];
      break;

    case 'kimi':
      kinds = scope === 'global'
        ? [
            skillsKind('skills', 'gsd-', 'convertClaudeCommandToKimiSkill', 'kimi', configDir),
            kimiAgentsKind('agents', 'gsd', configDir),
          ]
        : [];
      break;

    case 'opencode':
      kinds = [commandsKind('command', 'gsd-', configDir)];
      break;

    case 'kilo':
      kinds = [commandsKind('command', 'gsd-', configDir)];
      break;

    default:
      throw new TypeError(`Unknown runtime: '${runtime}' — add to runtime-artifact-layout.cjs table`);
  }

  return { runtime, configDir, kinds };
}

export = { resolveRuntimeArtifactLayout, findInstallSourceRoot };
