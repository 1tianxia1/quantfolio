import { openDatabase } from '../src/db/driver.js';
import path from 'node:path';

const fp = path.resolve('C:/Users/Y/WorkBuddy/2026-08-07-16-01-31/quantfolio/server/data/quantfolio.db');
const db = await openDatabase(fp);
console.log('LIKE 002281 (库内真实代码) =', JSON.stringify(db.all("SELECT code, name FROM securities WHERE code LIKE ? OR name LIKE ? LIMIT 3", ['%002281%', '%002281%'])));
console.log('LIKE 光迅 (库内真实名称) =', JSON.stringify(db.all("SELECT code, name FROM securities WHERE code LIKE ? OR name LIKE ? LIMIT 3", ['%光迅%', '%光迅%'])));
console.log('全部代码 =', JSON.stringify(db.all('SELECT code, name FROM securities ORDER BY code').map(r => r.code + ':' + r.name)));
