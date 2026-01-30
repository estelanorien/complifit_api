import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthService } from '../../../application/services/authService.js';
import { authGuard } from '../hooks/auth.js';
import { ValidationError, ConflictError, AuthenticationError, InternalServerError } from '../middleware/errors.js';

const auth = new AuthService();
const isProduction = process.env.NODE_ENV === 'production';

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
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'auth.ts:login:entry',message:'login handler entered',data:{hasBody:!!req.body,bodyKeys:req.body?Object.keys(req.body):[]},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H4'})}).catch(()=>{});
    // #endregion
    try {
      // email veya username kabul ediyoruz, bu yüzden sadece min length kontrolü
      const body = z.object({
        email: z.string().min(1).trim(),
        password: z.string().min(6)
      }).parse(req.body);

      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'auth.ts:login:beforeSignIn',message:'calling signIn',data:{emailLen:body.email?.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H5'})}).catch(()=>{});
      // #endregion
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
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'auth.ts:login:catch',message:'login catch',data:{message:e?.message,code:(e as any)?.code,isZod:e instanceof z.ZodError},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H5-H6'})}).catch(()=>{});
      // #endregion
      if (e instanceof z.ZodError) {
        throw new ValidationError('Validation failed', e);
      }
      // Don't reveal if email/username exists
      if (e?.message?.includes('Invalid credentials')) {
        req.log.warn({
          type: 'login_failed',
          requestId: (req as any).requestId,
          email: (req.body as any)?.email,
          ip: req.ip,
        });
        throw new AuthenticationError('Invalid credentials');
      }
      // Log the real cause so we can fix DB/config issues (500 = DB, JWT, or unexpected error)
      req.log.error({
        type: 'login_error',
        requestId: (req as any).requestId,
        message: e?.message,
        code: (e as any)?.code,
        stack: isProduction ? undefined : e?.stack,
      });
      throw new InternalServerError(
        isProduction ? 'Login temporarily unavailable. Please try again later.' : (e?.message || 'Internal server error')
      );
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

