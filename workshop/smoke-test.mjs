// Smoke test for the workshop API client + catalog transforms.
// Run from anywhere:  node workshop/smoke-test.mjs
// Needs network access to reforger.armaplatform.com.

import { getBuildId, search, fetchDetail } from './api.js';
import { toEntry, subscribe, allScenarios, resolveMods } from './catalog.js';

const RHS_ID = '595F2BF2F44836FB';

try {
  const buildId = await getBuildId();
  console.log('buildId:', buildId);

  const res = await search('RHS', 1);
  console.log(`search "RHS" -> count: ${res.count}, rows: ${res.rows.length}`);
  if (!res.rows.length) throw new Error('search returned no rows');

  const rhs = res.rows.find(r => r.id === RHS_ID) ?? res.rows[0];
  console.log('picked:', rhs.id, '-', rhs.name);

  const entry = toEntry(await fetchDetail(rhs.id, rhs.name));
  console.log(
    `detail ok -> version: ${entry.version}, deps: ${entry.dependencies.length}, scenarios: ${entry.scenarios.length}`,
  );

  const catalog = {};
  await subscribe(catalog, rhs.id, rhs.name);
  console.log('catalog keys (mod + deps):', Object.keys(catalog));
  console.log('total scenarios:', allScenarios(catalog).length);

  const sc = entry.scenarios[0];
  console.log(`resolveMods for "${sc.name}":`);
  console.log(JSON.stringify(resolveMods(catalog, sc.scenarioId), null, 2));

  console.log('\nALL CHECKS PASSED');
} catch (e) {
  console.error('\nSMOKE TEST FAILED:', e.message);
  process.exitCode = 1;
}
