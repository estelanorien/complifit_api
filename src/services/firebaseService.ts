import admin from 'firebase-admin';
import { env } from '../config/env.js';

let firebaseApp: admin.app.App | null = null;

/**
 * Initialize Firebase Admin SDK
 * Uses GOOGLE_APPLICATION_CREDENTIALS environment variable for authentication
 */
export function initializeFirebase(): boolean {
    if (firebaseApp) {
        return true; // Already initialized
    }

    try {
        // Firebase Admin SDK will automatically use GOOGLE_APPLICATION_CREDENTIALS
        // if no explicit credential is provided
        if (env.googleApplicationCredentials || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
            firebaseApp = admin.initializeApp({
                credential: admin.credential.applicationDefault()
            });
            console.log('[Firebase] Initialized with application default credentials');
            return true;
        } else {
            console.warn('[Firebase] GOOGLE_APPLICATION_CREDENTIALS not set. FCM will not work.');
            return false;
        }
    } catch (error) {
        console.error('[Firebase] Failed to initialize:', error);
        return false;
    }
}

/**
 * Check if Firebase is initialized
 */
export function isFirebaseInitialized(): boolean {
    return firebaseApp !== null;
}

/**
 * Send FCM notification to a single device
 */
export async function sendFcmNotification(
    token: string,
    title: string,
    body: string,
    data?: Record<string, string>,
    options?: {
        icon?: string;
        url?: string;
        actions?: Array<{ action: string; title: string }>;
    }
): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!firebaseApp) {
        return { success: false, error: 'Firebase not initialized' };
    }

    try {
        const message: admin.messaging.Message = {
            token,
            notification: {
                title,
                body
            },
            data: {
                ...data,
                ...(options?.url ? { url: options.url } : {}),
                ...(options?.actions ? { actions: JSON.stringify(options.actions) } : {})
            },
            android: {
                notification: {
                    icon: options?.icon || 'ic_notification',
                    clickAction: 'FLUTTER_NOTIFICATION_CLICK'
                }
            },
            apns: {
                payload: {
                    aps: {
                        badge: 1,
                        sound: 'default'
                    }
                }
            }
        };

        const response = await admin.messaging().send(message);
        return { success: true, messageId: response };
    } catch (error: any) {
        // Handle specific FCM errors
        if (error.code === 'messaging/registration-token-not-registered') {
            return { success: false, error: 'TOKEN_INVALID' };
        }
        if (error.code === 'messaging/invalid-registration-token') {
            return { success: false, error: 'TOKEN_INVALID' };
        }
        return { success: false, error: error.message };
    }
}

/**
 * Send FCM notifications to multiple devices
 */
export async function sendFcmNotificationBatch(
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
    options?: {
        icon?: string;
        url?: string;
        actions?: Array<{ action: string; title: string }>;
    }
): Promise<{ successCount: number; failureCount: number; invalidTokens: string[] }> {
    if (!firebaseApp) {
        return { successCount: 0, failureCount: tokens.length, invalidTokens: [] };
    }

    if (tokens.length === 0) {
        return { successCount: 0, failureCount: 0, invalidTokens: [] };
    }

    try {
        const message: admin.messaging.MulticastMessage = {
            tokens,
            notification: {
                title,
                body
            },
            data: {
                ...data,
                ...(options?.url ? { url: options.url } : {}),
                ...(options?.actions ? { actions: JSON.stringify(options.actions) } : {})
            },
            android: {
                notification: {
                    icon: options?.icon || 'ic_notification',
                    clickAction: 'FLUTTER_NOTIFICATION_CLICK'
                }
            },
            apns: {
                payload: {
                    aps: {
                        badge: 1,
                        sound: 'default'
                    }
                }
            }
        };

        const response = await admin.messaging().sendEachForMulticast(message);

        const invalidTokens: string[] = [];
        response.responses.forEach((resp, idx) => {
            if (!resp.success && resp.error) {
                const errorCode = resp.error.code;
                if (
                    errorCode === 'messaging/registration-token-not-registered' ||
                    errorCode === 'messaging/invalid-registration-token'
                ) {
                    invalidTokens.push(tokens[idx]);
                }
            }
        });

        return {
            successCount: response.successCount,
            failureCount: response.failureCount,
            invalidTokens
        };
    } catch (error: any) {
        console.error('[Firebase] Batch send failed:', error);
        return { successCount: 0, failureCount: tokens.length, invalidTokens: [] };
    }
}

/**
 * Subscribe tokens to a topic
 */
export async function subscribeToTopic(
    tokens: string[],
    topic: string
): Promise<{ successCount: number; failureCount: number }> {
    if (!firebaseApp) {
        return { successCount: 0, failureCount: tokens.length };
    }

    try {
        const response = await admin.messaging().subscribeToTopic(tokens, topic);
        return {
            successCount: response.successCount,
            failureCount: response.failureCount
        };
    } catch (error: any) {
        console.error('[Firebase] Topic subscribe failed:', error);
        return { successCount: 0, failureCount: tokens.length };
    }
}

/**
 * Unsubscribe tokens from a topic
 */
export async function unsubscribeFromTopic(
    tokens: string[],
    topic: string
): Promise<{ successCount: number; failureCount: number }> {
    if (!firebaseApp) {
        return { successCount: 0, failureCount: tokens.length };
    }

    try {
        const response = await admin.messaging().unsubscribeFromTopic(tokens, topic);
        return {
            successCount: response.successCount,
            failureCount: response.failureCount
        };
    } catch (error: any) {
        console.error('[Firebase] Topic unsubscribe failed:', error);
        return { successCount: 0, failureCount: tokens.length };
    }
}

/**
 * Send notification to a topic
 */
export async function sendToTopic(
    topic: string,
    title: string,
    body: string,
    data?: Record<string, string>
): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!firebaseApp) {
        return { success: false, error: 'Firebase not initialized' };
    }

    try {
        const message: admin.messaging.Message = {
            topic,
            notification: {
                title,
                body
            },
            data
        };

        const response = await admin.messaging().send(message);
        return { success: true, messageId: response };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
}
