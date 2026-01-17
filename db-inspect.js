
import pg from 'pg';
const { Client } = pg;

const queryArg = process.argv.slice(2).find(arg => arg.startsWith('--query='))?.split('=')[1] || process.argv[process.argv.indexOf('--query') + 1];

async function run() {
    const client = new Client({
        connectionString: 'postgresql://postgres:6fk23az4_F@104.199.2.9:5432/vitality_db',
        ssl: { rejectUnauthorized: false }
    });
    await client.connect();
    const query = queryArg || "SELECT email, role FROM users WHERE role IN ('admin', 'owner')";
    try {
        const res = await client.query(query);
        console.log('Query Results:', JSON.stringify(res.rows, null, 2));
    } catch (e) {
        console.error('Query Error:', e.message);
    } finally {
        await client.end();
    }
}
run();
