import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { jobProcessor } from '../../../application/services/jobProcessor.js';

const submitJobSchema = z.object({
    type: z.enum(['IMAGE', 'MEAL_PLAN', 'MEAL_DETAILS']),
    payload: z.record(z.any())
});

export async function jobRoutes(app: FastifyInstance) {

    app.post('/jobs/submit', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as any).user;
        const { type, payload } = submitJobSchema.parse(req.body);

        try {
            const jobId = await jobProcessor.submitJob(user.userId, type, payload);
            return reply.send({ jobId, status: 'PENDING' });
        } catch (e: any) {
            req.log.error({ error: 'Job submission failed', e });
            return reply.status(500).send({ error: e.message || 'Job submission failed' });
        }
    });

    app.get('/jobs/:id', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as any).user;
        const { id } = req.params as { id: string };

        try {
            const job = await jobProcessor.getJobStatus(id, user.userId);
            if (!job) {
                return reply.status(404).send({ error: 'Job not found' });
            }
            return reply.send(job);
        } catch (e: any) {
            req.log.error({ error: 'Job status check failed', e });
            return reply.status(500).send({ error: 'Failed to check job status' });
        }
    });
}
