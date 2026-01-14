import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthService } from '../../../application/services/authService.js';
import { authGuard } from '../hooks/auth.js';
import { ValidationError, ConflictError, AuthenticationError } from '../middleware/errors.js';

const auth = new AuthService();

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
        requestId: (req as any).requestId,
        userId: user.id,
        email: user.email,
      });

      return reply.send({ user, token });
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        throw new ValidationError('Validation failed', e);
      }
      if (e.message?.includes('already exists')) {
        throw new ConflictError('Email or username already exists');
      }
      throw e; // Let error handler deal with it
    }
  });

  app.post('/auth/login', async (req, reply) => {
    try {
      // email veya username kabul ediyoruz, bu yüzden sadece min length kontrolü
      const body = z.object({
        email: z.string().min(1).trim(),
        password: z.string().min(6)
      }).parse(req.body);

      const { user, token } = await auth.signIn(body.email, body.password);

      req.log.info({
        type: 'user_login',
        requestId: (req as any).requestId,
        userId: user.id,
        email: user.email,
        ip: req.ip,
      });

      return reply.send({ user, token });
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        throw new ValidationError('Validation failed', e);
      }
      // Don't reveal if email/username exists
      if (e.message?.includes('Invalid credentials')) {
        req.log.warn({
          type: 'login_failed',
          requestId: (req as any).requestId,
          email: (req.body as any)?.email,
          ip: req.ip,
        });
        throw new AuthenticationError('Invalid credentials');
      }
      throw e; // Let error handler deal with it
    }
  });

  app.get('/auth/me', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
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
        requestId: (req as any).requestId,
        userId: user.id,
      });

      return reply.send({ user, token });
    } catch (e: any) {
      req.log.warn({
        type: 'token_refresh_failed',
        requestId: (req as any).requestId,
        error: e.message,
      });
      throw new AuthenticationError('Invalid or expired token');
    }
  });

  app.post('/auth/change-password', { preHandler: authGuard }, async (req, reply) => {
    try {
      const user = (req as any).user;
      const body = z.object({
        currentPassword: z.string().min(6),
        newPassword: z.string().min(8).regex(
          /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
          'Password must contain at least one uppercase letter, one lowercase letter, and one number'
        )
      }).parse(req.body);

      await auth.changePassword(user.userId, body.currentPassword, body.newPassword);

      req.log.info({
        type: 'password_changed',
        requestId: (req as any).requestId,
        userId: user.userId,
      });

      return reply.send({ success: true, message: 'Password changed successfully' });
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        throw new ValidationError('Validation failed', e);
      }
      if (e.message?.includes('Current password is incorrect')) {
        throw new AuthenticationError('Current password is incorrect');
      }
      throw e;
    }
  });

  app.delete('/auth/me', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    await auth.deleteAccount(user.userId);

    req.log.info({
      type: 'account_deleted',
      requestId: (req as any).requestId,
      userId: user.userId,
    });

    return reply.send({ success: true, message: 'Account deleted successfully' });
  });
}

