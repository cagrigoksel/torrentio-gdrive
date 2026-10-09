import assert from 'assert';
import { MochOptions } from '../addon/moch/moch.js';
import { manifest } from '../addon/lib/manifest.js';
import { parseCredentials } from '../addon/moch/gdrive.js';
import { TIER1_TRACKERS } from '../addon/lib/trackers.js';

console.log('--- Running Torrentio-GDrive Test Suite ---');

// Test 1: GDrive Moch Registration
console.log('1. Checking MochOptions registration...');
assert.ok(MochOptions.gdrive, 'GDrive provider must be present in MochOptions');
assert.strictEqual(MochOptions.gdrive.key, 'gdrive');
assert.strictEqual(MochOptions.gdrive.shortName, 'GDrive');
console.log('   ✅ GDrive provider registered successfully.');

// Test 2: Manifest Generation with GDrive
console.log('2. Testing Manifest generation...');
const mf = manifest({ gdrive: 'default', host: 'http://localhost:7070' });
assert.ok(mf.name.includes('GDrive'), 'Manifest name should include GDrive');
assert.ok(mf.description.includes('GoogleDrive'), 'Manifest description should include GoogleDrive');
console.log('   ✅ Manifest generated with GoogleDrive catalog and resources.');

// Test 3: Tracker Booster Check
console.log('3. Checking Tier-1 Trackers count...');
assert.ok(TIER1_TRACKERS.length >= 30, `Expected at least 30 trackers, found ${TIER1_TRACKERS.length}`);
console.log(`   ✅ Tracker booster loaded with ${TIER1_TRACKERS.length} Tier-1 trackers.`);

// Test 4: Credential Parsing
console.log('4. Testing credential parsing...');
const base64Json = Buffer.from(JSON.stringify({
  clientId: 'test-client',
  clientSecret: 'test-secret',
  refreshToken: 'test-refresh'
})).toString('base64');

const parsed = parseCredentials(base64Json);
assert.strictEqual(parsed.clientId, 'test-client');
assert.strictEqual(parsed.clientSecret, 'test-secret');
assert.strictEqual(parsed.refreshToken, 'test-refresh');
console.log('   ✅ Base64 credentials parsed correctly.');

console.log('--- All Tests Passed Successfully! ✅ ---');
