import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthService } from '../../../application/services/authService';
import { authGuard } from '../hooks/auth';

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
      return reply.send({ user, token });
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: e.errors });
      }
      console.error('Signup error', e);
      return reply.status(500).send({ error: e.message || 'Signup failed' });
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
      return reply.send({ user, token });
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: e.errors });
      }
      // Don't reveal if email/username exists
      if (e.message?.includes('Invalid credentials')) {
        return reply.status(401).send({ error: 'Invalid credentials' });
      }
      console.error('Login error', e);
      return reply.status(500).send({ error: 'Login failed' });
    }
  });

  app.get('/auth/me', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
    return { user };
  });
}

