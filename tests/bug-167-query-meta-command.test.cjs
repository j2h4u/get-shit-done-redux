'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

test('bug #167: query meta-command prefixes direct gsd-tools calls', () => {
  const direct = runGsdTools(['init.progress']);
  assert.equal(direct.success, true, `init.progress failed: ${direct.error || direct.output}`);

  const meta = runGsdTools(['query', 'init.progress']);
  assert.equal(meta.success, true, `query init.progress failed: ${meta.error || meta.output}`);

  assert.deepEqual(
    JSON.parse(meta.output),
    JSON.parse(direct.output),
    'query-prefixed and direct invocations should return identical init.progress payloads'
  );
});

test('query init.plan-review-convergence aliases plan-phase init payload', () => {
  const tmpDir = createTempProject('gsd-plan-review-convergence-init-');
  try {
    const planningDir = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), [
      '# Roadmap',
      '',
      '## Current Milestone: v1.1',
      '',
      '### Phase 9: Samsung Raw Import and Provenance',
      '**Status:** Pending',
      '**Requirements:** SAMSUNG-02, SAMSUNG-03',
      '',
    ].join('\n'));

    const expected = runGsdTools(['query', 'init.plan-phase', '9'], tmpDir, { HOME: tmpDir });
    assert.equal(expected.success, true, `query init.plan-phase failed: ${expected.error || expected.output}`);

    const actual = runGsdTools(['query', 'init.plan-review-convergence', '9'], tmpDir, { HOME: tmpDir });
    assert.equal(actual.success, true, `query init.plan-review-convergence failed: ${actual.error || actual.output}`);

    assert.deepEqual(
      JSON.parse(actual.output),
      JSON.parse(expected.output),
      'plan-review-convergence init should be a compatibility alias for plan-phase init'
    );
  } finally {
    cleanup(tmpDir);
  }
});
