/**
 * Debug Logger - Structured logging for development and observability
 *
 * Following Boris Cherny's approach:
 * - Development: Detailed logs to console with context
 * - Production: Structured logs to proper logging infrastructure
 * - Never swallow errors silently
 */

import { logger } from '../logger.js';

const isDev = process.env.NODE_ENV !== 'production';

export interface DebugContext {
    location: string;
    message: string;
    data?: Record<string, unknown>;
    hypothesisId?: string;
}

/**
 * Log debug information in a structured way.
 * In development: logs to console with full context
 * In production: logs to structured logger at debug level
 */
export function debugLog(context: DebugContext): void {
    const logContext = {
        ...context.data,
        hypothesisId: context.hypothesisId,
        timestamp: Date.now(),
        env: process.env.NODE_ENV || 'development'
    };

    logger.debug(`[DEBUG] ${context.location}: ${context.message}`, logContext);
}

/**
 * Log an error with context - NEVER silently swallow errors
 */
export function debugError(location: string, error: Error | unknown, context?: Record<string, unknown>): void {
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error(`[ERROR] ${location}: ${errorMessage}`, error, {
        ...context,
        location,
        timestamp: Date.now()
    });
}

/**
 * Wrap an async function with error logging - ensures errors are never silent
 */
export async function withDebugContext<T>(
    location: string,
    fn: () => Promise<T>,
    context?: Record<string, unknown>
): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        debugError(location, error, context);
        throw error; // Re-throw to maintain error flow
    }
}
