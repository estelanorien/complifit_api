/**
 * Generation Routes - API endpoints for the unified generation pipeline
 *
 * Provides endpoints for:
 * - User-triggered generation (fast path for user clicks)
 * - Full pipeline execution
 * - Pipeline status tracking
 * - Dead-letter queue management
 * - Identity verification statistics
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
import { userTriggeredGenerationService } from '../../../application/services/UserTriggeredGenerationService.js';
import { unifiedGenerationPipeline } from '../../../application/services/UnifiedGenerationPipeline.js';
import { retryManager } from '../../../application/services/RetryManager.js';
import { identityVerificationService } from '../../../application/services/IdentityVerificationService.js';
import { AuthenticatedRequest } from '../types.js';

// ============================================================================
// Schemas
// ============================================================================

const userTriggerSchema = z.object({
    entityType: z.enum(['ex', 'meal']),
    entityName: z.string().min(1),
    entityId: z.string().optional(),
    preferredCoach: z.enum(['atlas', 'nova']).default('atlas')
});

const pipelineSchema = z.object({
    entityType: z.enum(['ex', 'meal']),
    entityId: z.string().min(1),
    entityName: z.string().min(1),
    stepCount: z.number().min(1).max(15).optional(),
    priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).default('MEDIUM'),
    options: z.object({
        skipMeta: z.boolean().optional(),
        skipImages: z.boolean().optional(),
        skipVideos: z.boolean().optional(),
        skipTranslations: z.boolean().optional(),
        onlyPersona: z.enum(['atlas', 'nova', 'mannequin', 'none']).optional(),
        verifyIdentity: z.boolean().optional(),
        maxRetries: z.number().min(1).max(10).optional()
    }).optional()
});

const pregenerateSchema = z.object({
    items: z.array(z.object({
        entityType: z.enum(['ex', 'meal']),
        entityName: z.string().min(1)
    })).min(1).max(100),
    preferredCoach: z.enum(['atlas', 'nova']).default('atlas')
});

// ============================================================================
// Routes
// ============================================================================

export async function generationRoutes(app: FastifyInstance) {

    // ------------------------------------------------------------------------
    // User-Triggered Generation (Fast Path)
    // ------------------------------------------------------------------------

    /**
     * Generate assets for user interaction - optimized for speed
     * POST /generation/user-triggered
     * Returns primary image quickly, queues full pipeline in background
     */
    app.post('/generation/user-triggered', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const { entityType, entityName, entityId, preferredCoach } = userTriggerSchema.parse(req.body);

        try {
            const result = await userTriggeredGenerationService.generateForUser({
                userId: user.userId,
                entityType,
                entityName,
                entityId,
                preferredCoach
            });

            return reply.send({
                success: !result.error,
                found: result.found,
                generated: result.generated,
                primaryImageUrl: result.primaryImageUrl,
                secondaryImageUrl: result.secondaryImageUrl,
                pipelineJobId: result.pipelineJobId,
                error: result.error
            });
        } catch (e: unknown) {
            req.log.error({ error: 'User-triggered generation failed', e });
            return reply.status(500).send({ error: e.message || 'Generation failed' });
        }
    });

    /**
     * Pre-generate assets for multiple items (onboarding, plan creation)
     * POST /generation/pregenerate
     */
    app.post('/generation/pregenerate', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const { items, preferredCoach } = pregenerateSchema.parse(req.body);

        try {
            const result = await userTriggeredGenerationService.pregenerateForPlan(
                user.userId,
                items,
                preferredCoach
            );

            return reply.send({
                success: true,
                queued: result.queued,
                alreadyExists: result.alreadyExists
            });
        } catch (e: unknown) {
            req.log.error({ error: 'Pregeneration failed', e });
            return reply.status(500).send({ error: e.message || 'Pregeneration failed' });
        }
    });

    // ------------------------------------------------------------------------
    // Full Pipeline Execution (Admin)
    // ------------------------------------------------------------------------

    /**
     * Execute full generation pipeline
     * POST /generation/pipeline
     * Admin only - runs complete pipeline synchronously
     */
    app.post('/generation/pipeline', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;

        // Check admin role (simplified - you may have a proper admin check)
        const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [user.userId]);
        if (rows[0]?.role !== 'admin') {
            return reply.status(403).send({ error: 'Admin access required' });
        }

        const { entityType, entityId, entityName, stepCount, priority, options } = pipelineSchema.parse(req.body);

        try {
            const result = await unifiedGenerationPipeline.execute({
                entityType,
                entityId,
                entityName,
                stepCount,
                priority,
                triggeredBy: 'admin',
                userId: user.userId,
                options
            });

            return reply.send(result);
        } catch (e: unknown) {
            req.log.error({ error: 'Pipeline execution failed', e });
            return reply.status(500).send({ error: e.message || 'Pipeline failed' });
        }
    });

    // ------------------------------------------------------------------------
    // Pipeline Status
    // ------------------------------------------------------------------------

    /**
     * Get pipeline status for an entity
     * GET /generation/pipeline/:entityKey/status
     */
    app.get('/generation/pipeline/:entityKey/status', { preHandler: authGuard }, async (req, reply) => {
        const { entityKey } = req.params as { entityKey: string };

        try {
            const { rows } = await pool.query(
                `SELECT * FROM pipeline_status WHERE entity_key = $1`,
                [entityKey]
            );

            if (rows.length === 0) {
                return reply.status(404).send({ error: 'Pipeline status not found' });
            }

            return reply.send(rows[0]);
        } catch (e: unknown) {
            req.log.error({ error: 'Failed to get pipeline status', e });
            return reply.status(500).send({ error: 'Failed to get pipeline status' });
        }
    });

    /**
     * List incomplete pipelines
     * GET /generation/pipeline/incomplete
     */
    app.get('/generation/pipeline/incomplete', { preHandler: authGuard }, async (req, reply) => {
        const { entityType, limit = 50 } = req.query as { entityType?: string; limit?: number };

        try {
            let query = `
                SELECT * FROM pipeline_status
                WHERE completed_at IS NULL
            `;
            const params: string[] = [];

            if (entityType) {
                query += ` AND entity_type = $1`;
                params.push(entityType);
            }

            query += ` ORDER BY created_at DESC LIMIT ${Math.min(limit, 200)}`;

            const { rows } = await pool.query(query, params);
            return reply.send({ pipelines: rows, count: rows.length });
        } catch (e: unknown) {
            req.log.error({ error: 'Failed to list pipelines', e });
            return reply.status(500).send({ error: 'Failed to list pipelines' });
        }
    });

    // ------------------------------------------------------------------------
    // Dead Letter Queue (Admin)
    // ------------------------------------------------------------------------

    /**
     * Get dead-letter queue entries
     * GET /generation/dead-letter
     */
    app.get('/generation/dead-letter', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;

        // Check admin role
        const { rows: userRows } = await pool.query('SELECT role FROM users WHERE id = $1', [user.userId]);
        if (userRows[0]?.role !== 'admin') {
            return reply.status(403).send({ error: 'Admin access required' });
        }

        const { taskType, canRetryOnly, limit = 50, offset = 0 } = req.query as {
            taskType?: string;
            canRetryOnly?: string;
            limit?: number;
            offset?: number;
        };

        try {
            const entries = await retryManager.getDeadLetterEntries({
                taskType,
                canRetryOnly: canRetryOnly === 'true',
                limit: Math.min(limit, 200),
                offset
            });

            const stats = await retryManager.getDeadLetterStats();

            return reply.send({ entries, stats });
        } catch (e: unknown) {
            req.log.error({ error: 'Failed to get dead-letter entries', e });
            return reply.status(500).send({ error: 'Failed to get dead-letter queue' });
        }
    });

    /**
     * Retry a dead-letter entry
     * POST /generation/dead-letter/:id/retry
     */
    app.post('/generation/dead-letter/:id/retry', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const { id } = req.params as { id: string };

        // Check admin role
        const { rows: userRows } = await pool.query('SELECT role FROM users WHERE id = $1', [user.userId]);
        if (userRows[0]?.role !== 'admin') {
            return reply.status(403).send({ error: 'Admin access required' });
        }

        try {
            const entry = await retryManager.prepareDeadLetterRetry(id);
            if (!entry) {
                return reply.status(404).send({ error: 'Entry not found or cannot be retried' });
            }

            // Queue the task for retry based on type
            // The actual retry will be handled by the appropriate queue service
            return reply.send({
                success: true,
                message: 'Entry prepared for retry',
                entry
            });
        } catch (e: unknown) {
            req.log.error({ error: 'Failed to retry dead-letter entry', e });
            return reply.status(500).send({ error: 'Failed to retry entry' });
        }
    });

    /**
     * Resolve a dead-letter entry (mark as handled)
     * POST /generation/dead-letter/:id/resolve
     */
    app.post('/generation/dead-letter/:id/resolve', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const { id } = req.params as { id: string };
        const { notes } = req.body as { notes?: string };

        // Check admin role
        const { rows: userRows } = await pool.query('SELECT role FROM users WHERE id = $1', [user.userId]);
        if (userRows[0]?.role !== 'admin') {
            return reply.status(403).send({ error: 'Admin access required' });
        }

        try {
            await retryManager.resolveDeadLetterEntry(id, user.userId, notes);
            return reply.send({ success: true, message: 'Entry resolved' });
        } catch (e: unknown) {
            req.log.error({ error: 'Failed to resolve dead-letter entry', e });
            return reply.status(500).send({ error: 'Failed to resolve entry' });
        }
    });

    // ------------------------------------------------------------------------
    // Identity Verification Stats (Admin)
    // ------------------------------------------------------------------------

    /**
     * Get identity verification statistics
     * GET /generation/identity-stats
     */
    app.get('/generation/identity-stats', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const { days = 7 } = req.query as { days?: number };

        // Check admin role
        const { rows: userRows } = await pool.query('SELECT role FROM users WHERE id = $1', [user.userId]);
        if (userRows[0]?.role !== 'admin') {
            return reply.status(403).send({ error: 'Admin access required' });
        }

        try {
            const stats = await identityVerificationService.getStats(Math.min(days, 90));
            return reply.send(stats);
        } catch (e: unknown) {
            req.log.error({ error: 'Failed to get identity stats', e });
            return reply.status(500).send({ error: 'Failed to get identity statistics' });
        }
    });
}
