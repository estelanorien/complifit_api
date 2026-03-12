import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { authGuard } from '../hooks/auth.js';
import { AuthenticatedRequest } from '../types.js';

// Hardcoded Shop Inventory
const SHOP_ITEMS = [
  { id: 'streak_freeze', name: 'Streak Freeze', type: 'consumable', price: 500, description: 'Keep your streak alive after a missed day.', icon: '❄️' },
  { id: 'weekend_shield', name: 'Weekend Shield', type: 'consumable', price: 800, description: 'Automatically protects Sat/Sun streaks.', icon: '🛡️' },
  { id: 'gold_nameplate', name: 'Golden Nameplate', type: 'cosmetic', price: 2000, description: 'Your name shines Gold in comments.', icon: '👑' },
  { id: 'neon_border', name: 'Neon Avatar Border', type: 'cosmetic', price: 1000, description: 'Glowing ring for your profile.', icon: '🌈' },
  { id: 'profile_theme_dark', name: 'Midnight Theme', type: 'cosmetic', price: 1500, description: 'Dark mode aesthetics for your profile.', icon: '🌑' },
  { id: 'reaction_fire', name: 'Fire Pack', type: 'reaction', price: 500, description: 'Unlock animated flame reactions.', icon: '🔥' },
  { id: 'confetti_finisher', name: 'Confetti Finisher', type: 'celebration', price: 800, description: 'Blast confetti when you finish a workout.', icon: '🎉' },
  { id: 'retro_icon', name: 'Retro App Icon', type: 'app_icon', price: 1200, description: '80s style app icon.', icon: '💾' }
];

const purchaseSchema = z.object({
  itemId: z.string()
});

export async function inventoryRoutes(app: FastifyInstance) {
  // 1. Get Global Shop Inventory
  app.get('/shop/inventory', async (req, reply) => {
    return { items: SHOP_ITEMS };
  });

  // 2. Get User's Owned Inventory
  app.get('/shop/my-inventory', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;

    const result = await pool.query(
      `SELECT inventory FROM profiles WHERE user_id = $1`,
      [user.userId]
    );

    const inventory = result.rows[0]?.inventory || [];
    return { inventory };
  });

  // 3. Purchase Item
  app.post('/shop/purchase', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const { itemId } = purchaseSchema.parse(req.body);

    const item = SHOP_ITEMS.find(i => i.id === itemId);
    if (!item) {
      return reply.status(404).send({ error: 'Item not found' });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Check Balance & Existing Inventory
      const profileResult = await client.query(
        `SELECT coins, inventory FROM profiles WHERE user_id = $1 FOR UPDATE`,
        [user.userId]
      );

      const profile = profileResult.rows[0];
      const currentCoins = profile.coins || 0;
      let inventory = profile.inventory || [];

      // Check Funds
      if (currentCoins < item.price) {
        throw new Error('Insufficient Sparks');
      }

      // Check Duplicates for Cosmetics (Consumables can stack? ensuring simple MVP: No stacks yet, just boolean ownership for cosmetics)
      if (item.type !== 'consumable') {
        const alreadyOwned = inventory.some((i: any) => i.id === itemId);
        if (alreadyOwned) {
          throw new Error('You already own this item');
        }
      }

      // Deduct Coins
      const newBalance = currentCoins - item.price;

      // Add to Inventory
      const newItem = {
        purchasedAt: new Date().toISOString(),
        ...item
      };
      inventory.push(newItem);

      // Update DB
      await client.query(
        `UPDATE profiles SET coins = $1, inventory = $2 WHERE user_id = $3`,
        [newBalance, JSON.stringify(inventory), user.userId]
      );

      await client.query('COMMIT');

      return {
        success: true,
        message: `Purchased ${item.name}!`,
        newBalance,
        inventory
      };

    } catch (err: any) {
      await client.query('ROLLBACK');
      return reply.status(400).send({ error: err.message });
    } finally {
      client.release();
    }
  });

  // 4. Get User's Inventory Transaction History
  app.get('/inventory/transactions', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const { limit = '20' } = req.query as { limit?: string };
    const limitNum = parseInt(limit, 10) || 20;

    try {
      const result = await pool.query(
        `SELECT 
          transaction_type,
          item_id,
          quantity,
          created_at
         FROM inventory_transactions
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [user.userId, limitNum]
      );

      return { transactions: result.rows };
    } catch (err: any) {
      return reply.status(500).send({ error: 'Failed to fetch transactions' });
    }
  });

  // Get all shop items (catalog)
  app.get('/inventory/items', async (req, reply) => {
    return { items: SHOP_ITEMS };
  });

  // Consume an inventory item
  app.post('/inventory/consume', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const body = z.object({
      itemId: z.string(),
      quantity: z.number().int().positive().default(1)
    }).parse(req.body);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `SELECT profile_data FROM user_profiles WHERE user_id = $1 FOR UPDATE`,
        [user.userId]
      );

      const profileData = rows[0]?.profile_data || {};
      const inventory = profileData.inventory || {};
      const current = inventory[body.itemId] || 0;

      if (current < body.quantity) {
        await client.query('ROLLBACK');
        return reply.status(400).send({ error: 'Insufficient quantity' });
      }

      inventory[body.itemId] = current - body.quantity;
      if (inventory[body.itemId] <= 0) delete inventory[body.itemId];
      profileData.inventory = inventory;

      await client.query(
        `UPDATE user_profiles SET profile_data = $1::jsonb, updated_at = now() WHERE user_id = $2`,
        [JSON.stringify(profileData), user.userId]
      );

      await client.query('COMMIT');

      return reply.send({
        itemId: body.itemId,
        quantity: body.quantity,
        remaining: inventory[body.itemId] || 0,
        inventory
      });
    } catch (e: any) {
      await client.query('ROLLBACK');
      req.log.error(e);
      return reply.status(500).send({ error: e.message || 'Consume failed' });
    } finally {
      client.release();
    }
  });

  // Get user's current inventory
  app.get('/inventory', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;

    try {
      const { rows } = await pool.query(
        `SELECT inventory, economy FROM profiles WHERE user_id = $1`,
        [user.userId]
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Profile not found' });
      }

      const profile = rows[0];
      return reply.send({
        inventory: profile.inventory || [],
        economy: profile.economy || { coins: 0, gems: 0 }
      });
    } catch (e: unknown) {
      const error = e as Error;
      req.log.error({ error: 'Inventory fetch failed', message: error.message, requestId: req.id });
      return reply.status(500).send({ error: 'Failed to fetch inventory' });
    }
  });
}
