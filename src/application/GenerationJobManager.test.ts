
import { jobManager } from './GenerationJobManager.js';
import assert from 'node:assert';

console.log('Running test for GenerationJobManager (SSE Logic)...');

const TEST_JOB_ID = 'test_job_sse';

// 1. Create Job
console.log('1. Creating Job...');
const job = jobManager.createJob(TEST_JOB_ID, 10);
assert.strictEqual(job.jobId, TEST_JOB_ID);
assert.strictEqual(job.total, 10);
assert.strictEqual(job.status, 'running');
console.log('PASS: Create Job');

// 2. Subscribe to Events
console.log('2. Subscribing to events...');
let eventCount = 0;
let lastProgress: any = null;

const listener = (progress: any) => {
    eventCount++;
    lastProgress = progress;
    console.log(`   Event received: ${progress.completed}/${progress.total} (${progress.status})`);
};

jobManager.on(`job:${TEST_JOB_ID}`, listener);

// 3. Emit Updates
console.log('3. Emitting updates...');
jobManager.updateProgress(TEST_JOB_ID, { completed: 1, currentItem: 'item_1' });
jobManager.updateProgress(TEST_JOB_ID, { completed: 2, currentItem: 'item_2' });
jobManager.updateProgress(TEST_JOB_ID, { completed: 5, failed: 1, currentItem: 'item_6' });

// 4. Verify Updates
setTimeout(() => {
    assert.strictEqual(eventCount, 3);
    assert.strictEqual(lastProgress.completed, 5);
    assert.strictEqual(lastProgress.failed, 1);
    console.log('PASS: Updates received');

    // 5. Complete Job
    console.log('4. Completing job...');
    // Total is 10. We have 5 completed + 1 failed. Remaining 4 skipped?
    // Let's just set completed to 9 and failed to 1
    jobManager.updateProgress(TEST_JOB_ID, { completed: 9, failed: 1 });

    assert.strictEqual(lastProgress.status, 'completed'); // Should auto-complete because 9+1 = 10
    console.log('PASS: Auto-completion');

    // Cleanup
    jobManager.off(`job:${TEST_JOB_ID}`, listener);
    // Explicitly delete to allow process exit if there are lingering timers?
    // The Manager has a setTimeout for cleaning up (line 56). 
    // This might keep the process active for 10 minutes unless we force exit or clear the timeout (which we can't specific reference).
    // So we will use process.exit(0) in the test runner.

    console.log('All GenerationJobManager tests PASSED.');
}, 100);

