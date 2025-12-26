import { FastifyRequest, FastifyReply } from 'fastify';
import { AuthService } from '../../../application/services/authService';
import { pool } from '../../db/pool';

const authService = new AuthService();

export async function authGuard(req: FastifyRequest, reply: FastifyReply) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const token = header.substring('Bearer '.length);
    const payload = authService.verifyToken(token);
    (req as any).user = payload;
  } catch (e) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
}

export async function adminGuard(req: FastifyRequest, reply: FastifyReply) {
  // First check authentication
  await authGuard(req, reply);
  if (reply.sent) return; // If authGuard already sent a response, stop here

  try {
    const user = (req as any).user;
    if (!user?.userId) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    // Hardcoded admin email listesi (fallback)
    const adminEmails = ['mehmetcandiri@gmail.com', 'rmkocatas@gmail.com'];
    
    // Check user email from database first
    let userEmail: string | null = null;
    let userRole = 'user';
    
    try {
      const { rows } = await pool.query(
        `SELECT email, role FROM users WHERE id = $1`,
        [user.userId]
      );
      
      if (rows.length > 0) {
        userEmail = rows[0].email;
        userRole = rows[0].role || 'user';
      }
    } catch (e: any) {
      // If role column doesn't exist, check profile_data instead
      if (e.code === '42703') { // PostgreSQL error code for undefined column
        try {
          const { rows } = await pool.query(
            `SELECT email FROM users WHERE id = $1`,
            [user.userId]
          );
          userEmail = rows[0]?.email || null;
          
          // Check profile_data for role
          const profileRows = await pool.query(
            `SELECT profile_data FROM user_profiles WHERE user_id = $1`,
            [user.userId]
          );
          const profileData = profileRows.rows[0]?.profile_data || {};
          userRole = profileData.role || 'user';
        } catch (profileError) {
          // If profile doesn't exist either, default to 'user'
          userRole = 'user';
        }
      } else {
        throw e;
      }
    }

    // Check if user is in hardcoded admin list OR has admin/owner role
    const isHardcodedAdmin = userEmail && adminEmails.includes(userEmail);
    const hasAdminRole = userRole === 'admin' || userRole === 'owner';
    
    if (!isHardcodedAdmin && !hasAdminRole) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
  } catch (e: any) {
    const isProduction = process.env.NODE_ENV === 'production';
    req.log?.error(e);
    return reply.status(500).send({ 
      error: isProduction ? 'Authorization check failed' : (e.message || 'Authorization check failed') 
    });
  }
}

