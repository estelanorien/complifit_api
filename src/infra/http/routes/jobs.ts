import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { jobProcessor } from '../../../application/services/jobProcessor.js';
import { AuthenticatedRequest } from '../types.js';

const submitJobSchema = z.object({
    type: z.enum(['IMAGE', 'MEAL_PLAN', 'MEAL_DETAILS', 'EXERCISE_GENERATION', 'MEAL_GENERATION', 'BATCH_ASSET_GENERATION']),
    payload: z.record(z.string(), z.unknown()),
    priority: z.number().min(1).max(3).optional().default(1), // 3=HIGH, 2=MEDIUM, 1=LOW
    jobKey: z.string().optional() // Canonical key for deduplication
});

export async function jobRoutes(app: FastifyInstance) {

    /**
     * Submit a new generation job
     * POST /jobs/submit
     * Body: { type, payload, priority?, jobKey? }
     * Returns: { jobId, status, isNew }
     */
    app.post('/jobs/submit', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const { type, payload, priority, jobKey } = submitJobSchema.parse(req.body);

        try {
            const result = await jobProcessor.submitJob(user.userId, type, payload, priority, jobKey);
            return reply.status(202).send({
                jobId: result.jobId,
                status: 'PENDING',
                isNew: result.isNew // false if this was a deduplicated request
            });
        } catch (e: unknown) {
            const error = e as Error;
            req.log.error({ error: 'Job submission failed', e });
            return reply.status(500).send({ error: error.message || 'Job submission failed' });
        }
    });

    /**
     * Get job status
     * GET /jobs/:id
     * Returns: { id, status, result?, error? }
     */
    app.get('/jobs/:id', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const { id } = req.params as { id: string };

        try {
            const job = await jobProcessor.getJobStatus(id, user.userId);
            if (!job) {
                return reply.status(404).send({ error: 'Job not found' });
            }
            return reply.send(job);
        } catch (e: unknown) {
            req.log.error({ error: 'Job status check failed', e });
            return reply.status(500).send({ error: 'Failed to check job status' });
        }
    });
}

