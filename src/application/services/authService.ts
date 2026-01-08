import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../../infra/db/pool';
import { env } from '../../config/env';

type JwtPayload = { userId: string; email: string };

export class AuthService {
  private readonly accessTtlSec = 60 * 60 * 6; // 6 saat

  async signUp(email: string, password: string, fullName?: string, username?: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const normalizedEmail = email.trim().toLowerCase();
      const cleanUsername = (username?.trim() || email.split('@')[0]).toLowerCase();

      // Duplicate check
      const dup = await client.query(
        'SELECT id FROM users WHERE LOWER(email) = $1 OR LOWER(username) = $2 LIMIT 1',
        [normalizedEmail, cleanUsername]
      );
      if (dup.rows.length > 0) {
        throw new Error('Email or username already exists');
      }

      const hash = await bcrypt.hash(password, 10);
      const { rows } = await client.query(
        'INSERT INTO users(email, password_hash, username) VALUES($1, $2, $3) RETURNING id, email, created_at, username',
        [email, hash, cleanUsername]
      );
      const user = rows[0];
      await client.query('COMMIT');
      const token = this.issueToken({ userId: user.id, email: user.email });
      return { user: { ...user, username: cleanUsername }, token };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async signIn(identifier: string, password: string) {
    const normalized = identifier.trim().toLowerCase();
    const { rows } = await pool.query(
      'SELECT id, email, password_hash, username FROM users WHERE LOWER(email) = $1 OR LOWER(username) = $1',
      [normalized]
    );
    if (rows.length === 0) throw new Error('Invalid credentials');
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) throw new Error('Invalid credentials');

    const token = this.issueToken({ userId: user.id, email: user.email });
    return { user: { id: user.id, email: user.email, username: user.username }, token };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get current password hash
      const { rows } = await client.query(
        'SELECT password_hash FROM users WHERE id = $1',
        [userId]
      );

      if (rows.length === 0) {
        throw new Error('User not found');
      }

      // Verify current password
      const user = rows[0];
      const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password_hash);

      if (!isCurrentPasswordValid) {
        throw new Error('Current password is incorrect');
      }

      // Hash new password
      const newHash = await bcrypt.hash(newPassword, 10);

      // Update password
      await client.query(
        'UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2',
        [newHash, userId]
      );

      await client.query('COMMIT');
      return { success: true };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async deleteAccount(userId: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Get user details for logging
      const { rows } = await client.query('SELECT email FROM users WHERE id = $1', [userId]);
      if (rows.length === 0) throw new Error('User not found');
      const userEmail = rows[0].email;

      // 2. Log to audit table
      await client.query(
        'INSERT INTO deleted_users_log(original_user_id, email, deletion_reason) VALUES($1, $2, $3)',
        [userId, userEmail, 'User requested deletion']
      );

      // 3. Delete user (Assumes CASCADE on related tables)
      await client.query('DELETE FROM users WHERE id = $1', [userId]);

      await client.query('COMMIT');
      return { success: true };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  issueToken(payload: JwtPayload) {
    return jwt.sign(payload, env.jwtSecret, { expiresIn: this.accessTtlSec });
  }

  verifyToken(token: string): JwtPayload {
    return jwt.verify(token, env.jwtSecret) as JwtPayload;
  }
}
