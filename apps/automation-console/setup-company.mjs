// Creates a company (name, currency, departments) and its first administrator.
// Usage: npm run setup            (asks the questions)
// Run it once per client company. The admin can later change the settings in the app (« Paramètres »).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import pg from 'pg';
import { hashPassword } from './auth.mjs';
import { CURRENCIES } from './rules.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DEFAULT_DEPARTMENTS = 'Achats, Finance, Informatique, Logistique, Marketing, Ressources humaines, Services généraux';

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, def = '') => (await rl.question(def ? `${q} [${def}] : ` : `${q} : `)).trim() || def;

console.log('\nNouvelle société\n');
const name = await ask('Nom de la société');
const currency = (await ask(`Devise par défaut (${CURRENCIES.join(', ')})`, 'TND')).toUpperCase();
const departments = [...new Set((await ask('Départements, séparés par des virgules', DEFAULT_DEPARTMENTS))
  .split(',').map((d) => d.trim()).filter(Boolean))];
console.log('\nPremier administrateur\n');
const email = (await ask('E-mail')).toLowerCase();
const adminName = await ask('Nom affiché');
rl.close();

if (name.length < 2 || !CURRENCIES.includes(currency) || !departments.length || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || adminName.length < 2) {
  console.error('\nInformations incomplètes ou invalides. Rien n’a été créé.');
  process.exit(1);
}

const db = new pg.Client({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME });
await db.connect();
await db.query(fs.readFileSync(path.join(ROOT, 'automation', 'schema.sql'), 'utf8'));
const password = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 10) + '-' + crypto.randomInt(10, 99);
try {
  await db.query('BEGIN');
  const { rows: [c] } = await db.query('INSERT INTO automation.companies (name, currency) VALUES ($1, $2) RETURNING id', [name, currency]);
  await db.query('INSERT INTO automation.departments (company_id, name) SELECT $1, unnest($2::text[])', [c.id, departments]);
  await db.query(`INSERT INTO automation.users (email, name, password_hash, role, company_id) VALUES ($1, $2, $3, 'admin', $4)`,
    [email, adminName, hashPassword(password), c.id]);
  await db.query('COMMIT');
} catch (e) {
  await db.query('ROLLBACK');
  console.error(e.code === '23505' ? '\nCette société ou cette adresse e-mail existe déjà. Rien n’a été créé.' : e.message);
  process.exit(1);
} finally {
  await db.end();
}

console.log(`\nSociété « ${name} » créée (${currency}, ${departments.length} départements).`);
console.log(`Administrateur : ${email}`);
console.log(`Mot de passe   : ${password}   (affiché une seule fois)`);
console.log(`Connexion      : ${env.CONSOLE_URL ?? 'http://localhost:4000'}\n`);
