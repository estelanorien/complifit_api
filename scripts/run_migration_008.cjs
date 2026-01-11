// scripts/run_migration_008_cjs.js
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load env vars from the API project
const envPath = path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing Supabase URL or Key in .env');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function runMigration() {
    console.log('Running Migration 008: Add FCM Token (CommonJS)...');
    const migrationPath = path.resolve(__dirname, '../migrations/008_add_fcm_token.sql');

    try {
        const sql = fs.readFileSync(migrationPath, 'utf8');
        console.log('SQL Loaded, executing via RPC exec_sql...');

        const { data, error } = await supabase.rpc('exec_sql', { sql_query: sql });

        if (error) {
            console.error('Migration RPC Failed:', error.message);
            // Try connecting via direct SQL if possible? No, we rely on RPC usually.
        } else {
            console.log('Migration 008 Applied Successfully!');
        }
    } catch (e) {
        console.error('Error reading/executing migration:', e);
    }
}

runMigration();
