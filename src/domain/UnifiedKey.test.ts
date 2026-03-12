import { UnifiedKey } from './UnifiedKey.js';
import assert from 'node:assert';
import { describe, it } from 'node:test';

// Simple test runner if node:test is not fully supported in the env (Node < 18)
// But user env is likely modern. If not, we can just run this file with 'tsx'.

console.log('Running functionality tests for UnifiedKey...');

// 1. Test Key Construction & Stringification
try {
    const key = new UnifiedKey({
        type: 'ex',
        id: 'bench_press',
        persona: 'atlas',
        subtype: 'main',
        index: 0
    });

    assert.strictEqual(key.toString(), 'ex:bench_press:atlas:main:0');
    console.log('PASS: Construction & Stringification');
} catch (e: any) {
    console.error('FAIL: Construction & Stringification', e);
    process.exit(1);
}

// 2. Test Parsing
try {
    const keyStr = 'meal:oatmeal_bowl:none:step:1';
    const key = UnifiedKey.parse(keyStr);

    assert.strictEqual(key.type, 'meal');
    assert.strictEqual(key.id, 'oatmeal_bowl');
    assert.strictEqual(key.persona, 'none');
    assert.strictEqual(key.subtype, 'step');
    assert.strictEqual(key.index, 1);

    // Round trip
    assert.strictEqual(key.toString(), keyStr);
    console.log('PASS: Parsing');
} catch (e: any) {
    console.error('FAIL: Parsing', e);
    process.exit(1);
}

// 3. Test Validation Logic
try {
    let threw = false;
    try {
        UnifiedKey.parse('invalid:format');
    } catch (e) {
        threw = true;
    }
    assert.ok(threw, 'Should throw on invalid format');
    console.log('PASS: Validation (Format)');
} catch (e: any) {
    console.error('FAIL: Validation (Format)', e);
    process.exit(1);
}

// 4. Test To Meta Key
try {
    const key = new UnifiedKey({
        type: 'ex',
        id: 'squat',
        persona: 'nova',
        subtype: 'video',
        index: 2
    });

    const metaKey = key.toMetaKey();
    assert.strictEqual(metaKey.toString(), 'ex:squat:none:meta:0');
    console.log('PASS: toMetaKey Transformation');
} catch (e: any) {
    console.error('FAIL: toMetaKey Transformation', e);
    process.exit(1);
}

console.log('\nAll UnifiedKey tests PASSED.');
