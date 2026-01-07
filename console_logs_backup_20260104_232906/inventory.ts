import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth';
import { pool } from '../../db/pool';

const DEFAULT_ITEMS: GameItem[] = [
  {
    id: 'treat_pizza',
    name: 'Pizza Slice',
    description: 'Cheesy goodness. 300kcal.',
    type: 'food',
    rarity: 'common',
    isConsumable: true,
    cost: { currency: 'flex', amount: 300 },
    effect: { type: 'log_food', data: { name: 'Pizza Slice', calories: 300 } }
  },
  {
    id: 'treat_wine',
    name: 'Glass of Wine',
    description: 'Red or White. 150kcal.',
    type: 'food',
    rarity: 'common',
    isConsumable: true,
    cost: { currency: 'flex', amount: 150 },
    effect: { type: 'log_food', data: { name: 'Glass of Wine', calories: 150 } }
  },
  {
    id: 'treat_burger',
    name: 'Cheeseburger',
    description: 'Classic beef patty. 600kcal.',
    type: 'food',
    rarity: 'rare',
    isConsumable: true,
    cost: { currency: 'flex', amount: 600 },
    effect: { type: 'log_food', data: { name: 'Cheeseburger', calories: 600 } }
  },
  {
    id: 'util_streak_freeze',
    name: 'Streak Freeze',
    description: 'Protects your streak for 24h if you miss a day.',
    type: 'utility',
    rarity: 'rare',
    isConsumable: true,
    cost: { currency: 'sparks', amount: 500 },
    effect: { type: 'freeze_streak', duration: 24 }
  },
  {
    id: 'util_double_xp',
    name: 'XP Potion',
    description: 'Double XP for next workout.',
    type: 'utility',
    rarity: 'epic',
    isConsumable: true,
    cost: { currency: 'sparks', amount: 300 },
    effect: { type: 'double_xp', duration: 1 }
  }
];

const purchaseSchema = z.object({
  itemId: z.string(),
  quantity: z.number().int().min(1).max(10).default(1)
});

const consumeSchema = z.object({
  itemId: z.string(),
  quantity: z.number().int().min(1).max(10).default(1)
});

const listSchema = z.object({
  limit: z.coerce.number().min(1).max(200).default(50)
});

type GameItem = {
  id: string;
  name: string;
  description: string;
  type: string;
  rarity: string;
  isConsumable: boolean;
  cost: { currency: 'flex' | 'sparks'; amount: number };
  effect: any;
  icon?: string | null;
  visualKey?: string | null;
};

const mapItemRow = (row: any): GameItem => ({
  id: row.id,
  name: row.name,
  description: row.description,
  type: row.type,
  rarity: row.rarity,
  isConsumable: row.is_consumable,
  cost: row.cost || { currency: 'sparks', amount: 0 },
  effect: row.effect || {},
  icon: row.icon,
  visualKey: row.visual_key
});

const toInventoryMap = (rows: any[]) => {
  const map: Record<string, number> = {};
  rows.forEach((row) => {
    if (row.quantity > 0) map[row.item_id] = row.quantity;
  });
  return map;
};

