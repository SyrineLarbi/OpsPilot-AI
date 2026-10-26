// Creates a console user, or resets the password of an existing one.
// Usage: node create-user.mjs <email> "<Nom affiché>" [admin|user] "<Société>"
// The company must exist (create it with: npm run setup). Without a company, only an existing user's password is reset.
// The password is generated and printed once (set OPSPILOT_PASSWORD to choose it yourself).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { hashPassword } from './auth.mjs';

const [email, name, role = 'admin', company = ''] = process.argv.slice(2);
if (!email || !name || !['admin', 'user'].includes(role)) {
  console.error('Usage : node create-user.mjs <email> "<Nom affiché>" [admin|user] "<Société>"');
  process.exit(1);
}

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(import.meta.dirname, '../../.env'), 'utf8').split('\n')
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
);
const password = process.env.OPSPILOT_PASSWORD
  || crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 10) + '-' + crypto.randomInt(10, 99);
if (password.length < 10) { console.error('Le mot de passe doit contenir au moins 10 caractères.'); process.exit(1); }

const db = new pg.Client({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME });
await db.connect();
const { rows: [c] } = await db.query('SELECT id FROM automation.companies WHERE lower(name) = lower($1)', [company]);
const { rows: [existing] } = await db.query('SELECT company_id FROM automation.users WHERE email = lower($1)', [email]);
if (!c && !existing) {
  console.error(company ? `Société « ${company} » introuvable. Créez-la avec : npm run setup` : 'Indiquez la société du nouvel utilisateur.');
  process.exit(1);
}
const { rows } = await db.query(
  `INSERT INTO automation.users (email, name, password_hash, role, company_id) VALUES (lower($1), $2, $3, $4, $5)
   ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, role = EXCLUDED.role
   RETURNING (xmax = 0) AS created`, [email, name, hashPassword(password), role, c?.id ?? existing.company_id]);
await db.query('DELETE FROM automation.sessions WHERE user_id = (SELECT id FROM automation.users WHERE email = lower($1))', [email]);
await db.end();

console.log(`${rows[0].created ? 'Utilisateur créé' : 'Mot de passe réinitialisé'} : ${email.toLowerCase()} (${role})`);
if (!process.env.OPSPILOT_PASSWORD) console.log(`Mot de passe : ${password}`);
