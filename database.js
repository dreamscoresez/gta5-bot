const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Путь к папке, которую ты примонтировал в Railway как Volume
const dbDir = '/app/contracts-db';
const dbPath = path.join(dbDir, 'contracts.db');

// Проверяем, существует ли папка, если нет — создаем её
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// Включаем WAL-режим для ускорения записи
db.pragma('journal_mode = WAL');

// Обновляем схему
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

// Инициализируем казну, если её еще нет
db.prepare('INSERT OR IGNORE INTO treasury (id, balance) VALUES (1, 0)').run();

module.exports = db;