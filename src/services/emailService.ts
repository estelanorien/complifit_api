import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

let transporter: nodemailer.Transporter | null = null;

/**
 * Initialize email transporter
 */
export function initializeEmail(): boolean {
    if (transporter) {
        return true; // Already initialized
    }

    if (!env.email.host || !env.email.user || !env.email.pass) {
        console.warn('[Email] SMTP not configured. Email sending disabled.');
        console.warn('[Email] Set SMTP_HOST, SMTP_USER, SMTP_PASS environment variables to enable.');
        return false;
    }

    try {
        transporter = nodemailer.createTransport({
            host: env.email.host,
            port: env.email.port,
            secure: env.email.secure, // true for 465, false for other ports
            auth: {
                user: env.email.user,
                pass: env.email.pass
            }
        });

        console.log('[Email] SMTP transporter initialized');
        return true;
    } catch (error) {
        console.error('[Email] Failed to initialize:', error);
        return false;
    }
}

/**
 * Check if email service is available
 */
export function isEmailConfigured(): boolean {
    return transporter !== null;
}

/**
 * Send an email
 */
export async function sendEmail(
    to: string,
    subject: string,
    html: string,
    text?: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!transporter) {
        return { success: false, error: 'Email service not configured' };
    }

    try {
        const result = await transporter.sendMail({
            from: env.email.from,
            to,
            subject,
            html,
            text: text || html.replace(/<[^>]*>/g, '') // Strip HTML for text version
        });

        return { success: true, messageId: result.messageId };
    } catch (error: any) {
        console.error('[Email] Send failed:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Send password reset email
 */
export async function sendPasswordResetEmail(
    to: string,
    resetToken: string,
    userName?: string
): Promise<{ success: boolean; error?: string }> {
    const resetLink = `${env.frontendUrl}/reset-password?token=${resetToken}`;
    const greeting = userName ? `Hi ${userName}` : 'Hi';

    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Reset Your Password</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #8B5CF6; margin: 0;">Complifit</h1>
    </div>

    <div style="background: #f9fafb; border-radius: 12px; padding: 30px; margin-bottom: 20px;">
        <h2 style="margin-top: 0; color: #1f2937;">Password Reset Request</h2>

        <p>${greeting},</p>

        <p>We received a request to reset your password. Click the button below to create a new password:</p>

        <div style="text-align: center; margin: 30px 0;">
            <a href="${resetLink}"
               style="display: inline-block; background: #8B5CF6; color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600;">
                Reset Password
            </a>
        </div>

        <p style="color: #6b7280; font-size: 14px;">
            This link will expire in 1 hour. If you didn't request a password reset, you can safely ignore this email.
        </p>

        <p style="color: #6b7280; font-size: 14px;">
            If the button doesn't work, copy and paste this link into your browser:<br>
            <a href="${resetLink}" style="color: #8B5CF6; word-break: break-all;">${resetLink}</a>
        </p>
    </div>

    <div style="text-align: center; color: #9ca3af; font-size: 12px;">
        <p>This email was sent by Complifit. If you have questions, contact support@complifit.app</p>
    </div>
</body>
</html>
`;

    const text = `
${greeting},

We received a request to reset your password.

Click here to reset your password: ${resetLink}

This link will expire in 1 hour.

If you didn't request a password reset, you can safely ignore this email.

- The Complifit Team
`;

    const result = await sendEmail(to, 'Reset Your Complifit Password', html, text);
    return result;
}

/**
 * Send welcome email to new users
 */
export async function sendWelcomeEmail(
    to: string,
    userName?: string
): Promise<{ success: boolean; error?: string }> {
    const greeting = userName ? `Welcome ${userName}!` : 'Welcome!';

    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #8B5CF6; margin: 0;">Complifit</h1>
    </div>

    <div style="background: #f9fafb; border-radius: 12px; padding: 30px;">
        <h2 style="margin-top: 0; color: #1f2937;">${greeting}</h2>

        <p>Thanks for joining Complifit! We're excited to help you on your fitness journey.</p>

        <p>Here's what you can do next:</p>
        <ul>
            <li>Set up your profile and fitness goals</li>
            <li>Get your personalized meal and workout plans</li>
            <li>Track your progress with our AI coach</li>
        </ul>

        <div style="text-align: center; margin: 30px 0;">
            <a href="${env.frontendUrl}"
               style="display: inline-block; background: #8B5CF6; color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600;">
                Open Complifit
            </a>
        </div>
    </div>

    <div style="text-align: center; color: #9ca3af; font-size: 12px; margin-top: 20px;">
        <p>Questions? Contact us at support@complifit.app</p>
    </div>
</body>
</html>
`;

    return sendEmail(to, 'Welcome to Complifit!', html);
}

// Initialize on module load
initializeEmail();
