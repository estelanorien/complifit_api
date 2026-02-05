import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { env } from '../../../config/env.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import fetch from 'node-fetch';
import { sendPasswordResetEmail, isEmailConfigured } from '../../../services/emailService.js';
import jwksClient from 'jwks-rsa';

// Apple JWKS client for JWT signature verification
const appleJwksClient = jwksClient({
    jwksUri: 'https://appleid.apple.com/auth/keys',
    cache: true,
    cacheMaxAge: 86400000, // 24 hours
    rateLimit: true,
    jwksRequestsPerMinute: 10
});

// Helper to get Apple signing key
const getAppleSigningKey = (kid: string): Promise<string> => {
    return new Promise((resolve, reject) => {
        appleJwksClient.getSigningKey(kid, (err, key) => {
            if (err) {
                reject(err);
                return;
            }
            if (!key) {
                reject(new Error('No signing key found'));
                return;
            }
            const signingKey = key.getPublicKey();
            resolve(signingKey);
        });
    });
};

// Helper to verify Apple JWT with full signature verification
const verifyAppleToken = async (identityToken: string): Promise<{
    sub: string;
    email?: string;
    email_verified?: string;
    iss: string;
    aud: string;
    exp: number;
}> => {
    // First decode header to get the key ID (kid)
    const decodedHeader = jwt.decode(identityToken, { complete: true });
    if (!decodedHeader || typeof decodedHeader === 'string' || !decodedHeader.header.kid) {
        throw new Error('Invalid token: cannot decode header');
    }

    const kid = decodedHeader.header.kid;

    // Get the signing key from Apple's JWKS endpoint
    const signingKey = await getAppleSigningKey(kid);

    // Verify the token with the signing key
    const verified = jwt.verify(identityToken, signingKey, {
        algorithms: ['RS256'],
        issuer: 'https://appleid.apple.com',
        audience: env.oauth.apple.clientId
    }) as {
        sub: string;
        email?: string;
        email_verified?: string;
        iss: string;
        aud: string;
        exp: number;
    };

    return verified;
};

// Helper to issue JWT token
const issueToken = (payload: { userId: string; email: string }) => {
    return jwt.sign(payload, env.jwtSecret, { expiresIn: '6h' });
};

// Find or create user from social login
const findOrCreateSocialUser = async (
    email: string,
    provider: string,
    providerId: string,
    fullName?: string
) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Check if user exists
        const existing = await client.query(
            'SELECT id, email, username FROM users WHERE email = $1',
            [email.toLowerCase()]
        );

        if (existing.rows.length > 0) {
            await client.query('COMMIT');
            return existing.rows[0];
        }

        // Create new user (no password for social login)
        const username = email.split('@')[0].toLowerCase() + '_' + Math.random().toString(36).substring(2, 6);
        const result = await client.query(
            `INSERT INTO users (email, username, password_hash, created_at)
             VALUES ($1, $2, $3, NOW())
             RETURNING id, email, username`,
            [email.toLowerCase(), username, `social:${provider}:${providerId}`]
        );

        // Create user profile
        await client.query(
            `INSERT INTO user_profiles (user_id, profile_data)
             VALUES ($1, $2)`,
            [result.rows[0].id, JSON.stringify({ fullName, authProvider: provider })]
        );

        await client.query('COMMIT');
        return result.rows[0];
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
};

