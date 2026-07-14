const Database = require('better-sqlite3');
const db = new Database('contracts.db');

// Включаем WAL-режим для ускорения записи
db.pragma('journal_mode = WAL');

// Создаем все нужные таблицы:
// 1. active_contracts - для текущих контрактов
// 2. contract_history - для архивных завершенных контрактов
// 3. treasury - для баланса казны
db.exec(`
    CREATE TABLE IF NOT EXISTS active_contracts (
        msgId TEXT PRIMARY KEY, 
        creatorId TEXT, 
        endTime INTEGER
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
`);

// Инициализируем казну, если её еще нет
db.prepare('INSERT OR IGNORE INTO treasury (id, balance) VALUES (1, 0)').run();

module.exports = db;