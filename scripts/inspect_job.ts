import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        const jobId = 'c04699cb-da03-48c0-9773-551514025837';
        const res = await pool.query(
            "SELECT id, type, status, payload, error, started_at, completed_at FROM generation_jobs WHERE id = $1",
            [jobId]
        );
        console.log(JSON.stringify(res.rows[0], null, 2));

        // Let's also check the assets for this group
        const payload = res.rows[0]?.payload;
        if (payload && payload.groupId) {
            console.log("\n--- GROUP ASSETS ---");
            const assets = await pool.query(
                "SELECT key, status, updated_at FROM cached_assets WHERE key LIKE $1 OR key LIKE $2",
                [`%_${payload.groupId}_%`, `%${payload.groupName.toLowerCase().replace(/ /g, '_')}%`]
            );
            console.log(JSON.stringify(assets.rows, null, 2));
        }

    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

run();
