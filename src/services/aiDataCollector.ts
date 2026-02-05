/**
 * AI Data Collector - Lightweight client for AI Training Platform
 *
 * Fire-and-forget pattern: Sends data to AI platform without blocking main request
 * Completely decoupled from main app to maintain app store compliance
 */

import { createHash } from 'crypto';

// Environment variables (optional - disabled if not set)
const AI_PLATFORM_URL = process.env.AI_PLATFORM_URL;
const AI_PLATFORM_KEY = process.env.AI_PLATFORM_KEY;
const PSEUDONYM_SALT = process.env.PSEUDONYM_SALT || 'vitality-default-salt';

// PII patterns for stripping
const PII_PATTERNS = [
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi, // Email
    /(\+?\d{1,4}[\s.-]?)?\(?\d{1,4}\)?[\s.-]?\d{1,4}[\s.-]?\d{1,9}/g, // Phone
    /\b\d{11}\b/g, // Turkish TC Kimlik
];

/**
 * Generate pseudonym ID from user ID
 */
export function getPseudonymId(userId: string): string {
    return createHash('sha256')
        .update(userId + PSEUDONYM_SALT)
        .digest('hex')
        .substring(0, 32);
}

/**
 * Strip PII from text
 */
function stripPii(text: string): string {
    let result = text;
    for (const pattern of PII_PATTERNS) {
        result = result.replace(pattern, '[REDACTED]');
    }
    return result;
}

/**
 * Strip PII from object recursively
 */
function stripPiiFromObject<T>(data: T): T {
    if (data === null || data === undefined) return data;

    if (typeof data === 'string') {
        return stripPii(data) as T;
    }

    if (Array.isArray(data)) {
        return data.map(item => stripPiiFromObject(item)) as T;
    }

    if (typeof data === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(data)) {
            // Skip sensitive keys
            if (['password', 'token', 'secret', 'apiKey', 'authorization'].some(k =>
                key.toLowerCase().includes(k.toLowerCase())
            )) {
                result[key] = '[REDACTED]';
            } else {
                result[key] = stripPiiFromObject(value);
            }
        }
        return result as T;
    }

    return data;
}

export interface ApiCallData {
    userId: string;
    callType: string;
    apiProvider: string;
    modelVersion?: string;
    endpoint?: string;
    requestPrompt: string;
    requestContext?: Record<string, unknown>;
    responseRaw: unknown;
    responseParsed?: unknown;
    latencyMs?: number;
    tokenCountInput?: number;
    tokenCountOutput?: number;
}

/**
 * Record an API call to the AI training platform
 * Fire-and-forget: Does not block, silently fails
 */
export async function recordApiCall(data: ApiCallData): Promise<void> {
    // Skip if AI platform not configured
    if (!AI_PLATFORM_URL || !AI_PLATFORM_KEY) {
        return;
    }

    try {
        const payload = {
            userId: data.userId,
            callType: data.callType,
            apiProvider: data.apiProvider,
            modelVersion: data.modelVersion,
            endpoint: data.endpoint,
            requestPrompt: stripPii(data.requestPrompt),
            requestContext: data.requestContext ? stripPiiFromObject(data.requestContext) : undefined,
            responseRaw: stripPiiFromObject(data.responseRaw),
            responseParsed: data.responseParsed ? stripPiiFromObject(data.responseParsed) : undefined,
            latencyMs: data.latencyMs,
            tokenCountInput: data.tokenCountInput,
            tokenCountOutput: data.tokenCountOutput,
        };

        // Fire and forget - don't await
        fetch(`${AI_PLATFORM_URL}/ingest/api-call`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': AI_PLATFORM_KEY,
            },
            body: JSON.stringify(payload),
        }).catch(() => {}); // Silent fail

    } catch {
        // Silent fail - don't impact main app
    }
}

export interface FeedbackData {
    userId: string;
    apiCallId?: string;
    feedbackType: 'correction' | 'rating' | 'implicit' | 'report';
    originalOutput: unknown;
    correctedOutput?: unknown;
    rating?: number;
    wasAccepted?: boolean;
    wasModified?: boolean;
    timeToActionMs?: number;
    feedbackText?: string;
}

/**
 * Record user feedback on AI output
 * Fire-and-forget: Does not block, silently fails
 */
export async function recordFeedback(data: FeedbackData): Promise<void> {
    if (!AI_PLATFORM_URL || !AI_PLATFORM_KEY) {
        return;
    }

    try {
        const payload = {
            userId: data.userId,
            apiCallId: data.apiCallId,
            feedbackType: data.feedbackType,
            originalOutput: stripPiiFromObject(data.originalOutput),
            correctedOutput: data.correctedOutput ? stripPiiFromObject(data.correctedOutput) : undefined,
            rating: data.rating,
            wasAccepted: data.wasAccepted,
            wasModified: data.wasModified,
            timeToActionMs: data.timeToActionMs,
            feedbackText: data.feedbackText ? stripPii(data.feedbackText) : undefined,
        };

        fetch(`${AI_PLATFORM_URL}/feedback/record`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': AI_PLATFORM_KEY,
            },
            body: JSON.stringify(payload),
        }).catch(() => {});

    } catch {
        // Silent fail
    }
}

/**
 * Check if AI data collection is enabled
 */
export function isDataCollectionEnabled(): boolean {
    return !!(AI_PLATFORM_URL && AI_PLATFORM_KEY);
}
