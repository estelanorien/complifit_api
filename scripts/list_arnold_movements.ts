
import { pool } from '../src/infra/db/pool.js';
import fs from 'fs';

async function main() {
    try {
        const res = await pool.query("SELECT id, name, metadata->>'movementId' as mid FROM training_exercises WHERE name ILIKE '%arnold_press%'");
        let output = `Found ${res.rows.length} movements\n`;
        for (const r of res.rows) {
            output += `${r.id} | ${r.name} | ${r.mid}\n`;
        }
        fs.writeFileSync('scripts/movements_results.txt', output);
        console.log("Done");
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
