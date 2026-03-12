/**
 * RetryManager - Centralized retry logic with exponential backoff and dead-letter queue
 *
 * This service provides:
 * - Configurable retry with exponential backoff
 * - Dead-letter queue for permanently failed tasks
 * - Manual retry capabilities for dead-letter items
 * - Task-type specific configurations
 */

import { pool } from '../../infra/db/pool.js';
import { logger } from '../../infra/logger.js';

// ============================================================================
// Types
// ============================================================================

export interface RetryConfig {
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
    retryableErrors: string[];
}

export interface RetryableTask<T> {
    id: string;
    type: 'image' | 'video' | 'translation' | 'pipeline';
    entityKey?: string;
    execute: () => Promise<T>;
    onRetry?: (attempt: number, error: Error, delayMs: number) => Promise<void>;
    onSuccess?: (result: T, attempts: number) => Promise<void>;
    onFailure?: (error: Error, attempts: number) => Promise<void>;
}

export interface DeadLetterEntry {
    id: string;
    originalId: string | null;
    taskType: string;
    entityKey: string | null;
    payload: any;
    errorMessage: string;
    attemptCount: number;
    canRetry: boolean;
    createdAt: Date;
}

// ============================================================================
// Default Configurations
// ============================================================================

const DEFAULT_RETRY_CONFIGS: Record<string, RetryConfig> = {
    image: {
        maxAttempts: 5,
        initialDelayMs: 2000,
        maxDelayMs: 60000,
        backoffMultiplier: 2,
        retryableErrors: ['429', '503', 'overloaded', 'quota', 'rate', 'timeout', 'UNAVAILABLE', 'RESOURCE_EXHAUSTED']
    },
    video: {
        maxAttempts: 3,
        initialDelayMs: 5000,
        maxDelayMs: 120000,
        backoffMultiplier: 2,
        retryableErrors: ['429', '503', 'overloaded', 'quota', 'rate', 'timeout', 'UNAVAILABLE']
    },
    translation: {
        maxAttempts: 5,
        initialDelayMs: 1000,
        maxDelayMs: 30000,
        backoffMultiplier: 2,
        retryableErrors: ['429', '503', 'overloaded', 'quota', 'rate', 'timeout', 'UNAVAILABLE']
    },
    pipeline: {
        maxAttempts: 3,
        initialDelayMs: 3000,
        maxDelayMs: 60000,
        backoffMultiplier: 2,
        retryableErrors: ['429', '503', 'overloaded', 'quota', 'rate', 'timeout', 'UNAVAILABLE']
    }
};

// ============================================================================
// RetryManager Class
// ============================================================================

export class RetryManager {
    private static instance: RetryManager;

    private constructor() {}

    static getInstance(): RetryManager {
        if (!RetryManager.instance) {
            RetryManager.instance = new RetryManager();
        }
        return RetryManager.instance;
    }

    // ------------------------------------------------------------------------
    // Core Retry Logic
    // ------------------------------------------------------------------------

    /**
     * Execute a task with retry logic and exponential backoff.
     * If all retries fail, moves the task to dead-letter queue.
     */
    async executeWithRetry<T>(
        task: RetryableTask<T>,
        customConfig?: Partial<RetryConfig>
    ): Promise<T> {
        const config = this.getConfig(task.type, customConfig);
        let lastError: Error = new Error('Unknown error');
        let attempt = 0;

        while (attempt < config.maxAttempts) {
            attempt++;

            try {
                logger.debug(`[RetryManager] Attempt ${attempt}/${config.maxAttempts} for task ${task.id} (${task.type})`);
                const result = await task.execute();

                // Success!
                if (task.onSuccess) {
                    await task.onSuccess(result, attempt);
                }

                if (attempt > 1) {
                    logger.info(`[RetryManager] Task ${task.id} succeeded on attempt ${attempt}`);
                }

                return result;
            } catch (error: any) {
                lastError = error instanceof Error ? error : new Error(String(error));
                const isRetryable = this.isRetryableError(lastError, config.retryableErrors);

                logger.warn(`[RetryManager] Task ${task.id} failed attempt ${attempt}: ${lastError.message} (retryable: ${isRetryable})`);

                if (!isRetryable) {
                    // Non-retryable error, fail immediately
                    break;
                }

                if (attempt < config.maxAttempts) {
                    const delayMs = this.calculateDelay(attempt, config);

                    if (task.onRetry) {
                        await task.onRetry(attempt, lastError, delayMs);
                    }

                    logger.info(`[RetryManager] Retrying task ${task.id} in ${delayMs}ms...`);
                    await this.sleep(delayMs);
                }
            }
        }

        // All retries exhausted - move to dead-letter queue
        await this.moveToDeadLetter(
            task.id,
            task.type,
            task.entityKey || null,
            { taskId: task.id, type: task.type, entityKey: task.entityKey },
            lastError.message,
            lastError.stack || null,
            attempt
        );

        if (task.onFailure) {
            await task.onFailure(lastError, attempt);
        }

        throw lastError;
    }