export async function socialAuthRoutes(app: FastifyInstance) {

    // ================== GOOGLE OAUTH ==================
    app.post('/auth/google', async (req, reply) => {
        if (!env.oauth.google.clientId) {
            return reply.status(503).send({
                error: 'Google login not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.'
            });
        }

        const body = z.object({
            idToken: z.string().min(1)
        }).parse(req.body);

        try {
            // Verify Google ID token
            const googleResponse = await fetch(
                `https://oauth2.googleapis.com/tokeninfo?id_token=${body.idToken}`
            );

            if (!googleResponse.ok) {
                return reply.status(401).send({ error: 'Invalid Google token' });
            }

            const googleUser = await googleResponse.json() as {
                email: string;
                sub: string;
                name?: string;
                email_verified?: string;
            };

            if (!googleUser.email) {
                return reply.status(400).send({ error: 'Email not provided by Google' });
            }

            // Find or create user
            const user = await findOrCreateSocialUser(
                googleUser.email,
                'google',
                googleUser.sub,
                googleUser.name
            );

            const token = issueToken({ userId: user.id, email: user.email });

            req.log.info({
                type: 'social_login',
                provider: 'google',
                userId: user.id,
                email: user.email
            });

            return { user, token };
        } catch (e: any) {
            req.log.error({ error: 'Google auth failed', message: e.message });
            return reply.status(500).send({ error: 'Google authentication failed' });
        }
    });

    // ================== FACEBOOK OAUTH ==================
    app.post('/auth/facebook', async (req, reply) => {
        if (!env.oauth.facebook.appId) {
            return reply.status(503).send({
                error: 'Facebook login not configured. Set FACEBOOK_APP_ID and FACEBOOK_APP_SECRET.'
            });
        }

        const body = z.object({
            accessToken: z.string().min(1)
        }).parse(req.body);

        try {
            // Verify Facebook access token and get user info
            const fbResponse = await fetch(
                `https://graph.facebook.com/me?access_token=${body.accessToken}&fields=id,email,name`
            );

            if (!fbResponse.ok) {
                return reply.status(401).send({ error: 'Invalid Facebook token' });
            }

            const fbUser = await fbResponse.json() as {
                id: string;
                email?: string;
                name?: string;
            };

            if (!fbUser.email) {
                return reply.status(400).send({ error: 'Email not provided by Facebook. Please allow email access.' });
            }

            // Find or create user
            const user = await findOrCreateSocialUser(
                fbUser.email,
                'facebook',
                fbUser.id,
                fbUser.name
            );

            const token = issueToken({ userId: user.id, email: user.email });

            req.log.info({
                type: 'social_login',
                provider: 'facebook',
                userId: user.id,
                email: user.email
            });

            return { user, token };
        } catch (e: any) {
            req.log.error({ error: 'Facebook auth failed', message: e.message });
            return reply.status(500).send({ error: 'Facebook authentication failed' });
        }
    });

    // ================== APPLE OAUTH ==================
    app.post('/auth/apple', async (req, reply) => {
        if (!env.oauth.apple.clientId) {
            return reply.status(503).send({
                error: 'Apple login not configured. Set APPLE_CLIENT_ID, APPLE_TEAM_ID, and APPLE_KEY_ID.'
            });
        }

        const body = z.object({
            identityToken: z.string().min(1),
            authorizationCode: z.string().min(1),
            user: z.object({
                email: z.string().email().optional(),
                name: z.object({
                    firstName: z.string().optional(),
                    lastName: z.string().optional()
                }).optional()
            }).optional()
        }).parse(req.body);

        try {
            // Verify Apple identity token with full cryptographic signature verification
            let decoded: {
                sub: string;
                email?: string;
                email_verified?: string;
                iss: string;
                aud: string;
                exp: number;
            };

            try {
                decoded = await verifyAppleToken(body.identityToken);
            } catch (verifyError: any) {
                req.log.warn({
                    type: 'apple_token_verification_failed',
                    error: verifyError.message
                });
                return reply.status(401).send({
                    error: 'Invalid Apple token: Signature verification failed'
                });
            }

            // Apple may not always provide email (only on first login)
            const email = decoded.email || body.user?.email;
            if (!email) {
                return reply.status(400).send({
                    error: 'Email not provided. Apple only shares email on first login.'
                });
            }

            const fullName = body.user?.name
                ? `${body.user.name.firstName || ''} ${body.user.name.lastName || ''}`.trim()
                : undefined;

            // Find or create user
            const user = await findOrCreateSocialUser(
                email,
                'apple',
                decoded.sub,
                fullName
            );

            const token = issueToken({ userId: user.id, email: user.email });

            req.log.info({
                type: 'social_login',
                provider: 'apple',
                userId: user.id,
                email: user.email
            });

            return { user, token };
        } catch (e: any) {
            req.log.error({ error: 'Apple auth failed', message: e.message });
            return reply.status(500).send({ error: 'Apple authentication failed' });
        }
    });

    // ================== PASSWORD RESET REQUEST ==================
    app.post('/auth/request-password-reset', async (req, reply) => {
        const body = z.object({
            email: z.string().email()
        }).parse(req.body);

        try {
            // Check if user exists
            const userCheck = await pool.query(
                'SELECT id, email FROM users WHERE LOWER(email) = $1',
                [body.email.toLowerCase()]
            );

            if (userCheck.rows.length === 0) {
                // Don't reveal if email exists - return success anyway
                return { success: true, message: 'If an account exists, a reset email has been sent.' };
            }

            // Generate reset token
            const resetToken = jwt.sign(
                { userId: userCheck.rows[0].id, type: 'password_reset' },
                env.jwtSecret,
                { expiresIn: '1h' }
            );

            // Store reset token in database
            await pool.query(
                `INSERT INTO password_reset_tokens (user_id, token, expires_at)
                 VALUES ($1, $2, NOW() + INTERVAL '1 hour')
                 ON CONFLICT (user_id) DO UPDATE SET token = $2, expires_at = NOW() + INTERVAL '1 hour'`,
                [userCheck.rows[0].id, resetToken]
            );

            // Send password reset email
            if (isEmailConfigured()) {
                const emailResult = await sendPasswordResetEmail(
                    body.email,
                    resetToken,
                    userCheck.rows[0].username
                );

                if (emailResult.success) {
                    req.log.info({
                        type: 'password_reset_email_sent',
                        userId: userCheck.rows[0].id,
                        email: body.email
                    });
                } else {
                    req.log.error({
                        type: 'password_reset_email_failed',
                        userId: userCheck.rows[0].id,
                        error: emailResult.error
                    });
                }
            } else {
                req.log.warn({
                    type: 'password_reset_requested',
                    userId: userCheck.rows[0].id,
                    email: body.email,
                    message: 'Email service not configured - set SMTP_HOST, SMTP_USER, SMTP_PASS'
                });
            }

            return {
                success: true,
                message: 'If an account exists, a reset email has been sent.',
                // Include token in dev mode for testing (remove in production)
                _devToken: process.env.NODE_ENV !== 'production' && !isEmailConfigured() ? resetToken : undefined
            };
        } catch (e: any) {
            req.log.error({ error: 'Password reset request failed', message: e.message });
            return reply.status(500).send({ error: 'Failed to process password reset request' });
        }
    });
}
