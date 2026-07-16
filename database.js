const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Путь к папке тома (Volume), которая сохраняется после рестарта
const dbDir = '/app/contracts-db';
const dbPath = path.join(dbDir, 'contracts.db');
console.log(`[DEBUG] Файл базы данных находится по пути: ${dbPath}`);
console.log(`[DEBUG] Папка существует: ${fs.existsSync(dbDir)}`);

// Гарантируем наличие папки
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

// Открываем базу данных
const db = new Database(dbPath);
db.pragma('synchronous = NORMAL');

// Включаем WAL-режим для надежности и скорости
db.pragma('journal_mode = WAL');

// Инициализация схем таблиц
db.exec(`
    CREATE TABLE IF NOT EXISTS active_contracts (
        msgId TEXT PRIMARY KEY, 
        creatorId TEXT, 
        endTime INTEGER,
        channelId TEXT
    );
    CREATE TABLE IF NOT EXISTS contract_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        msgId TEXT, 
        creatorId TEXT, 
        status TEXT, 
        finishedAt DATETIME
    );
    CREATE TABLE IF NOT EXISTS treasury (
        id INTEGER PRIMARY KEY CHECK (id = 1), 
        balance INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS debtors (
        name TEXT PRIMARY KEY, 
        amount INTEGER
    );
`);

// Инициализируем казну
db.prepare('INSERT OR IGNORE INTO treasury (id, balance) VALUES (1, 0)').run();

module.exports = db;