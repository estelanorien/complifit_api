
import { pool } from '../src/infra/db/pool.js';

async function main() {
    const res = await pool.query("SELECT key FROM cached_assets WHERE key LIKE '%step_5%' OR key LIKE '%step5%'");
    console.log(res.rows.map(r => r.key));
    process.exit(0);
}
main();
