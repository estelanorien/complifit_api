import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
import { AuthenticatedRequest } from '../types.js';

// ============ TYPES ============

interface GroceryItem {
    id: string;
    name: string;
    nameLocal?: string;
    quantity: string;
    unit: string;
    category: string;
    estimatedPrice?: number;
    barcode?: string;
    checked?: boolean;
    storeAvailability?: Record<string, boolean>;
    nutritionPer100g?: {
        calories: number;
        protein: number;
        carbs: number;
        fat: number;
    };
}

interface ShoppingBag {
    id: string;
    userId: string;
    name: string;
    items: GroceryItem[];
    mealPlanId?: string;
    daysCovered: number;
    estimatedTotal: number;
    currency: string;
    store?: string;
    status: string;
    createdAt: string;
    updatedAt?: string;
}

// ============ ROUTES ============

export async function groceryRoutes(app: FastifyInstance) {

    // ============ SCHEMAS ============

    const createBagSchema = z.object({
        name: z.string().min(1).max(255),
        items: z.array(z.any()).default([]),
        mealPlanId: z.string().uuid().optional(),
        daysCovered: z.number().min(1).max(30).default(7),
        estimatedTotal: z.number().optional(),
        currency: z.string().default('TRY'),
        store: z.string().optional(),
        status: z.enum(['draft', 'ready', 'ordered', 'completed']).default('draft')
    });

    const updateBagSchema = z.object({
        name: z.string().min(1).max(255).optional(),
        items: z.array(z.any()).optional(),
        estimatedTotal: z.number().optional(),
        store: z.string().optional(),
        status: z.enum(['draft', 'ready', 'ordered', 'completed']).optional()
    });

    const productLookupSchema = z.object({
        barcode: z.string().optional(),
        query: z.string().optional()
    }).refine(data => data.barcode || data.query, {
        message: 'Either barcode or query is required'
    });

    // ============ SHOPPING BAGS ============

    /**
     * GET /grocery/bags
     * Get all shopping bags for the authenticated user
     */
    app.get('/grocery/bags', { preHandler: authGuard }, async (req) => {
        const user = (req as AuthenticatedRequest).user;

        const { rows } = await pool.query(
            `SELECT id, name, items, meal_plan_id, days_covered, estimated_total,
                    currency, store, status, created_at, updated_at
             FROM shopping_bags
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 50`,
            [user.userId]
        );

        return rows.map((row: any): ShoppingBag => ({
            id: row.id,
            userId: user.userId,
            name: row.name,
            items: row.items || [],
            mealPlanId: row.meal_plan_id || undefined,
            daysCovered: row.days_covered,
            estimatedTotal: parseFloat(row.estimated_total) || 0,
            currency: row.currency || 'TRY',
            store: row.store || undefined,
            status: row.status || 'draft',
            createdAt: row.created_at?.toISOString() || new Date().toISOString(),
            updatedAt: row.updated_at?.toISOString()
        }));
    });

    /**
     * GET /grocery/bags/:id
     * Get a specific shopping bag
     */
    app.get('/grocery/bags/:id', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const id = z.string().uuid().parse((req.params as any).id);

        const { rows } = await pool.query(
            `SELECT id, name, items, meal_plan_id, days_covered, estimated_total,
                    currency, store, status, created_at, updated_at
             FROM shopping_bags
             WHERE id = $1 AND user_id = $2`,
            [id, user.userId]
        );

        if (rows.length === 0) {
            return reply.status(404).send({ error: 'Shopping bag not found' });
        }

        const row = rows[0];
        return {
            id: row.id,
            userId: user.userId,
            name: row.name,
            items: row.items || [],
            mealPlanId: row.meal_plan_id || undefined,
            daysCovered: row.days_covered,
            estimatedTotal: parseFloat(row.estimated_total) || 0,
            currency: row.currency || 'TRY',
            store: row.store || undefined,
            status: row.status || 'draft',
            createdAt: row.created_at?.toISOString() || new Date().toISOString(),
            updatedAt: row.updated_at?.toISOString()
        };
    });

    /**
     * POST /grocery/bags
     * Create a new shopping bag
     */
    app.post('/grocery/bags', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const body = createBagSchema.parse(req.body);

        const { rows } = await pool.query(
            `INSERT INTO shopping_bags(
                user_id, name, items, meal_plan_id, days_covered,
                estimated_total, currency, store, status
            )
            VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id`,
            [
                user.userId,
                body.name,
                JSON.stringify(body.items),
                body.mealPlanId || null,
                body.daysCovered,
                body.estimatedTotal || 0,
                body.currency,
                body.store || null,
                body.status
            ]
        );

        return reply.status(201).send({ id: rows[0].id });
    });

    /**
     * PATCH /grocery/bags/:id
     * Update a shopping bag
     */
    app.patch('/grocery/bags/:id', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const id = z.string().uuid().parse((req.params as any).id);
        const body = updateBagSchema.parse(req.body);

        // Build dynamic update query
        const updates: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        if (body.name !== undefined) {
            updates.push(`name = $${paramIndex++}`);
            values.push(body.name);
        }
        if (body.items !== undefined) {
            updates.push(`items = $${paramIndex++}`);
            values.push(JSON.stringify(body.items));
        }
        if (body.estimatedTotal !== undefined) {
            updates.push(`estimated_total = $${paramIndex++}`);
            values.push(body.estimatedTotal);
        }
        if (body.store !== undefined) {
            updates.push(`store = $${paramIndex++}`);
            values.push(body.store);
        }
        if (body.status !== undefined) {
            updates.push(`status = $${paramIndex++}`);
            values.push(body.status);
        }

        if (updates.length === 0) {
            return reply.status(400).send({ error: 'No fields to update' });
        }

        values.push(id, user.userId);

        const result = await pool.query(
            `UPDATE shopping_bags
             SET ${updates.join(', ')}
             WHERE id = $${paramIndex++} AND user_id = $${paramIndex}`,
            values
        );

        if (result.rowCount === 0) {
            return reply.status(404).send({ error: 'Shopping bag not found' });
        }

        return reply.send({ success: true });
    });

    /**
     * DELETE /grocery/bags/:id
     * Delete a shopping bag
     */
    app.delete('/grocery/bags/:id', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const id = z.string().uuid().parse((req.params as any).id);

        const result = await pool.query(
            `DELETE FROM shopping_bags WHERE id = $1 AND user_id = $2`,
            [id, user.userId]
        );

        if (result.rowCount === 0) {
            return reply.status(404).send({ error: 'Shopping bag not found' });
        }

        return reply.send({ success: true });
    });

    // ============ PRODUCT LOOKUP ============

    /**
     * POST /grocery/lookup-product
     * Look up a product by barcode or search query using Open Food Facts
     */
    app.post('/grocery/lookup-product', { preHandler: authGuard }, async (req, reply) => {
        const body = productLookupSchema.parse(req.body);

        // Check product cache first
        if (body.barcode) {
            const { rows: cached } = await pool.query(
                `SELECT product_data FROM product_cache
                 WHERE barcode = $1
                 AND expires_at > NOW()`,
                [body.barcode]
            );

            if (cached.length > 0) {
                // Update access count
                await pool.query(
                    `UPDATE product_cache
                     SET access_count = access_count + 1
                     WHERE barcode = $1`,
                    [body.barcode]
                );

                return reply.send({
                    product: cached[0].product_data,
                    source: 'cache'
                });
            }
        }

        try {
            let url: string;
            if (body.barcode) {
                url = `https://world.openfoodfacts.org/api/v0/product/${body.barcode}.json`;
            } else {
                url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(body.query!)}&search_simple=1&action=process&json=1&page_size=5&tagtype_0=countries&tag_contains_0=contains&tag_0=turkey`;
            }

            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'VitalityApp/1.0 (https://vitalityapp.io)'
                }
            });

            if (!response.ok) {
                throw new Error(`Open Food Facts API error: ${response.status}`);
            }

            const data = await response.json();

            if (body.barcode) {
                // Single product lookup
                if (data.status !== 1 || !data.product) {
                    return reply.send({ product: null, source: 'openfoodfacts' });
                }

                const product = normalizeProduct(data.product);

                // Cache the product
                await pool.query(
                    `INSERT INTO product_cache(barcode, product_data, source, expires_at)
                     VALUES($1, $2, 'openfoodfacts', NOW() + INTERVAL '30 days')
                     ON CONFLICT (barcode) DO UPDATE SET
                       product_data = $2,
                       cached_at = NOW(),
                       expires_at = NOW() + INTERVAL '30 days',
                       access_count = product_cache.access_count + 1`,
                    [body.barcode, JSON.stringify(product)]
                );

                return reply.send({ product, source: 'openfoodfacts' });
            } else {
                // Search query
                const products = (data.products || []).slice(0, 5).map(normalizeProduct);
                return reply.send({ products, source: 'openfoodfacts' });
            }

        } catch (error: any) {
            req.log.error({ msg: 'Product lookup failed', error: error.message });
            return reply.status(500).send({
                error: 'Product lookup failed',
                details: error.message
            });
        }
    });

    /**
     * GET /grocery/categories/:store
     * Get category layout for a specific store
     */
    app.get('/grocery/categories/:store', async (req, reply) => {
        const store = (req.params as any).store?.toLowerCase();

        const storeLayouts: Record<string, string[]> = {
            migros: ['produce', 'protein', 'dairy', 'bakery', 'pantry', 'frozen', 'beverages', 'snacks', 'household'],
            bim: ['pantry', 'dairy', 'protein', 'produce', 'frozen', 'beverages', 'snacks', 'household'],
            a101: ['pantry', 'dairy', 'protein', 'produce', 'frozen', 'beverages', 'snacks', 'household'],
            carrefour: ['produce', 'protein', 'dairy', 'bakery', 'pantry', 'frozen', 'beverages', 'snacks', 'household'],
            sok: ['pantry', 'dairy', 'protein', 'produce', 'frozen', 'beverages', 'snacks', 'household']
        };

        const categoryLabels: Record<string, string> = {
            produce: 'Meyve & Sebze',
            protein: 'Et & Tavuk & Balık',
            dairy: 'Süt Ürünleri',
            bakery: 'Ekmek & Pastane',
            pantry: 'Temel Gıda',
            frozen: 'Dondurulmuş',
            beverages: 'İçecekler',
            snacks: 'Atıştırmalık',
            household: 'Ev Gereçleri',
            other: 'Diğer'
        };

        const layout = storeLayouts[store] || storeLayouts['migros'];

        return reply.send({
            store: store || 'migros',
            categories: layout,
            labels: categoryLabels
        });
    });
}

// ============ HELPERS ============

function normalizeProduct(product: any) {
    const nutriments = product.nutriments || {};

    return {
        barcode: product.code,
        name: product.product_name || 'Unknown Product',
        nameLocal: product.product_name_tr,
        brand: product.brands,
        category: product.categories?.split(',')[0]?.trim(),
        stores: product.stores?.split(',').map((s: string) => s.trim()).filter(Boolean),
        calories: nutriments['energy-kcal_100g'] || nutriments['energy-kcal'],
        protein: nutriments.proteins_100g || nutriments.proteins,
        carbs: nutriments.carbohydrates_100g || nutriments.carbohydrates,
        fat: nutriments.fat_100g || nutriments.fat,
        fiber: nutriments.fiber_100g,
        sugar: nutriments.sugars_100g,
        nutriScore: product.nutriscore_grade,
        novaGroup: product.nova_group,
        imageUrl: product.image_small_url || product.image_url,
        quantity: product.quantity,
        source: 'openfoodfacts'
    };
}
