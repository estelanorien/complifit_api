
import { pool } from '../src/infra/db/pool.js';
import { jobProcessor } from '../src/application/services/jobProcessor.js';
import { BatchAssetService } from '../src/services/BatchAssetService.js';
import crypto from 'crypto';

async function main() {
    try {
        console.log("=== Verifying Sequential Pipeline ===");

        // 1. Create a dummy group
        const groupName = "Test Sequential Move";
        const groupId = "test_seq_group_01";
        const userId = crypto.randomUUID();

        console.log(`\n1. Submitting Batch Job for: ${groupName}...`);

        // Use the submitJob API directly to test the strict queuing
        const { jobId } = await jobProcessor.submitJob(
            userId,
            'BATCH_ASSET_GENERATION',
            {
                groupId,
                groupName,
                groupType: 'exercise',
                forceRegen: true
            },
            2, // Priority
            `batch_gen_${groupId}_${Date.now()}`
        );

        console.log(`Job Submitted. ID: ${jobId}`);

        // 2. Poll for Progress
        console.log("\n2. Polling for Progress (watching for 'processing' and result updates)...");

        let attempts = 0;
        let completed = false;

        while (!completed && attempts < 30) {
            const res = await pool.query(`SELECT status, result, error FROM generation_jobs WHERE id = $1`, [jobId]);
            const job = res.rows[0];

            if (job) {
                console.log(`[${new Date().toISOString().split('T')[1]}] Status: ${job.status}`);
                if (job.result) {
                    console.log(`   Result: ${JSON.stringify(job.result)}`);
                }

                if (job.status === 'COMPLETED') {
                    console.log("\n✅ Job Completed Successfully!");
                    completed = true;
                } else if (job.status === 'FAILED') {
                    console.error("\n❌ Job Failed:", job.error);
                    completed = true;
                }
            }

            if (!completed) await new Promise(r => setTimeout(r, 2000));
            attempts++;
        }

        if (!completed) {
            console.error("\n⚠️ Verification Timed Out (Job might be stuck or slow)");
        }

        // 3. Verify Assets exist
        console.log("\n3. Verifying Generated Assets...");
        const normalizedId = "test_sequential_move"; // Expected from 'Test Sequential Move'
        const keysToCheck = [
            `ex_${normalizedId}_atlas_main`,
            `ex_${normalizedId}_nova_main`
        ];

        for (const key of keysToCheck) {
            const res = await pool.query(`SELECT status FROM cached_assets WHERE key = $1`, [key]);
            if (res.rowCount > 0) {
                console.log(`✅ Asset found: ${key} [${res.rows[0].status}]`);
            } else {
                console.error(`❌ Asset MISSING: ${key}`);
            }
        }

    } catch (e: any) {
        console.error("Verification Failed:", e.message);
    } finally {
        await pool.end();
    }
}

main();