    /**
     * Simple retry wrapper for functions without full task context
     */
    async retry<T>(
        fn: () => Promise<T>,
        taskType: 'image' | 'video' | 'translation' | 'pipeline',
        taskId: string,
        customConfig?: Partial<RetryConfig>
    ): Promise<T> {
        return this.executeWithRetry({
            id: taskId,
            type: taskType,
            execute: fn
        }, customConfig);
    }

    // ------------------------------------------------------------------------
    // Dead Letter Queue Operations
    // ------------------------------------------------------------------------

    /**
     * Move a failed task to the dead-letter queue
     */
    async moveToDeadLetter(
        originalId: string | null,
        taskType: string,
        entityKey: string | null,
        payload: any,
        errorMessage: string,
        errorStack: string | null,
        attemptCount: number
    ): Promise<string> {
        try {
            const result = await pool.query(
                `INSERT INTO dead_letter_queue (
                    original_id, task_type, entity_key, payload, error_message, error_stack,
                    attempt_count, first_failure_at, last_failure_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
                RETURNING id`,
                [originalId, taskType, entityKey, JSON.stringify(payload), errorMessage, errorStack, attemptCount]
            );

            const dlqId = result.rows[0].id;
            logger.error(`[RetryManager] Task moved to dead-letter queue: ${dlqId} (original: ${originalId}, type: ${taskType})`);
            return dlqId;
        } catch (err: any) {
            logger.error(`[RetryManager] Failed to move task to dead-letter queue: ${err.message}`);
            throw err;
        }
    }

