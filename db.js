const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('Database connection error:', err.stack);
    } else {
        console.log('Successfully connected to the Supabase database!');
    }
});

module.exports = pool;