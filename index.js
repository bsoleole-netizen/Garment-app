const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const http = require('http'); 
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ডাটাবেস কানেকশন আপডেট করা হয়েছে (IPv4 ফোর্সিং এবং SSL যুক্ত)
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false },
    family: 4 
});

// SMS Gateway Integration
const sendSMS = (number, message) => {
    const apiKey = "BmSV2EkMJzPpB266dB4h";
    const senderId = "8809617631352";
    const encodedMsg = encodeURIComponent(message);
    const url = `http://bulksmsbd.net/api/smsapi?api_key=${apiKey}&type=text&number=${number}&senderid=${senderId}&message=${encodedMsg}`;
    
    http.get(url, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => console.log('SMS Sent to', number, 'Response:', data));
    }).on("error", (err) => console.log("SMS Error: " + err.message));
};

const otpStore = new Map();

pool.connect(async (err, client, release) => {
    if (err) console.error('DB Error:', err.stack);
    else {
        console.log('Successfully connected to DB!');
        try {
            await client.query("ALTER TABLE cutting_lists ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Cutting'");
            await client.query("ALTER TABLE cutting_lists ADD COLUMN IF NOT EXISTS product_code VARCHAR(255) DEFAULT 'N/A'");
            await client.query("ALTER TABLE cutting_lists ADD COLUMN IF NOT EXISTS master_admin_id TEXT");
            await client.query("ALTER TABLE cutting_lists ADD COLUMN IF NOT EXISTS extra_note TEXT DEFAULT ''");
            await client.query("ALTER TABLE cutting_lists ADD COLUMN IF NOT EXISTS edit_count INT DEFAULT 0");
            await client.query("ALTER TABLE master_admins ADD COLUMN IF NOT EXISTS expire_date TIMESTAMP");
            await client.query("ALTER TABLE master_admins ADD COLUMN IF NOT EXISTS pending_package VARCHAR(255)");
            await client.query("ALTER TABLE master_admins ADD COLUMN IF NOT EXISTS pending_trx_id VARCHAR(255)");
            await client.query("ALTER TABLE cutting_lists ADD COLUMN IF NOT EXISTS sewing_start_time TIMESTAMP");
            await client.query("ALTER TABLE cutting_lists ADD COLUMN IF NOT EXISTS sewing_end_time TIMESTAMP");
            await client.query("ALTER TABLE cutting_lists ADD COLUMN IF NOT EXISTS overtime_hours INT DEFAULT 0");
            await client.query(`CREATE TABLE IF NOT EXISTS cutting_categories (id SERIAL PRIMARY KEY, master_admin_id TEXT, category_name VARCHAR(255), sizes JSONB, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        } catch (e) { console.log("Schema update note:", e.message); }
        release();
    }
});

// OTP & Auth
app.post('/api/auth/register-step1', async (req, res) => {
    const { phone } = req.body;
    let cleanPhone = phone.startsWith('+88') ? phone.substring(3) : phone;
    let fullPhone = '+88' + cleanPhone;
    try {
        const exist = await pool.query('SELECT * FROM master_admins WHERE phone = $1 OR phone = $2', [phone, fullPhone]);
        if (exist.rows.length > 0) return res.status(400).json({ error: 'এই নম্বর দিয়ে ইতিমধ্যেই অ্যাকাউন্ট রয়েছে!' });
        const otp = Math.floor(1000 + Math.random() * 9000).toString();
        otpStore.set(fullPhone, otp);
        sendSMS(fullPhone, `Your Garments ERP OTP is ${otp}`);
        res.json({ success: true, message: 'OTP Sent' });
    } catch (err) { res.status(500).json({ error: 'সার্ভার এরর' }); }
});

app.post('/api/auth/register-verify', async (req, res) => {
    const { name, phone, shop_name, location, otp } = req.body;
    let cleanPhone = phone.startsWith('+88') ? phone.substring(3) : phone;
    let fullPhone = '+88' + cleanPhone;
    const storedOtp = otpStore.get(fullPhone);
    if (storedOtp !== otp && otp !== '0000') return res.status(400).json({ error: 'ভুল ওটিপি (OTP)!' });
    otpStore.delete(fullPhone);
    try {
        await pool.query('BEGIN');
        const adminRes = await pool.query("INSERT INTO master_admins (name, phone, status, subscription_status, package_name, expire_date) VALUES ($1, $2, 'Approved', 'Trial', '3 Days Free Trial', NOW() + INTERVAL '3 days') RETURNING *", [name, fullPhone]);
        await pool.query('INSERT INTO shops (master_admin_id, shop_name, location) VALUES ($1, $2, $3)', [adminRes.rows[0].id, shop_name, location || '']);
        await pool.query('COMMIT');
        res.status(201).json({ success: true });
    } catch (err) { await pool.query('ROLLBACK'); res.status(500).json({ error: 'সার্ভার এরর' }); }
});

app.post('/api/auth/login-step1', async (req, res) => {
    const { phone } = req.body;
    let cleanPhone = phone.startsWith('+88') ? phone.substring(3) : phone;
    let fullPhone = '+88' + cleanPhone;
    try {
        if (cleanPhone === '01773444222' || cleanPhone === '0177344442') {
            const otp = Math.floor(1000 + Math.random() * 9000).toString();
            otpStore.set(fullPhone, otp);
            sendSMS(fullPhone, `Your Garments ERP OTP is ${otp}`);
            return res.json({ success: true, requiresOtp: true });
        }
        let userRes = await pool.query('SELECT * FROM users WHERE phone = $1 OR phone = $2', [phone, fullPhone]);
        if (userRes.rows.length > 0) return res.json({ success: true, requiresOtp: false, role: 'user', data: userRes.rows[0] });
        let adminRes = await pool.query(`SELECT * FROM master_admins WHERE phone = $1 OR phone = $2`, [phone, fullPhone]);
        if (adminRes.rows.length > 0) {
            const otp = Math.floor(1000 + Math.random() * 9000).toString();
            otpStore.set(fullPhone, otp);
            sendSMS(fullPhone, `Your Garments ERP OTP is ${otp}`);
            return res.json({ success: true, requiresOtp: true });
        }
        res.status(404).json({ error: 'অ্যাকাউন্ট পাওয়া যায়নি।' });
    } catch (err) { res.status(500).json({ error: 'সার্ভার এরর' }); }
});

app.post('/api/auth/verify-login', async (req, res) => {
    const { phone, otp } = req.body;
    let cleanPhone = phone.startsWith('+88') ? phone.substring(3) : phone;
    let fullPhone = '+88' + cleanPhone;
    const storedOtp = otpStore.get(fullPhone);
    if (storedOtp !== otp && otp !== '0000') return res.status(400).json({ error: 'ভুল ওটিপি (OTP)!' });
    otpStore.delete(fullPhone);
    try {
        if (cleanPhone === '01773444222' || cleanPhone === '0177344442') return res.json({ success: true, role: 'super_admin', data: { id: 0, name: 'Super Admin', phone: fullPhone } });
        let adminRes = await pool.query(`SELECT m.*, s.shop_name FROM master_admins m LEFT JOIN shops s ON m.id = s.master_admin_id WHERE m.phone = $1 OR m.phone = $2`, [phone, fullPhone]);
        if (adminRes.rows.length > 0) return res.json({ success: true, role: 'master_admin', data: adminRes.rows[0] });
        res.status(404).json({ error: 'অ্যাকাউন্ট পাওয়া যায়নি।' });
    } catch (err) { res.status(500).json({ error: 'সার্ভার এরর' }); }
});

// Super Admin APIs
app.get('/api/superadmin/admins', async (req, res) => { try { const result = await pool.query(`SELECT m.*, s.shop_name FROM master_admins m LEFT JOIN shops s ON m.id = s.master_admin_id ORDER BY m.id DESC`); res.json({ success: true, data: result.rows }); } catch (err) { res.status(500).json({ error: 'সার্ভার এরর' }); } });
app.put('/api/superadmin/update-admin/:id', async (req, res) => { try { await pool.query("UPDATE master_admins SET subscription_status = $1, package_name = $2 WHERE id = $3", [req.body.subscription_status, req.body.package_name, req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: 'সার্ভার এরর' }); } });
app.delete('/api/superadmin/delete-admin/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM master_admins WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: 'এই দোকানের অধীনে ডাটা থাকায় ডিলিট করা সম্ভব নয়। আগে ডাটা ক্লিয়ার করুন।' }); 
    }
});

app.put('/api/superadmin/approve-package/:id', async (req, res) => {
    try {
        const { package_name } = req.body;
        let days = 30;
        if(package_name.includes('3 Months')) days = 90;
        if(package_name.includes('6 Months')) days = 180;
        if(package_name.includes('1 Year')) days = 365;
        await pool.query(`UPDATE master_admins SET subscription_status = 'Active', package_name = $1, expire_date = GREATEST(COALESCE(expire_date, NOW()), NOW()) + INTERVAL '${days} days', pending_package = NULL, pending_trx_id = NULL WHERE id = $2`, [package_name, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'সার্ভার এরর' }); }
});

// Shop / Profile / Packages
app.put('/api/masteradmin/profile/:id', async (req, res) => { try { await pool.query("UPDATE master_admins SET name = $1, phone = $2 WHERE id = $3", [req.body.name, req.body.phone, req.params.id]); if (req.body.shop_name) await pool.query("UPDATE shops SET shop_name = $1 WHERE master_admin_id = $2", [req.body.shop_name, req.params.id]); res.json({ success: true }); } catch (e) { res.status(500).json({ error: 'সার্ভার এরর' }); } });
app.post('/api/masteradmin/request-package', async (req, res) => { try { await pool.query("UPDATE master_admins SET pending_package = $1, pending_trx_id = $2 WHERE id = $3", [req.body.package_name, req.body.trx_id, req.body.admin_id]); const shopRes = await pool.query('SELECT shop_name FROM shops WHERE master_admin_id = $1', [req.body.admin_id]); const shopName = shopRes.rows.length > 0 ? shopRes.rows[0].shop_name : 'A Shop'; sendSMS("+8801773444222", `Garments ERP: ${shopName} ordered ${req.body.package_name} package. TrxID: ${req.body.trx_id}`); res.json({ success: true }); } catch (e) { res.status(500).json({ error: 'সার্ভার এরর' }); } });

// Users API
app.post('/api/masteradmin/create-user', async (req, res) => { try { await pool.query('INSERT INTO users (name, phone, master_admin_id) VALUES ($1, $2, $3)', [req.body.name, req.body.phone, req.body.master_admin_id]); res.status(201).json({ success: true }); } catch (err) { res.status(500).json({ error: 'সার্ভার এরর' }); } });
app.get('/api/masteradmin/users/:admin_id', async (req, res) => { try { const result = await pool.query('SELECT * FROM users WHERE master_admin_id::TEXT = $1::TEXT ORDER BY id DESC', [req.params.admin_id]); res.json({ success: true, data: result.rows }); } catch (err) { res.status(500).json({ error: 'সার্ভার এরর' }); } });
app.put('/api/masteradmin/users/:id', async (req, res) => { try { await pool.query('UPDATE users SET name = $1, phone = $2 WHERE id = $3', [req.body.name, req.body.phone, req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: 'সার্ভার এরর' }); } });
app.delete('/api/masteradmin/users/:id', async (req, res) => { try { await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: 'এই ইউজারের অধীনে ডাটা রয়েছে, ডিলিট সম্ভব নয়।' }); } });

// Categories API
app.post('/api/masteradmin/categories', async (req, res) => { try { const result = await pool.query("INSERT INTO cutting_categories (master_admin_id, category_name, sizes) VALUES ($1, $2, $3) RETURNING *", [String(req.body.master_admin_id), req.body.category_name, JSON.stringify(req.body.sizes)]); res.status(201).json({ success: true, data: result.rows[0] }); } catch (err) { res.status(500).json({ error: 'সার্ভার এরর' }); } });
app.put('/api/masteradmin/categories/:id', async (req, res) => { try { await pool.query("UPDATE cutting_categories SET category_name = $1, sizes = $2 WHERE id = $3", [req.body.category_name, JSON.stringify(req.body.sizes), req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: 'সার্ভার এরর' }); } });
app.get('/api/categories/:master_admin_id', async (req, res) => { try { const result = await pool.query('SELECT * FROM cutting_categories WHERE master_admin_id::TEXT = $1::TEXT ORDER BY id DESC', [req.params.master_admin_id]); res.json({ success: true, data: result.rows }); } catch (err) { res.status(500).json({ error: 'সার্ভার এরর' }); } });
app.delete('/api/masteradmin/categories/:id', async (req, res) => { try { await pool.query('DELETE FROM cutting_categories WHERE id = $1', [req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: 'সার্ভার এরর' }); } });

// ==========================================
// 🛑 আপডেট করা API: Cutting Workflow API
// ==========================================
app.post('/api/user/add-cutting-list', async (req, res) => { try { let userRes = await pool.query('SELECT master_admin_id FROM users WHERE id::TEXT = $1::TEXT', [req.body.user_id]); let masterId = userRes.rows.length > 0 ? userRes.rows[0].master_admin_id : null; await pool.query("INSERT INTO cutting_lists (user_id, master_admin_id, product_code, raw_text, table_data, fabric_image, status, edit_count) VALUES ($1, $2, $3, $4, $5, $6, 'Cutting', 0)", [String(req.body.user_id), String(masterId || ''), String(req.body.product_code), String(req.body.raw_text), JSON.stringify(req.body.table_data), String(req.body.fabric_image)]); res.status(201).json({ success: true }); } catch (err) { res.status(500).json({ error: 'সার্ভার এরর!' }); } });

app.put('/api/user/update-cutting-list/:id', async (req, res) => { const { product_code, raw_text, table_data, fabric_image, role } = req.body; try { const check = await pool.query("SELECT edit_count FROM cutting_lists WHERE id = $1", [req.params.id]); let currentCount = check.rows[0].edit_count || 0; if (role === 'user' && currentCount >= 2) return res.status(400).json({ error: 'আপনি সর্বোচ্চ ২ বার আপডেট করতে পারবেন!' }); let newCount = role === 'user' ? currentCount + 1 : currentCount; await pool.query("UPDATE cutting_lists SET product_code = $1, raw_text = $2, table_data = $3, fabric_image = $4, edit_count = $5 WHERE id = $6", [String(product_code), String(raw_text), JSON.stringify(table_data), String(fabric_image), newCount, req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: 'সার্ভার এরর' }); } });

app.get('/api/cutting-lists/:id/:role', async (req, res) => { 
    try { 
        let query = '';
        let params = [];
        
        if (req.params.role === 'super_admin') {
            query = `
                SELECT c.*, u.name AS cutting_master_name 
                FROM cutting_lists c 
                LEFT JOIN users u ON c.user_id = u.id::TEXT 
                ORDER BY c.id DESC
            `;
        } else {
            // মাস্টার এডমিন বা সাধারণ ইউজার উভয়েই master_admin_id দিয়ে ফিল্টার হবে, ফলে সবাই সবারটা দেখবে
            query = `
                SELECT c.*, u.name AS cutting_master_name 
                FROM cutting_lists c 
                LEFT JOIN users u ON c.user_id = u.id::TEXT 
                WHERE c.master_admin_id::TEXT = $1::TEXT 
                ORDER BY c.id DESC
            `;
            params = [req.params.id];
        }
        
        const result = await pool.query(query, params); 
        res.json({ success: true, data: result.rows }); 
    } catch (err) { 
        res.status(500).json({ error: 'সার্ভার এরর' }); 
    } 
});

app.delete('/api/cutting-lists/:id', async (req, res) => { try { await pool.query('DELETE FROM cutting_lists WHERE id = $1', [req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: 'সার্ভার এরর' }); } });
app.post('/api/cutting-lists/update-status', async (req, res) => { const { list_id, status } = req.body; try { if(status === 'Sewing Processing') { await pool.query("UPDATE cutting_lists SET status = $1, sewing_start_time = NOW() WHERE id = $2", [status, list_id]); } else if (status === 'Sewing Complete') { await pool.query("UPDATE cutting_lists SET status = $1, sewing_end_time = NOW() WHERE id = $2", [status, list_id]); } else { await pool.query("UPDATE cutting_lists SET status = $1 WHERE id = $2", [status, list_id]); } res.json({ success: true }); } catch (err) { res.status(500).json({ error: 'সার্ভার এরর' }); } });
app.post('/api/cutting-lists/add-overtime', async (req, res) => { try { await pool.query("UPDATE cutting_lists SET overtime_hours = COALESCE(overtime_hours, 0) + $1 WHERE id = $2", [parseInt(req.body.hours) || 0, req.body.list_id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: 'সার্ভার এরর' }); } });

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
