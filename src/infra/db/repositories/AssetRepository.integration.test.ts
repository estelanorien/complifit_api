
import { AssetRepository } from './AssetRepository.js';
import { UnifiedKey } from '../../../domain/UnifiedKey.js';
import { pool } from '../pool.js';
import assert from 'node:assert';

console.log('Running integration tests for AssetRepository...');

async function runTests() {
    const timestamp = Date.now();
    const testId = `test_integration_${timestamp}`;
    const key = new UnifiedKey({
        type: 'meal',
        id: testId,
        persona: 'none',
        subtype: 'meta',
        index: 0
    });


    console.log(`Test Key: ${key.toString()}`);

    try {
        // 1. Save Asset
        console.log('1. Testing save()...');
        const metadata = { test: true, timestamp };
        await AssetRepository.save(key, {
            value: JSON.stringify({ description: 'Integration Test' }),
            type: 'json',
            status: 'active',
            metadata
        });
        console.log('PASS: save()');

        // 2. Find By Key
        console.log('2. Testing findByKey()...');
        const record = await AssetRepository.findByKey(key);
        assert.ok(record, 'Record should exist');
        assert.strictEqual(record.key, key.toString());
        assert.strictEqual(record.status, 'active');
        assert.deepStrictEqual(record.metadata, metadata);
        console.log('PASS: findByKey()');

        // 3. Check Exists
        console.log('3. Testing checkExists()...');
        const exists = await AssetRepository.checkExists([key.toString(), 'non_existent_key']);
        assert.ok(exists.has(key.toString()), 'Should find the test key');
        assert.ok(!exists.has('non_existent_key'), 'Should not find non-existent key');
        console.log('PASS: checkExists()');

        // 4. Find By Movement (using LIKE)
        console.log('4. Testing findByMovement()...');
        // The movement ID is the 'id' part of the key
        const byMovement = await AssetRepository.findByMovement(testId);
        assert.ok(byMovement.length > 0, 'Should find assets by movement ID');
        const found = byMovement.find(r => r.key === key.toString());
        assert.ok(found, 'Should contain the saved asset');
        console.log('PASS: findByMovement()');

        // 5. Update Asset
        console.log('5. Testing update (via save)...');
        await AssetRepository.save(key, {
            value: 'updated_value',
            type: 'json',
            status: 'failed', // change status
            metadata: { ...metadata, updated: true }
        });
        const updated = await AssetRepository.findByKey(key);
        assert.strictEqual(updated?.value, 'updated_value');
        assert.strictEqual(updated?.status, 'failed');
        console.log('PASS: Update');

    } catch (e) {
        console.error('TEST FAILED:', e);
        throw e;
    } finally {
        // Cleanup
        console.log('Cleaning up...');
        await pool.query('DELETE FROM cached_assets WHERE key = $1', [key.toString()]);
        console.log('Cleanup complete.');
    }
}

runTests()
    .then(() => {
        console.log('\nAll AssetRepository tests PASSED.');
        // We need specific exit because pool.ts has a setInterval that keeps process alive
        process.exit(0);
    })
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
