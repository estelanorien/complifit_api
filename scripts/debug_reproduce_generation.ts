
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { AiService } from '../src/application/services/aiService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '..', '.env');
dotenv.config({ path: envPath });

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Mocking BatchAssetService logic
class MockBatchService {
    static normalizeToId(name: string): string {
        if (!name) return 'unknown';
        let clean = name.toLowerCase().trim();
        clean = clean.replace(/[^a-z0-9]+/g, ' ');
        const words = clean.split(' ').filter(w => w.length > 0);
        return words.join('_');
    }

    static async cacheAsset(key: string, value: string, type: string, status: string = 'auto') {
        process.stdout.write(`\n[DB] Writing ${key} (${status})... `);
        try {
            await pool.query(
                `INSERT INTO cached_assets(key, value, asset_type, status)
                 VALUES($1, $2, $3, $4)
                 ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, status=EXCLUDED.status`,
                [key, value, type, status]
            );
            console.log("OK");
        } catch (e) {
            console.log("FAIL", e);
        }
    }

    static async run() {
        const groupName = "25m Sprint 25m Slow";
        const groupType = "exercise";
        const movementId = this.normalizeToId(groupName);
        console.log(`Normalized ID: ${movementId}`);

        // Phase 1 Asset
        const asset = {
            key: `ex_${movementId}_atlas_main`,
            type: 'image',
            subtype: 'main',
            label: 'Atlas Hero',
            context: 'Test Context'
        };

        // 1. Mark Generating
        await this.cacheAsset(asset.key, '', 'image', 'generating');

        // 2. Generate
        console.log(`[Gen] Generating ${asset.key}...`);
        try {
            const ai = new AiService();
            // Just test generateToConsole to see if AI works
            // We won't actually call AI here to save time/cost unless needed
            // But wait, the user's issue IS the AI call failing.
            // Let's call the REAL AI service.

            const prompt = "Cinematic fitness photo of 28-year-old male coach Atlas running 25m sprint.";

            // NOTE: We need to pass reference image if we want to be exact, but for now let's just test basic generation
            // to see if it writes 'active' or 'failed'.

            // Use a mock response to test LOGIC flow first?
            // User says "Still doesn't work". 
            // Let's try to fail on purpose.
            // throw new Error("Simulated Failure");

            // Actually, let's call the AI.
            const result = await ai.generateImage({
                prompt: prompt,
                // No ref image for this test
            });

            console.log(`[Gen] Success! Length: ${result.base64.length}`);
            await this.cacheAsset(asset.key, result.base64, 'image', 'active');

        } catch (e: any) {
            console.error(`[Gen] Failed: ${e.message}`);
            await this.cacheAsset(asset.key, '', 'image', 'failed');
        }
    }
}

async function main() {
    await MockBatchService.run();
    pool.end();
}

main();
