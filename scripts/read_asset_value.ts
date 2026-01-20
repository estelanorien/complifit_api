
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        const key = process.argv[2];
        const res = await pool.query("SELECT value FROM cached_assets WHERE key = $1", [key]);
        if (res.rows.length > 0) {
            console.log(res.rows[0].value);
        } else {
            console.log("Not found");
        }
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
