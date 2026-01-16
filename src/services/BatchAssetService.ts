
import { pool } from '../infra/db/pool.js';
import { generateAsset } from './AssetGenerationService.js';

export class BatchAssetService {

    /**
     * Finds movements that lay 'active' assets (either main video/image or meal steps)
     * and queues them for generation. For now, it runs synchronously for simplicity.
     */
    static async runNightlyBatch() {
        console.log("Starting Nightly Batch Asset Generation...");

        const report = {
            generated: 0,
            errors: 0,
            skipped: 0
        };

        // 1. Get all movements (Exercises & Meals)
        // We'll trust the "movements" table or unique names from training_exercises/meals
        // Actually, we need to know what SHOULD exist.

        // A. Exercises: Need dual-gender videos (Atlas + Nova)
        // We look for all unique exercise names
        const exerciseRows = await pool.query(
            `SELECT DISTINCT name FROM training_exercises WHERE name IS NOT NULL AND name != ''`
        );

        for (const row of exerciseRows.rows) {
            const name = row.name;
            const normalizedId = this.normalizeToId(name);

            // Check if Atlas video exists
            const atlasKey = `video_exercise_${normalizedId}_atlas`;
            const hasAtlas = await this.checkAssetExists(atlasKey);

            if (!hasAtlas) {
                console.log(`[Batch] Missing Atlas Video for ${name}`);
                // TODO: Generate or Queue
                // In this V1, we will just log it. 
                // To safely generate, we need the "script" or "prompt".
                // We could auto-draft prompts here?
                // For safety, we won't auto-generate from scratch in batch yet without a Blueprint.
                report.skipped++;
            }

            // Check if Nova video exists
            const novaKey = `video_exercise_${normalizedId}_nova`;
            const hasNova = await this.checkAssetExists(novaKey);
            if (!hasNova) {
                console.log(`[Batch] Missing Nova Video for ${name}`);
                report.skipped++;
            }

            // SYNC: Update the table columns if assets exist in cache
            if (hasAtlas || hasNova) {
                await this.syncExerciseVideos(row.id, name, normalizedId);
            }
        }

        // B. Meals
        const mealRows = await pool.query(`SELECT id, name FROM meals`);
        for (const row of mealRows.rows) {
            // For now just basic sync if we have ANY assets
            await this.syncMealVideos(row.id, row.name, this.normalizeToId(row.name));
        }

        console.log("Nightly Batch Complete", report);
        return report;
    }

    // --- SYNC HELPERS ---

    private static async syncExerciseVideos(dbId: string, name: string, normalizedId: string) {
        // Fetch URLs from cache
        const atlasKey = `video_exercise_${normalizedId}_atlas`;
        const novaKey = `video_exercise_${normalizedId}_nova`;

        const [atlasUrl, novaUrl] = await Promise.all([
            this.getAssetValue(atlasKey),
            this.getAssetValue(novaKey)
        ]);

        if (atlasUrl || novaUrl) {
            await pool.query(
                `UPDATE training_exercises SET video_atlas = COALESCE($1, video_atlas), video_nova = COALESCE($2, video_nova) WHERE name = $3`,
                [atlasUrl, novaUrl, name]
            );
            // console.log(`[Batch] Synced videos for ${name}`);
        }
    }

    private static async syncMealVideos(dbId: string, name: string, normalizedId: string) {
        // 1. Check Main Video
        // const mainKey = `video_meal_${normalizedId}_main`; // If we had one

        // 2. Check Step Videos (heuristic: check up to 10 steps)
        const stepMap: Record<string, string> = {};
        let foundAny = false;

        for (let i = 0; i < 15; i++) {
            // Try various step key formats if unaware
            // Standard: video_meal_{id}_step_{i} ?? 
            // Actually AssetLab uses: `meal_${id}_step_${i}` base key + type 'video' ??
            // Let's assume standard Asset Lab keys: 
            // Exercise: video_exercise_{id}_{gender}
            // Meal Step: video_meal_{id}_step_{i}  (if we enforce this convention)
            // Currently AssetLab generates based on "prompt" and maybe loose keys.
            // We need to enforce strict naming in AssetLab for this to work perfectly.
            // For now, let's assume `video_meal_${normalizedId}_step_${i}`

            const key = `video_meal_${normalizedId}_step_${i}`;
            const url = await this.getAssetValue(key);
            if (url) {
                stepMap[i.toString()] = url;
                foundAny = true;
            }
        }

        if (foundAny) {
            await pool.query(
                `UPDATE meals SET step_videos = step_videos || $1 WHERE id = $2`,
                [JSON.stringify(stepMap), dbId]
            );
        }
    }

    private static async getAssetValue(key: string): Promise<string | null> {
        const res = await pool.query(
            `SELECT value FROM cached_assets WHERE key=$1 LIMIT 1`,
            [key]
        );
        return res.rows[0]?.value || null;
    }


    /**
     * Trigger generation for specific pending assets if valid metadata exists
     * This is where we would actually call generateAsset()
     */
    static async processPendingQueue(limit: number = 5) {
        // Logic to pull from a "job_queue" table if we had one.
        // For now, let's keep it simple.
        return { processed: 0 };
    }

    private static normalizeToId(name: string): string {
        if (!name) return 'unknown';
        let clean = name.toLowerCase().trim();
        clean = clean.replace(/[^a-z0-9]+/g, ' ');
        const words = clean.split(' ').filter(w => w.length > 0).sort();
        return words.join('_');
    }

    private static async checkAssetExists(key: string): Promise<boolean> {
        const res = await pool.query(
            `SELECT 1 FROM cached_assets WHERE key=$1 AND status IN ('active', 'auto')`,
            [key]
        );
        return (res.rowCount || 0) > 0;
    }
}
