
import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function inspect() {
    try {
        console.log('--- USERS TABLE ---');
        const { rows: usersCols } = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'users'
      ORDER BY column_name
    `);
        usersCols.forEach(r => console.log(`${r.column_name} (${r.data_type})`));

        console.log('\n--- USER_PROFILES TABLE ---');
        const { rows: profileCols } = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'user_profiles'
      ORDER BY column_name
    `);
        profileCols.forEach(r => console.log(`${r.column_name} (${r.data_type})`));

        console.log('\n--- DATA CHECK ---');
        const { rows: userCount } = await pool.query('SELECT COUNT(*) FROM users');
        console.log(`User count: ${userCount[0].count}`);

    } catch (e) {
        console.error('Inspection failed:', e);
    } finally {
        await pool.end();
    }
}

inspect();
