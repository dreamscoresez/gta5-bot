const Database = require('better-sqlite3');
const db = new Database('/app/contracts-db/contracts.db'); // Укажите ваш путь к базе

const msgId = '1527353901257330843';

try {
    const info = db.prepare('DELETE FROM active_contracts WHERE msgId = ?').run(msgId);
    if (info.changes > 0) {
        console.log(`✅ Контракт ${msgId} успешно удален.`);
    } else {
        console.log(`⚠️ Контракт ${msgId} не найден.`);
    }
} catch (err) {
    console.error('Ошибка при удалении:', err);
}