export async function inventoryRoutes(app: FastifyInstance) {
  app.get('/inventory/items', { preHandler: authGuard }, async () => {
    const { rows } = await pool.query(
      `SELECT id, name, description, type, rarity, is_consumable, cost, effect, icon, visual_key
       FROM game_items
       ORDER BY created_at DESC`
    );
    if (rows.length === 0) return DEFAULT_ITEMS;
    return rows.map(mapItemRow);
  });

  app.get('/inventory', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
    const { rows } = await pool.query(
      `SELECT item_id, quantity, last_acquired_at, last_consumed_at
       FROM user_inventory
       WHERE user_id = $1`,
      [user.userId]
    );

    const profileRes = await pool.query(
      `SELECT profile_data FROM user_profiles WHERE user_id = $1`,
      [user.userId]
    );
    const profileData = profileRes.rows[0]?.profile_data || {};

    return {
      items: rows.map((r: any) => ({
        itemId: r.item_id,
        quantity: r.quantity,
        lastAcquiredAt: r.last_acquired_at,
        lastConsumedAt: r.last_consumed_at
      })),
      asMap: toInventoryMap(rows),
      stats: {
        coins: profileData.coins || 0,
        caloricDebt: profileData.caloricDebt || 0
      }
    };
  });

  app.post('/inventory/items', { preHandler: authGuard }, async (req, reply) => {
    const body = z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      type: z.string(),
      rarity: z.string(),
      isConsumable: z.boolean(),
      cost: z.object({ currency: z.enum(['flex', 'sparks']), amount: z.number() }),
      effect: z.any(),
      icon: z.string().optional(),
      visualKey: z.string().optional()
    }).parse(req.body);

    const { rows } = await pool.query(
      `INSERT INTO game_items(id, name, description, type, rarity, is_consumable, cost, effect, icon, visual_key)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            type = EXCLUDED.type,
            cost = EXCLUDED.cost,
            effect = EXCLUDED.effect,
            icon = EXCLUDED.icon,
            visual_key = EXCLUDED.visual_key
         RETURNING *`,
      [body.id, body.name, body.description, body.type, body.rarity, body.isConsumable, body.cost, body.effect, body.icon, body.visualKey]
    );

    return mapItemRow(rows[0]);
  });

  app.get('/inventory/transactions', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
    const query = listSchema.parse(req.query ?? {});
    const { rows } = await pool.query(
      `SELECT id, item_id, transaction_type, quantity, cost, metadata, created_at
       FROM inventory_transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [user.userId, query.limit]
    );
    return rows.map((r: any) => ({
      id: r.id,
      itemId: r.item_id,
      type: r.transaction_type,
      quantity: r.quantity,
      cost: r.cost,
      metadata: r.metadata,
      createdAt: r.created_at
    }));
  });

  const findItem = async (itemId: string): Promise<GameItem | null> => {
    const { rows } = await pool.query(
      `SELECT id, name, description, type, rarity, is_consumable, cost, effect, icon, visual_key
       FROM game_items
       WHERE id = $1
       LIMIT 1`,
      [itemId]
    );
    if (rows.length > 0) return mapItemRow(rows[0]);
    return DEFAULT_ITEMS.find((i) => i.id === itemId) || null;
  };

  app.post('/inventory/purchase', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const body = purchaseSchema.parse(req.body);
    const item = await findItem(body.itemId);
    if (!item) return reply.status(404).send({ error: 'Item not found' });

    const totalCost = (item.cost?.amount || 0) * body.quantity;
    if (totalCost <= 0) return reply.status(400).send({ error: 'Invalid item cost' });

    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 30000'); // 30 seconds timeout
      await client.query('BEGIN');
      const profileRes = await client.query(
        `SELECT profile_data
         FROM user_profiles
         WHERE user_id = $1
         FOR UPDATE`,
        [user.userId]
      );

      const profileData = profileRes.rows[0]?.profile_data || {};
      let coins = Number(profileData.coins ?? 0);
      let caloricDebt = Number(profileData.caloricDebt ?? 0);

      if (item.cost.currency === 'sparks') {
        if (coins < totalCost) {
          throw new Error('NOT_ENOUGH_SPARKS');
        }
        coins -= totalCost;
      } else {
        const availableFlex = caloricDebt < 0 ? Math.abs(caloricDebt) : 0;
        if (availableFlex < totalCost) {
          throw new Error('NOT_ENOUGH_FLEX');
        }
        caloricDebt += totalCost;
      }

      const inventoryRes = await client.query(
        `INSERT INTO user_inventory(id, user_id, item_id, quantity, last_acquired_at, updated_at)
         VALUES(gen_random_uuid(), $1, $2, $3, now(), now())
         ON CONFLICT (user_id, item_id) DO UPDATE
         SET quantity = user_inventory.quantity + EXCLUDED.quantity,
             last_acquired_at = now(),
             updated_at = now()
         RETURNING item_id, quantity`,
        [user.userId, item.id, body.quantity]
      );

      await client.query(
        `INSERT INTO inventory_transactions(id, user_id, item_id, transaction_type, quantity, cost, metadata)
         VALUES(gen_random_uuid(), $1, $2, 'purchase', $3, $4::jsonb, $5::jsonb)`,
        [
          user.userId,
          item.id,
          body.quantity,
          JSON.stringify({ currency: item.cost.currency, amount: totalCost }),
          JSON.stringify({ item })
        ]
      );

      const inventoryMap = profileData.inventory || {};
      inventoryMap[item.id] = inventoryRes.rows[0].quantity;

      const newProfileData = {
        ...profileData,
        coins,
        caloricDebt,
        inventory: inventoryMap
      };

      await client.query(
        `UPDATE user_profiles
         SET profile_data = $1::jsonb,
             updated_at = now()
         WHERE user_id = $2`,
        [JSON.stringify(newProfileData), user.userId]
      );

      await client.query('COMMIT');
      return reply.send({
        itemId: item.id,
        quantity: body.quantity,
        totalCost,
        currency: item.cost.currency,
        coins,
        caloricDebt,
        inventory: inventoryMap
      });
    } catch (error: any) {
      await client.query('ROLLBACK');
      if (error.message === 'NOT_ENOUGH_SPARKS') {
        return reply.status(400).send({ error: 'Not enough Sparks' });
      }
      if (error.message === 'NOT_ENOUGH_FLEX') {
        return reply.status(400).send({ error: 'Not enough Flex credits' });
      }
      console.error('Inventory purchase failed', error);
      return reply.status(500).send({ error: 'Purchase failed' });
    } finally {
      client.release();
    }
  });

  app.post('/inventory/consume', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const body = consumeSchema.parse(req.body);

    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 30000'); // 30 seconds timeout
      await client.query('BEGIN');
      const invRes = await client.query(
        `SELECT quantity
         FROM user_inventory
         WHERE user_id = $1 AND item_id = $2
         FOR UPDATE`,
        [user.userId, body.itemId]
      );
      if (invRes.rows.length === 0 || invRes.rows[0].quantity < body.quantity) {
        throw new Error('NOT_ENOUGH_ITEMS');
      }

      const newQuantity = invRes.rows[0].quantity - body.quantity;
      await client.query(
        `UPDATE user_inventory
         SET quantity = $1,
             last_consumed_at = now(),
             updated_at = now()
         WHERE user_id = $2 AND item_id = $3`,
        [newQuantity, user.userId, body.itemId]
      );

      await client.query(
        `INSERT INTO inventory_transactions(id, user_id, item_id, transaction_type, quantity, metadata)
         VALUES(gen_random_uuid(), $1, $2, 'consume', $3, $4::jsonb)`,
        [
          user.userId,
          body.itemId,
          body.quantity,
          JSON.stringify({ note: 'manual consume' })
        ]
      );

      const profileRes = await client.query(
        `SELECT profile_data
         FROM user_profiles
         WHERE user_id = $1
         FOR UPDATE`,
        [user.userId]
      );
      const profileData = profileRes.rows[0]?.profile_data || {};
      const inventoryMap = profileData.inventory || {};
      if (!inventoryMap[body.itemId]) {
        inventoryMap[body.itemId] = Math.max(0, newQuantity);
      } else {
        inventoryMap[body.itemId] = Math.max(0, newQuantity);
        if (inventoryMap[body.itemId] === 0) {
          delete inventoryMap[body.itemId];
        }
      }

      const newProfileData = {
        ...profileData,
        inventory: inventoryMap
      };

      await client.query(
        `UPDATE user_profiles
         SET profile_data = $1::jsonb,
             updated_at = now()
         WHERE user_id = $2`,
        [JSON.stringify(newProfileData), user.userId]
      );

      await client.query('COMMIT');
      return reply.send({
        itemId: body.itemId,
        quantity: body.quantity,
        remaining: Math.max(0, newQuantity),
        inventory: inventoryMap
      });
    } catch (error: any) {
      await client.query('ROLLBACK');
      if (error.message === 'NOT_ENOUGH_ITEMS') {
        return reply.status(400).send({ error: 'Item not available in inventory' });
      }
      console.error('Inventory consume failed', error);
      return reply.status(500).send({ error: 'Consume failed' });
    } finally {
      client.release();
    }
  });
}


