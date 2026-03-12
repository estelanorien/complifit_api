
import { pool } from '../src/infra/db/pool.js';
import crypto from 'crypto';
import fs from 'fs';

async function main() {
    const logFile = 'insert_debug.log';
    const log = (msg: string) => {
        console.log(msg);
        fs.appendFileSync(logFile, msg + '\n');
    };

    fs.writeFileSync(logFile, "=== Start Debug Insert ===\n");

    try {
        const userId = crypto.randomUUID(); // Generate valid UUID
        log(`Generated UserUUID: ${userId}`);

        log("Attempting INSERT with valid UUID for user_id...");

        // Explicitly casting user_id to uuid if needed, usually string passed to uuid col works if format is correct
        const res = await pool.query(
            `INSERT INTO generation_jobs(user_id, type, payload, status) VALUES($1, $2, $3, $4) RETURNING id`,
            [userId, 'BATCH_ASSET_GENERATION', '{"test":true}', 'PENDING']
        );
        log(`SUCCESS! Inserted Job ID: ${res.rows[0].id}`);

    } catch (e: any) {
        log(`ERROR: ${e.message}`);
        if (e.detail) log(`DETAIL: ${e.detail}`);
        if (e.hint) log(`HINT: ${e.hint}`);
    } finally {
        await pool.end();
    }
}
main();