    /**
     * Get dead-letter queue entries
     */
    async getDeadLetterEntries(options?: {
        taskType?: string;
        canRetryOnly?: boolean;
        limit?: number;
        offset?: number;
    }): Promise<DeadLetterEntry[]> {
        const conditions: string[] = [];
        const params: any[] = [];
        let paramIndex = 1;

        if (options?.taskType) {
            conditions.push(`task_type = $${paramIndex++}`);
            params.push(options.taskType);
        }

        if (options?.canRetryOnly) {
            conditions.push(`can_retry = true`);
            conditions.push(`resolved_at IS NULL`);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const limit = options?.limit || 100;
        const offset = options?.offset || 0;

        const result = await pool.query(
            `SELECT id, original_id, task_type, entity_key, payload, error_message,
                    attempt_count, can_retry, created_at
             FROM dead_letter_queue
             ${whereClause}
             ORDER BY created_at DESC
             LIMIT ${limit} OFFSET ${offset}`,
            params
        );

        return result.rows.map(row => ({
            id: row.id,
            originalId: row.original_id,
            taskType: row.task_type,
            entityKey: row.entity_key,
            payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
            errorMessage: row.error_message,
            attemptCount: row.attempt_count,
            canRetry: row.can_retry,
            createdAt: row.created_at
        }));
    }

    /**
     * Retry a dead-letter queue entry
     * Returns the entry for manual execution - does not execute automatically
     */
    async prepareDeadLetterRetry(dlqId: string): Promise<DeadLetterEntry | null> {
        const result = await pool.query(
            `SELECT * FROM dead_letter_queue WHERE id = $1 AND can_retry = true AND resolved_at IS NULL`,
            [dlqId]
        );

        if (result.rows.length === 0) {
            return null;
        }

        // Mark as being retried
        await pool.query(
            `UPDATE dead_letter_queue
             SET attempt_count = attempt_count + 1, last_failure_at = now()
             WHERE id = $1`,
            [dlqId]
        );

        const row = result.rows[0];
        return {
            id: row.id,
            originalId: row.original_id,
            taskType: row.task_type,
            entityKey: row.entity_key,
            payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
            errorMessage: row.error_message,
            attemptCount: row.attempt_count + 1,
            canRetry: row.can_retry,
            createdAt: row.created_at
        };
    }

    /**
     * Mark a dead-letter entry as resolved
     */
    async resolveDeadLetterEntry(
        dlqId: string,
        resolvedBy: string | null,
        notes?: string
    ): Promise<void> {
        await pool.query(
            `UPDATE dead_letter_queue
             SET resolved_at = now(), resolved_by = $2, resolution_notes = $3, can_retry = false
             WHERE id = $1`,
            [dlqId, resolvedBy, notes || null]
        );
        logger.info(`[RetryManager] Dead-letter entry ${dlqId} resolved`);
    }

    /**
     * Disable retry for a dead-letter entry
     */
    async disableRetry(dlqId: string, reason?: string): Promise<void> {
        await pool.query(
            `UPDATE dead_letter_queue
             SET can_retry = false, resolution_notes = $2
             WHERE id = $1`,
            [dlqId, reason || 'Retry disabled manually']
        );
        logger.info(`[RetryManager] Retry disabled for dead-letter entry ${dlqId}`);
    }

    /**
     * Get dead-letter queue statistics
     */
    async getDeadLetterStats(): Promise<{
        total: number;
        byType: Record<string, number>;
        canRetry: number;
        resolved: number;
    }> {
        const result = await pool.query(`
            SELECT
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE can_retry = true AND resolved_at IS NULL) as can_retry,
                COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) as resolved
            FROM dead_letter_queue
        `);

        const byTypeResult = await pool.query(`
            SELECT task_type, COUNT(*) as count
            FROM dead_letter_queue
            WHERE resolved_at IS NULL
            GROUP BY task_type
        `);

        const byType: Record<string, number> = {};
        for (const row of byTypeResult.rows) {
            byType[row.task_type] = parseInt(row.count, 10);
        }

        return {
            total: parseInt(result.rows[0].total, 10),
            canRetry: parseInt(result.rows[0].can_retry, 10),
            resolved: parseInt(result.rows[0].resolved, 10),
            byType
        };
    }

    // ------------------------------------------------------------------------
    // Utility Methods
    // ------------------------------------------------------------------------

    /**
     * Check if an error is retryable based on configured patterns
     */
    isRetryableError(error: Error, retryablePatterns: string[]): boolean {
        const errorMessage = error.message.toLowerCase();
        const errorName = error.name?.toLowerCase() || '';

        return retryablePatterns.some(pattern => {
            const lowerPattern = pattern.toLowerCase();
            return errorMessage.includes(lowerPattern) || errorName.includes(lowerPattern);
        });
    }

    /**
     * Calculate delay with exponential backoff
     */
    private calculateDelay(attempt: number, config: RetryConfig): number {
        const delay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);
        // Add jitter (±10%) to prevent thundering herd
        const jitter = delay * 0.1 * (Math.random() * 2 - 1);
        return Math.min(delay + jitter, config.maxDelayMs);
    }

    /**
     * Get configuration for a task type, merged with custom config
     */
    private getConfig(taskType: string, customConfig?: Partial<RetryConfig>): RetryConfig {
        const defaultConfig = DEFAULT_RETRY_CONFIGS[taskType] || DEFAULT_RETRY_CONFIGS.image;
        return {
            ...defaultConfig,
            ...customConfig
        };
    }

    /**
     * Sleep helper
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Export singleton instance
export const retryManager = RetryManager.getInstance();

// Export helper function for simpler usage
export async function withRetry<T>(
    fn: () => Promise<T>,
    taskType: 'image' | 'video' | 'translation' | 'pipeline',
    taskId: string,
    config?: Partial<RetryConfig>
): Promise<T> {
    return retryManager.retry(fn, taskType, taskId, config);
}
