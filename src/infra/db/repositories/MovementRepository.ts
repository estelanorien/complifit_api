import { pool } from '../pool.js';

export interface MovementSummary {
    id: string;
    name: string;
    type: 'ex' | 'meal';
    asset_status: {
        total: number;
        complete: number;
        failed: number;
    };
}

/**
 * MovementRepository - Data access for the core Exercises and Meals entities.
 * Decouples the domain logic from raw database schema.
 */
export class MovementRepository {

    /**
     * Fetch all available exercises with basic metadata.
     */
    static async findAllExercises(): Promise<any[]> {
        const res = await pool.query(`
            SELECT id, name, metadata, equipment, difficulty, created_at
            FROM training_exercises
            WHERE name IS NOT NULL AND name != ''
            ORDER BY name ASC
        `);
        return res.rows;
    }

    /**
     * Fetch all available meals.
     */
    static async findAllMeals(): Promise<any[]> {
        const res = await pool.query(`
            SELECT id, name, instructions, created_at
            FROM meals
            WHERE name IS NOT NULL AND name != ''
            ORDER BY name ASC
        `);
        return res.rows;
    }

    /**
     * Find a single exercise by ID.
     */
    static async findExerciseById(id: string): Promise<any | null> {
        const res = await pool.query(
            `SELECT id, name, metadata, equipment FROM training_exercises WHERE id = $1`,
            [id]
        );
        return res.rows[0] || null;
    }

    /**
     * Find a single meal by ID.
     */
    static async findMealById(id: string): Promise<any | null> {
        const res = await pool.query(
            `SELECT id, name, instructions, metadata FROM meals WHERE id = $1`,
            [id]
        );
        return res.rows[0] || null;
    }

    /**
     * Get unique movements (exercises and meals) for admin listing.
     * Consolidates logic from multiple tables.
     */
    static async getMovementManifest(): Promise<{ exercises: any[], meals: any[] }> {
        const exerciseRes = await pool.query(`
            SELECT DISTINCT ON (name) name, metadata, id
            FROM training_exercises
            WHERE name IS NOT NULL AND name != ''
            ORDER BY name, created_at DESC
        `);

        const mealRes = await pool.query(`
            SELECT DISTINCT ON (name) name, instructions, id
            FROM meals
            WHERE name IS NOT NULL AND name != ''
            ORDER BY name, created_at DESC
        `);

        return {
            exercises: exerciseRes.rows,
            meals: mealRes.rows
        };
    }

    /**
     * Sync metadata (instructions, safety, etc.) back to the entity table.
     */
    static async updateMetadata(type: 'ex' | 'meal', id: string, metadata: any): Promise<void> {
        if (type === 'ex') {
            await pool.query(
                `UPDATE training_exercises SET 
                    metadata = jsonb_set(COALESCE(metadata, '{}'), '{generated_instructions}', $1)
                 WHERE id = $2 OR name = $3`,
                [JSON.stringify(metadata), id, id.replace(/_/g, ' ')]
            );
        } else {
            await pool.query(
                `UPDATE meals SET 
                    instructions = $1, 
                    metadata = $2
                 WHERE id = $3 OR name = $4`,
                [JSON.stringify(metadata.instructions), JSON.stringify(metadata), id, id.replace(/_/g, ' ')]
            );
        }
    }
}
