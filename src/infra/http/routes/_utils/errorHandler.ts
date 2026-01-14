import { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Higher-order function to wrap route handlers with consistent error handling.
 * This simplifies route implementations by removing repetitive try-catch blocks.
 */
export function withErrorHandler(handler: (req: FastifyRequest, reply: FastifyReply) => Promise<any>) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
        try {
            return await handler(req, reply);
        } catch (error: any) {
            req.log.error(error);

            const statusCode = error.statusCode || 500;
            const message = error.message || 'Internal Server Error';

            return reply.status(statusCode).send({
                error: message,
                ...(process.env.NODE_ENV !== 'production' && { stack: error.stack })
            });
        }
    };
}
