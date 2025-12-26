import { FastifyInstance } from 'fastify';
import { authGuard } from '../hooks/auth';
import { pool } from '../../db/pool';

export async function lookupRoutes(app: FastifyInstance) {
  app.get('/lookups/training-goals', { preHandler: authGuard }, async () => {
    const { rows } = await pool.query(
      `SELECT category, ARRAY_AGG(goal ORDER BY goal) AS goals
       FROM training_goal_categories
       GROUP BY category
       ORDER BY category`
    );
    return rows.map((row: any) => ({
      category: row.category,
      goals: row.goals
    }));
  });

  app.get('/lookups/nutrition-goals', { preHandler: authGuard }, async () => {
    const { rows } = await pool.query(
      `SELECT category, ARRAY_AGG(goal ORDER BY goal) AS goals
       FROM nutrition_goal_categories
       GROUP BY category
       ORDER BY category`
    );
    return rows.map((row: any) => ({
      category: row.category,
      goals: row.goals
    }));
  });

  app.get('/lookups/sports', { preHandler: authGuard }, async () => {
    const { rows } = await pool.query(
      `SELECT id, label
       FROM sports
       ORDER BY label`
    );
    return rows;
  });

  app.get('/lookups/cuisines', { preHandler: authGuard }, async () => {
    const { rows } = await pool.query(
      `SELECT id, label, icon
       FROM cuisines
       ORDER BY label`
    );
    return rows;
  });

  app.get('/lookups/equipment', { preHandler: authGuard }, async () => {
    const { rows } = await pool.query(
      `SELECT key, label
       FROM equipment_options
       ORDER BY label`
    );
    return rows.map((row: any) => ({
      key: row.key,
      label: row.label
    }));
  });

  app.get('/lookups/met-values', { preHandler: authGuard }, async () => {
    const { rows } = await pool.query(
      `SELECT activity_key, COALESCE(label, INITCAP(REPLACE(activity_key, '_', ' '))) AS label, value
       FROM met_values
       ORDER BY activity_key`
    );
    return rows.map((row: any) => ({
      key: row.activity_key,
      label: row.label,
      value: Number(row.value)
    }));
  });

  app.get('/lookups/all', { preHandler: authGuard }, async (_req, reply) => {
    const [training, nutrition, sports, cuisines, metValues, equipment] = await Promise.all([
      app.inject({ method: 'GET', url: '/lookups/training-goals' }).then(res => JSON.parse(res.payload)),
      app.inject({ method: 'GET', url: '/lookups/nutrition-goals' }).then(res => JSON.parse(res.payload)),
      app.inject({ method: 'GET', url: '/lookups/sports' }).then(res => JSON.parse(res.payload)),
      app.inject({ method: 'GET', url: '/lookups/cuisines' }).then(res => JSON.parse(res.payload)),
      app.inject({ method: 'GET', url: '/lookups/met-values' }).then(res => JSON.parse(res.payload)),
      app.inject({ method: 'GET', url: '/lookups/equipment' }).then(res => JSON.parse(res.payload))
    ]);

    return reply.send({
      trainingGoals: training,
      nutritionGoals: nutrition,
      sports,
      cuisines,
      metValues,
      equipment
    });
  });
}


