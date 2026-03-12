import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AuthService } from '../../../application/services/authService.js';
import { authGuard } from '../hooks/auth.js';
import { ValidationError, ConflictError, AuthenticationError } from '../middleware/errors.js';
import { AuthenticatedRequest } from '../types.js';

const auth = new AuthService();
const isProduction = process.env.NODE_ENV === 'production';

// Request body schemas
const signupSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(8).regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?])/, 'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character'),
  fullName: z.string().optional(),
  username: z.string().optional()
});

const loginSchema = z.object({
  email: z.string().min(1).trim(),
  password: z.string().min(6)
});

// Account lockout to prevent brute force
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes

const refreshSchema = z.object({
  refreshToken: z.string().optional(),
  token: z.string().optional()
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(6),
  newPassword: z.string().min(8).regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
    'Password must contain at least one uppercase letter, one lowercase letter, and one number'
  )
});

type SignupBody = z.infer<typeof signupSchema>;
type LoginBody = z.infer<typeof loginSchema>;
type RefreshBody = z.infer<typeof refreshSchema>;
type ChangePasswordBody = z.infer<typeof changePasswordSchema>;

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/signup', async (req, reply) => {
    try {
      const body = z.object({
        email: z.string().email().toLowerCase().trim(),
        password: z.string().min(8).regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, 'Password must contain at least one uppercase letter, one lowercase letter, and one number'),
        fullName: z.string().optional(),
        username: z.string().optional()
      }).parse(req.body);

      const { user, token } = await auth.signUp(body.email, body.password, body.fullName, body.username);

      req.log.info({
        type: 'user_signup',
        requestId: req.id,
        userId: user.id,
        email: user.email,
      });

      return reply.send({ user, token });
    } catch (e: unknown) {
      if (e instanceof z.ZodError) {
        throw new ValidationError('Validation failed', e);
      }
      const error = e as Error;
      if (error.message?.includes('already exists')) {
        throw new ConflictError('Email or username already exists');
      }
      throw e; // Let error handler deal with it
    }
  });

  app.post('/auth/login', async (req, reply) => {
    try {
      const body = z.object({
        email: z.string().min(1).trim(),
        password: z.string().min(6)
      }).parse(req.body);

      // Account lockout check
      const emailKey = body.email.toLowerCase();
      const attempts = loginAttempts.get(emailKey);
      if (attempts && attempts.lockedUntil > Date.now()) {
        return reply.status(429).send({ error: 'Too many login attempts. Please try again later.' });
      }

      const { user, token } = await auth.signIn(body.email, body.password);

      // Clear login attempts on success
      loginAttempts.delete(emailKey);

      req.log.info({
        type: 'user_login',
        requestId: req.id,
        userId: user.id,
        ip: req.ip,
      });

      return reply.send({ user, token });
    } catch (e: unknown) {
      if (e instanceof z.ZodError) {
        throw new ValidationError('Validation failed', e);
      }
      const error = e as Error & { code?: string; errno?: string };
      if (error?.message?.includes('Invalid credentials')) {
        // Track failed login attempts
        const emailKey = ((req.body as LoginBody)?.email || '').toLowerCase();
        const current = loginAttempts.get(emailKey) || { count: 0, lockedUntil: 0 };
        current.count++;
        if (current.count >= MAX_LOGIN_ATTEMPTS) {
          current.lockedUntil = Date.now() + LOCKOUT_DURATION;
        }
        loginAttempts.set(emailKey, current);

        req.log.warn({
          type: 'login_failed',
          requestId: req.id,
          ip: req.ip,
          attemptCount: current.count,
        });
        // Generic error message to prevent user enumeration
        return reply.status(401).send({ error: 'Invalid email or password' });
      }
      const code = error?.code ?? error?.errno;
      const isDbUnavailable = code === '57P03' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || error?.message?.includes('connect');
      req.log.error({
        type: 'login_error',
        requestId: req.id,
        message: error?.message,
        code,
        stack: isProduction ? undefined : error?.stack,
      });
      if (isDbUnavailable) {
        return reply.status(503).send({ error: 'Service temporarily unavailable. Please try again in a moment.' });
      }
      return reply.status(503).send({
        error: 'Login temporarily unavailable. Please try again later.',
      });
    }
  });

  app.get('/auth/me', { preHandler: authGuard }, async (req) => {
    const user = (req as AuthenticatedRequest).user;
    return { user };
  });

  app.post('/auth/refresh', async (req, reply) => {
    try {
      const body = z.object({
        refreshToken: z.string().optional(),
        token: z.string().optional()
      }).parse(req.body);

      const tokenToRefresh = body.refreshToken || body.token;

      if (!tokenToRefresh) {
        throw new AuthenticationError('No token provided');
      }

      // For now, just verify the token and issue a new one
      const { user, token } = await auth.refreshToken(tokenToRefresh);

      req.log.info({
        type: 'token_refreshed',
        requestId: req.id,
        userId: user.id,
      });

      return reply.send({ user, token });
    } catch (e: unknown) {
      const error = e as Error;
      req.log.warn({
        type: 'token_refresh_failed',
        requestId: req.id,
        error: error?.message,
      });
      throw new AuthenticationError('Invalid or expired token');
    }
  });

  app.post('/auth/change-password', { preHandler: authGuard }, async (req, reply) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const body = changePasswordSchema.parse(req.body);

      await auth.changePassword(authReq.user.userId, body.currentPassword, body.newPassword);

      req.log.info({
        type: 'password_changed',
        requestId: req.id,
        userId: authReq.user.userId,
      });

      return reply.send({ success: true, message: 'Password changed successfully' });
    } catch (e: unknown) {
      if (e instanceof z.ZodError) {
        throw new ValidationError('Validation failed', e);
      }
      const error = e as Error;
      if (error.message?.includes('Current password is incorrect')) {
        throw new AuthenticationError('Current password is incorrect');
      }
      throw e;
    }
  });

  app.delete('/auth/me', { preHandler: authGuard }, async (req, reply) => {
    const authReq = req as AuthenticatedRequest;
    await auth.deleteAccount(authReq.user.userId);

    req.log.info({
      type: 'account_deleted',
      requestId: req.id,
      userId: authReq.user.userId,
    });

    return reply.send({ success: true, message: 'Account deleted successfully' });
  });
}

