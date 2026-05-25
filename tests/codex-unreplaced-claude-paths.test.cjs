'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  collectUnreplacedClaudePathRefs,
  convertClaudeAgentToCodexAgent,
  convertClaudeCommandToCodexSkill,
} = require('../bin/install.js');

const leakedClaudePath = /(?:~|\$HOME)\/\.claude\b/;
const rmOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };

describe('Codex install path leakage regression', () => {
  test('command conversion rewrites bare Claude config paths and config env var for gsd-surface', () => {
    const input = `---
name: gsd:surface
description: Toggle which skills are surfaced
---

Surface state file: \`~/.claude/.gsd-surface.json\`
Skill dirs: \`~/.claude/skills/gsd-*/\`

\`\`\`bash
RUNTIME_CONFIG_DIR="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
\`\`\`

All paths can be overridden by reading the \`CLAUDE_CONFIG_DIR\` env var if set.
`;

    const converted = convertClaudeCommandToCodexSkill(input, 'gsd-surface');

    assert.ok(!leakedClaudePath.test(converted), `expected no leaked Claude config path, got:\n${converted}`);
    assert.match(converted, /(?:~|\$HOME)\/\.codex\/\.gsd-surface\.json/);
    assert.match(converted, /(?:~|\$HOME)\/\.codex\/skills\/gsd-\*\//);
    assert.ok(converted.includes('CODEX_HOME'));
    assert.ok(!converted.includes('CLAUDE_CONFIG_DIR'));
  });

  test('agent conversion rewrites bare Claude config paths before TOML emission', () => {
    const input = `---
name: gsd-debugger
description: Debug issues
tools: Read, Bash
---

configDir = ~/.claude
fallbackDir = $HOME/.claude
engine = ~/.claude/get-shit-done/bin/gsd-tools.cjs
`;

    const converted = convertClaudeAgentToCodexAgent(input);

    assert.ok(!leakedClaudePath.test(converted), `expected no leaked Claude config path, got:\n${converted}`);
    assert.ok(converted.includes('configDir = ~/.codex'));
    assert.ok(converted.includes('fallbackDir = $HOME/.codex'));
    assert.ok(converted.includes('~/.codex/get-shit-done/bin/gsd-tools.cjs'));
  });

  test('leak collector ignores Codex temporary plugin cache but still reports installed GSD files', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-leak-scan-'));
    t.after(() => fs.rmSync(root, rmOptions));

    const tmpPlugin = path.join(root, '.tmp', 'plugins', 'plugins', 'superpowers');
    const skillDir = path.join(root, 'skills', 'gsd-surface');
    fs.mkdirSync(tmpPlugin, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(tmpPlugin, 'README.md'), 'temporary docs mention ~/.claude\n', 'utf8');
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'installed docs mention ~/.claude\n', 'utf8');

    const leaks = collectUnreplacedClaudePathRefs(root);

    assert.deepStrictEqual(leaks, [{ file: 'skills/gsd-surface/SKILL.md', count: 1 }]);
  });

  test('Codex CLI install does not emit circular schema-validator warnings', (t) => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-cli-install-'));
    t.after(() => fs.rmSync(codexHome, rmOptions));

    const env = { ...process.env, CODEX_HOME: codexHome };
    delete env.GSD_TEST_MODE;

    const result = spawnSync(
      process.execPath,
      ['--trace-warnings', path.join(__dirname, '..', 'bin', 'install.js'), '--codex', '--global', '--no-sdk'],
      { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' }
    );
    const output = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.status, 0, output);
    assert.doesNotMatch(output, /__codexSchemaValidator|circular dependency/);
  });
});
