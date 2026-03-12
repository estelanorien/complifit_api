
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        const res = await pool.query("SELECT key, length(data) as size FROM asset_blob_storage WHERE key LIKE 'ex:697608bb-e567-43fc-b51e-c556d3a2e4df%' ");
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (e: any) {
        console.error("Query Failed:", e.message);
    }
    process.exit(0);
}
main();
