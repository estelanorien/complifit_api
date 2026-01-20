import { Router } from 'express';
import { pool } from '../../../infra/db/pool.js';
import { AssetGenerationFacade } from '../../../application/services/AssetGenerationFacade.js';

const router = Router();

// Job tracking
const activeJobs = new Map<string, {
    id: string;
    status: 'running' | 'complete' | 'failed';
    total: number;
    completed: number;
    failed: number;
    currentItem: string;
    startedAt: Date;
    completedAt?: Date;
}>();

/**
 * GET /admin/assets/status
 * Get asset status for all exercises and meals
 */
router.get('/status', async (req, res) => {
    try {
        const { type = 'both', status = 'all' } = req.query;

        const items: any[] = [];

        // Fetch exercises
        if (type === 'ex' || type === 'both') {
            const exercises = await pool.query(`
                SELECT id, name 
                FROM training_exercises 
                WHERE name IS NOT NULL
                ORDER BY name
            `);

            for (const ex of exercises.rows) {
                const assetStatus = await AssetGenerationFacade.getAssetStatus('ex', ex.id);

                let itemStatus = 'empty';
                if (assetStatus.complete === assetStatus.total) {
                    itemStatus = 'complete';
                } else if (assetStatus.complete > 0) {
                    itemStatus = 'partial';
                } else if (assetStatus.failed > 0) {
                    itemStatus = 'failed';
                }

                if (status === 'all' || status === itemStatus) {
                    items.push({
                        type: 'ex',
                        id: ex.id,
                        name: ex.name,
                        status: itemStatus,
                        assets: assetStatus
                    });
                }
            }
        }

        // Fetch meals
        if (type === 'meal' || type === 'both') {
            const meals = await pool.query(`
                SELECT id, name 
                FROM meals 
                WHERE name IS NOT NULL
                ORDER BY name
            `);

            for (const meal of meals.rows) {
                const assetStatus = await AssetGenerationFacade.getAssetStatus('meal', meal.id);

                let itemStatus = 'empty';
                if (assetStatus.complete === assetStatus.total) {
                    itemStatus = 'complete';
                } else if (assetStatus.complete > 0) {
                    itemStatus = 'partial';
                } else if (assetStatus.failed > 0) {
                    itemStatus = 'failed';
                }

                if (status === 'all' || status === itemStatus) {
                    items.push({
                        type: 'meal',
                        id: meal.id,
                        name: meal.name,
                        status: itemStatus,
                        assets: assetStatus
                    });
                }
            }
        }

        res.json({ items, total: items.length });

    } catch (e: any) {
        console.error('[Admin] Asset status error:', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /admin/assets/generate
 * Start batch asset generation
 */
router.post('/generate', async (req, res) => {
    try {
        const { mode, type = 'both', ids = [], count = 10, status = 'empty' } = req.body;

        const jobId = `job_${Date.now()}`;
        let itemsToGenerate: Array<{ type: 'ex' | 'meal', id: string }> = [];

        // Mode: selected
        if (mode === 'selected' && ids.length > 0) {
            itemsToGenerate = ids.map((item: any) => ({
                type: item.type,
                id: item.id
            }));
        }
        // Mode: next N
        else if (mode === 'next') {
            const typeFilter = type === 'both' ? ['ex', 'meal'] : [type];

            for (const t of typeFilter) {
                const table = t === 'ex' ? 'training_exercises' : 'meals';
                const items = await pool.query(`
                    SELECT id, name FROM ${table} 
                    WHERE name IS NOT NULL 
                    ORDER BY created_at DESC
                    LIMIT $1
                `, [count]);

                for (const item of items.rows) {
                    const assetStatus = await AssetGenerationFacade.getAssetStatus(t as 'ex' | 'meal', item.id);

                    if (status === 'empty' && assetStatus.empty > 0) {
                        itemsToGenerate.push({ type: t as 'ex' | 'meal', id: item.id });
                    } else if (status === 'failed' && assetStatus.failed > 0) {
                        itemsToGenerate.push({ type: t as 'ex' | 'meal', id: item.id });
                    } else if (status === 'all') {
                        itemsToGenerate.push({ type: t as 'ex' | 'meal', id: item.id });
                    }

                    if (itemsToGenerate.length >= count) break;
                }
            }
        }
        // Mode: all empty
        else if (mode === 'all') {
            // This could be expensive, limit to 100
            const limit = Math.min(count, 100);
            const typeFilter = type === 'both' ? ['ex', 'meal'] : [type];

            for (const t of typeFilter) {
                const table = t === 'ex' ? 'training_exercises' : 'meals';
                const items = await pool.query(`
                    SELECT id FROM ${table} 
                    WHERE name IS NOT NULL 
                    LIMIT $1
                `, [limit]);

                for (const item of items.rows) {
                    const assetStatus = await AssetGenerationFacade.getAssetStatus(t as 'ex' | 'meal', item.id);

                    if (assetStatus.empty > 0 || assetStatus.failed > 0) {
                        itemsToGenerate.push({ type: t as 'ex' | 'meal', id: item.id });
                    }
                }
            }
        }

        // Initialize job tracking
        activeJobs.set(jobId, {
            id: jobId,
            status: 'running',
            total: itemsToGenerate.length,
            completed: 0,
            failed: 0,
            currentItem: '',
            startedAt: new Date()
        });

        // Start generation in background
        AssetGenerationFacade.generateBatch(itemsToGenerate, {
            sequential: true,
            delayMs: 2000,
            onProgress: (current, total, currentItem) => {
                const job = activeJobs.get(jobId);
                if (job) {
                    job.completed = current;
                    job.currentItem = currentItem;
                }
            }
        }).then(result => {
            const job = activeJobs.get(jobId);
            if (job) {
                job.status = 'complete';
                job.completed = result.completed;
                job.failed = result.failed;
                job.completedAt = new Date();
            }
        }).catch(e => {
            const job = activeJobs.get(jobId);
            if (job) {
                job.status = 'failed';
                job.completedAt = new Date();
            }
            console.error('[Admin] Batch generation failed:', e);
        });

        res.json({
            jobId,
            message: 'Generation started',
            itemCount: itemsToGenerate.length
        });

    } catch (e: any) {
        console.error('[Admin] Generate error:', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /admin/assets/progress/:jobId
 * Get progress of a running job
 */
router.get('/progress/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = activeJobs.get(jobId);

        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        res.json(job);

    } catch (e: any) {
        console.error('[Admin] Progress error:', e);
        res.status(500).json({ error: e.message });
    }
});

export default router;
