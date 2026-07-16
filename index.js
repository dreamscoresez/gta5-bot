require('dotenv').config();
const { Client, GatewayIntentBits, ModalBuilder, ApplicationCommandType, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, MessageFlags, REST, Routes, SlashCommandBuilder } = require('discord.js');
const db = require('./database');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

process.on('unhandledRejection', error => { console.error('Unhandled rejection:', error); });
process.on('uncaughtException', err => { console.error('Uncaught exception:', err); });

const CONFIG = {
    PICK: process.env.PICK,
    PROCESS: process.env.PROCESS,
    PAY: process.env.PAY,
    ALLOWED_ROLES: process.env.ALLOWED_ROLES ? process.env.ALLOWED_ROLES.split(',') : []
};

const setupTimer = async (channel, creatorId, endTime) => {
    const remaining = endTime - Date.now();
    setTimeout(async () => {
        try {
            await channel.send(`⚠️ **ВРЕМЯ ВЫШЛО!** <@${creatorId}>, проверьте и закройте контракт после того как он завершится в игре!`);
        } catch (err) { console.error('Ошибка таймера:', err); }
    }, Math.max(0, remaining));
};

const commands = [
    new SlashCommandBuilder().setName('вызвать').setDescription('Создать контракт'),
    new SlashCommandBuilder().setName('казна').setDescription('Показать баланс казны'),
    new SlashCommandBuilder().setName('пополнить').setDescription('Пополнить казну').addIntegerOption(o => o.setName('сумма').setDescription('Сумма').setRequired(true)),
    new SlashCommandBuilder().setName('вычесть').setDescription('Списать из казны').addIntegerOption(o => o.setName('сумма').setDescription('Сумма').setRequired(true)),
    new SlashCommandBuilder().setName('должники').setDescription('Список должников'),
    new SlashCommandBuilder().setName('долг_добавить').setDescription('Добавить должника').addStringOption(o => o.setName('ник').setDescription('Ник').setRequired(true)).addIntegerOption(o => o.setName('сумма').setDescription('Сумма').setRequired(true)),
    new SlashCommandBuilder().setName('оплачено').setDescription('Закрыть долг').addStringOption(o => o.setName('ник').setDescription('Ник').setRequired(true)).addIntegerOption(o => o.setName('сумма').setDescription('Сумма').setRequired(true)),
    new SlashCommandBuilder().setName('чек_контракты').setDescription('Принудительно проверить все таймеры'),
    new SlashCommandBuilder().setName('статистика').setDescription('Показать актуальную статистику бота'),
    new SlashCommandBuilder().setName('контракт_список').setDescription('Список активных контрактов'),
    { name: 'Импортировать контракт', type: ApplicationCommandType.Message },
    { name: 'Закрыть контракт', type: ApplicationCommandType.Message }
];

client.once('clientReady', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });

    const treasury = db.prepare('SELECT balance FROM treasury WHERE id = 1').get();
    const debtorsList = db.prepare('SELECT name, amount FROM debtors').all();
    const stats = db.prepare('SELECT status, COUNT(*) as count FROM contract_history GROUP BY status').all();
    const activeCount = db.prepare('SELECT COUNT(*) as count FROM active_contracts').get();

    let logMsg = `\n🚀 Бот ${client.user.tag} запущен!\n📊 --- СТАТИСТИКА БОТА ---\n`;
    logMsg += `💰 Баланс казны: ${(treasury?.balance || 0).toLocaleString()} $\n`;
    logMsg += `👥 Должники (${debtorsList.length} чел.):\n`;
    debtorsList.forEach(d => { logMsg += `   • ${d.name}: ${d.amount.toLocaleString()} $\n`; });
    logMsg += `✅ Успешных: ${stats.find(s => s.status === 'success')?.count || 0}\n`;
    logMsg += `❌ Проваленных: ${stats.find(s => s.status === 'fail')?.count || 0}\n`;
    logMsg += `⏳ Активных: ${activeCount.count || 0}\n--------------------------`;
    console.log(logMsg);

    const activeContracts = db.prepare('SELECT * FROM active_contracts').all();
    for (const contract of activeContracts) {
        try {
            const channel = await client.channels.fetch(contract.channelId);
            if (Date.now() >= contract.endTime) {
                await channel.send(`⚠️ **ВРЕМЯ КОНТРАКТА ВЫШЛО!** <@${contract.creatorId}>, проверьте и закройте его.`);
                db.prepare('DELETE FROM active_contracts WHERE msgId = ?').run(contract.msgId);
            } else {
                setupTimer(channel, contract.creatorId, contract.endTime);
                console.log(`[TIMER] Восстановлен таймер для контракта ${contract.msgId}`);
            }
        } catch (err) { console.error(`Ошибка восстановления контракта ${contract.msgId}:`, err); }
    }
});

client.on('messageCreate', async msg => {
    if (msg.author.bot) return;
// --- АДМИН КОМАНДЫ ---
    // Этот блок теперь включает !импорт_контракт, !закрыть_контракт и !список
    if (msg.content.startsWith('!импорт_контракт') || msg.content.startsWith('!закрыть_контракт') || msg.content.startsWith('!список')) {
        const hasRole = msg.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
        if (!hasRole) return await msg.reply('❌ Нет прав.');
        
        // ЛОГИКА ДЛЯ !список
        if (msg.content.startsWith('!список')) {
            const activeContracts = db.prepare('SELECT msgId, creatorId, endTime FROM active_contracts').all();
            console.log(`\n📋 АКТИВНЫЕ КОНТРАКТЫ (${activeContracts.length}):`);
            if (activeContracts.length === 0) {
                console.log(' - Активных контрактов нет.');
            } else {
                activeContracts.forEach(c => {
                    const timeLeft = Math.round((c.endTime - Date.now()) / 60000);
                    console.log(` • MsgID: ${c.msgId} | Creator: ${c.creatorId} | Осталось: ${timeLeft > 0 ? timeLeft + ' мин.' : 'Истекло'}`);
                });
            }
            console.log('------------------------------------\n');
            return await msg.reply('✅ Список контрактов выведен в консоль Railway.');
        }

        // ЛОГИКА ДЛЯ ИМПОРТА И ЗАКРЫТИЯ
        if (!msg.reference) return await msg.reply('❌ Ответь на сообщение!');
        try {
            const targetMsg = await msg.channel.messages.fetch(msg.reference.messageId);
            if (msg.content.startsWith('!импорт_контракт')) {
                db.prepare('INSERT OR REPLACE INTO active_contracts (msgId, creatorId, endTime, channelId) VALUES (?, ?, ?, ?)')
                    .run(targetMsg.id, targetMsg.author.id, Date.now() + 86400000, targetMsg.channelId);
                await msg.reply('✅ Импортировано.');
            }
            if (msg.content.startsWith('!закрыть_контракт')) {
                db.prepare('DELETE FROM active_contracts WHERE msgId = ?').run(targetMsg.id);
                await targetMsg.edit({ components: [] });
                await msg.reply('✅ Закрыто.');
            }
        } catch (err) { await msg.reply('❌ Ошибка.'); }
        return; 
    }
    // ---------------------
    if ((msg.channel.id === CONFIG.PICK || msg.channel.id === CONFIG.PROCESS) && msg.content !== '!подтвердить') {
        await msg.delete().catch(() => {});
        console.log(`[DELETE] Удалено сообщение от ${msg.author.tag} в #${msg.channel.name}: "${msg.content.substring(0, 50)}"`);
        return;
    }

    if (msg.channel.id === CONFIG.PAY && msg.content.trim() === '!подтвердить') {
        const hasRole = msg.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
        if (!hasRole) return await msg.reply('❌ У вас нет прав проверяющего.');
        if (!msg.reference || !msg.reference.messageId) return await msg.reply('❌ Ответьте на сообщение с контрактом.');

        try {
            const targetMsg = await msg.channel.messages.fetch(msg.reference.messageId);
            if (!targetMsg) return await msg.reply('❌ Сообщение не найдено.');

            // ── Логирование подтверждения ────────────────────────
            console.log(`[LOG] !подтвердить от ${msg.author.tag}`);
            console.log(`[LOG] Контракт: ${targetMsg.embeds[0]?.title || 'неизвестно'}`);

            let totalPaid = 0;
            targetMsg.embeds[0].fields.forEach(field => {
                const amount = parseInt(field.value.replace(/\D/g, '')) || 0;
                if (amount > 0) {
                    db.prepare('UPDATE debtors SET amount = amount - ? WHERE name = ?').run(amount, field.name);
                    const debtor = db.prepare('SELECT amount FROM debtors WHERE name = ?').get(field.name);
                    console.log(`   -> ${field.name}: ${amount.toLocaleString()} $ (Остаток: ${debtor ? debtor.amount.toLocaleString() : 0} $)`);
                    totalPaid += amount;
                }
            });

            db.prepare('DELETE FROM debtors WHERE amount <= 0').run();
            if (totalPaid > 0) db.prepare('UPDATE treasury SET balance = balance + ? WHERE id = 1').run(totalPaid);
            console.log(`[LOG] Итого в казну: ${totalPaid.toLocaleString()} $`);

            await targetMsg.edit({ content: `✅ **Оплата подтверждена! Проверяющий: <@${msg.author.id}>**`, components: [] });
            await msg.reply('✅ Контракт закрыт, долги обновлены.');
        } catch (err) {
            console.error(err);
            await msg.reply('❌ Ошибка при поиске сообщения.');
        }
    }
});

client.on('interactionCreate', async i => {
    try {
        // --- 1. ДОБАВЛЯЕМ ОБРАБОТКУ КОНТЕКСТНОГО МЕНЮ ---
        if (i.isMessageContextMenuCommand()) {
            const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
            if (!hasRole) return i.reply({ content: '❌ Нет прав.', flags: [MessageFlags.Ephemeral] });

            if (i.commandName === 'Импортировать контракт') {
                db.prepare('INSERT OR REPLACE INTO active_contracts (msgId, creatorId, endTime, channelId) VALUES (?, ?, ?, ?)')
                    .run(i.targetMessage.id, i.targetMessage.author.id, Date.now() + 86400000, i.targetMessage.channelId);
                return i.reply({ content: '✅ Импортировано.', flags: [MessageFlags.Ephemeral] });
            }
            if (i.commandName === 'Закрыть контракт') {
                db.prepare('DELETE FROM active_contracts WHERE msgId = ?').run(i.targetMessage.id);
                await i.targetMessage.edit({ components: [] }).catch(() => {});
                return i.reply({ content: '✅ Закрыто.', flags: [MessageFlags.Ephemeral] });
            }
        }
        if (i.isChatInputCommand()) {
            console.log(`[LOG] /${i.commandName} от ${i.user.tag}`);

            // ДОБАВЛЯЕМ СЮДА ЛОГИКУ ДЛЯ /контракт_список
            if (i.commandName === 'контракт_список') {
                const activeContracts = db.prepare('SELECT msgId, channelId, endTime FROM active_contracts').all();
                if (activeContracts.length === 0) return i.reply({ content: '📋 Нет активных контрактов.', flags: [MessageFlags.Ephemeral] });
                
                let text = '📋 **АКТИВНЫЕ КОНТРАКТЫ:**\n\n';
                for (const c of activeContracts) {
                    const timeLeft = Math.round((c.endTime - Date.now()) / 60000);
                    text += `• ID сообщения: ${c.msgId} | Осталось: ${timeLeft > 0 ? timeLeft + ' мин.' : 'Истекло'}\n`;
                }
                return i.reply({ content: text, flags: [MessageFlags.Ephemeral] });
            }
            console.log(`[LOG] /${i.commandName} от ${i.user.tag}`);

            if (i.commandName === 'казна') {
                const row = db.prepare('SELECT balance FROM treasury WHERE id = 1').get();
                return i.reply({ content: `💰 Баланс: **${(row?.balance || 0).toLocaleString()} $**`, flags: [MessageFlags.Ephemeral] });
            }
            if (i.commandName === 'должники') {
                const debtors = db.prepare('SELECT * FROM debtors').all();
                const text = debtors.length ? debtors.map(d => `• **${d.name}**: ${d.amount.toLocaleString()}$`).join('\n') : 'Должников нет.';
                return i.reply({ content: `📋 **Список должников:**\n${text}`, flags: [MessageFlags.Ephemeral] });
            }

            const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
            if (!hasRole) return i.reply({ content: '❌ Нет прав.', flags: [MessageFlags.Ephemeral] });

            if (i.commandName === 'вызвать') {
                if (i.channelId !== CONFIG.PICK) return i.reply({ content: '❌ Только в канале пика!', flags: [MessageFlags.Ephemeral] });
                return i.reply({
                    content: "📢 **ПАНЕЛЬ КОНТРАКТОВ**\n\nВы пикаете контракты в игре, после этого нажимаете на кнопку ниже, у вас открывается панель в которой вы вписываете данные для контракта который вы пикнули в игре.\nЗа всеми вопросами обращаться к <@702529657718833162>",
                    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('start').setLabel('Создать контракт').setStyle(ButtonStyle.Primary))]
                });
            }

            if (i.commandName === 'чек_контракты') {
                const activeContracts = db.prepare('SELECT * FROM active_contracts').all();
                for (const contract of activeContracts) {
                    const channel = await client.channels.fetch(contract.channelId);
                    setupTimer(channel, contract.creatorId, contract.endTime);
                }
                return i.reply({ content: `✅ Проверено: ${activeContracts.length}`, flags: [MessageFlags.Ephemeral] });
            }

            if (['пополнить', 'вычесть', 'долг_добавить', 'оплачено'].includes(i.commandName)) {
                const amt = i.options.getInteger('сумма') || 0;
                const nick = i.options.getString('ник');
                if (i.commandName === 'пополнить') db.prepare('UPDATE treasury SET balance = balance + ? WHERE id = 1').run(amt);
                if (i.commandName === 'вычесть') db.prepare('UPDATE treasury SET balance = balance - ? WHERE id = 1').run(amt);
                if (i.commandName === 'долг_добавить') db.prepare('INSERT OR REPLACE INTO debtors (name, amount) VALUES (?, ?)').run(nick, amt);
                if (i.commandName === 'оплачено') {
                    db.prepare('UPDATE debtors SET amount = amount - ? WHERE name = ?').run(amt, nick);
                    db.prepare('DELETE FROM debtors WHERE amount <= 0').run();
                }
                return i.reply({ content: '✅ Выполнено.', flags: [MessageFlags.Ephemeral] });
            }

            if (i.commandName === 'статистика') {
                const treasury = db.prepare('SELECT balance FROM treasury WHERE id = 1').get();
                const debtorsList = db.prepare('SELECT name, amount FROM debtors').all();
                const stats = db.prepare('SELECT status, COUNT(*) as count FROM contract_history GROUP BY status').all();
                const activeCount = db.prepare('SELECT COUNT(*) as count FROM active_contracts').get();

                let logMsg = `\n📊 --- СТАТИСТИКА БОТА (запрос от ${i.user.tag}) ---\n`;
                logMsg += `💰 Баланс казны: ${(treasury?.balance || 0).toLocaleString()} $\n`;
                logMsg += `👥 Должники (${debtorsList.length} чел.):\n`;
                debtorsList.forEach(d => { logMsg += `   • ${d.name}: ${d.amount.toLocaleString()} $\n`; });
                logMsg += `✅ Успешных: ${stats.find(s => s.status === 'success')?.count || 0}\n`;
                logMsg += `❌ Проваленных: ${stats.find(s => s.status === 'fail')?.count || 0}\n`;
                logMsg += `⏳ Активных контрактов: ${activeCount.count || 0}\n`;
                logMsg += `--------------------------`;

                console.log(logMsg);
                return i.reply({ content: '✅ Статистика выведена в логи.', flags: [MessageFlags.Ephemeral] });
            }
        }

        if (i.isButton()) {
            console.log(`[LOG] Кнопка: ${i.customId} от ${i.user.tag}`);

            if (i.customId === 'start') {
                // ── Логирование открытия формы ───────────────────────
                console.log(`[LOG] Открыта форма создания контракта от ${i.user.tag}`);
                const modal = new ModalBuilder().setCustomId('m').setTitle('Создание контракта').addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('n').setLabel('Название').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ограбление')),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nicknames').setLabel('Ники (через ;)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Artem Minoru;Yuto Minoru')),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bills').setLabel('Векселя (через ;)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('25;20')),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('time').setLabel('Время (ЧЧ:ММ)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('ЧЧ:ММ'))
                );
                return i.showModal(modal);
            }

            if (i.customId === 'succ' || i.customId === 'fail') {
                const contract = db.prepare('SELECT creatorId FROM active_contracts WHERE msgId = ?').get(i.message.id);
                if (!contract) return i.reply({ content: '❌ Контракт не найден.', flags: [MessageFlags.Ephemeral] });

                const isAdmin = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                if (i.user.id !== contract.creatorId && !isAdmin) {
                    console.log(`[RESULT] ${i.customId} от ${i.user.tag}: ОТКАЗАНО.`);
                    return i.reply({ content: '❌ Только создатель или администратор может это сделать!', flags: [MessageFlags.Ephemeral] });
                }

                const oldEmbed = i.message.embeds[0];
                const timeField = oldEmbed.fields.find(f => f.name === 'Конец');
                const timestampMatch = timeField.value.match(/<t:(\d+):R>/);
                const endTime = parseInt(timestampMatch[1]) * 1000;

                if (Date.now() < endTime) {
                    return i.reply({ content: '❌ Рано! Таймер ещё не истёк.', flags: [MessageFlags.Ephemeral] });
                }

                await i.deferUpdate();
                db.prepare('DELETE FROM active_contracts WHERE msgId = ?').run(i.message.id);

                // Удаляем сообщение "ВРЕМЯ ВЫШЛО" если оно есть
                try {
                    const recentMessages = await i.channel.messages.fetch({ limit: 20 });
                    const timerMsg = recentMessages.find(m => 
                        m.author.id === client.user.id && 
                        m.content.includes('ВРЕМЯ ВЫШЛО')
                    );
                    if (timerMsg) {
                        await timerMsg.delete();
                        console.log(`[DELETE] Удалено сообщение "ВРЕМЯ ВЫШЛО" msgId: ${timerMsg.id}`);
                    }
                } catch (err) {
                    console.error('[ERROR] Не удалось удалить сообщение таймера:', err);
                }

                const isSuccess = i.customId === 'succ';
                const participants = oldEmbed.fields.filter(f => f.name !== 'Конец' && f.name !== 'ИНСТРУКЦИЯ');
                const multiplier = isSuccess ? (participants.length >= 2 ? 0.2 : 0.4) : (participants.length >= 2 ? 0.3 : 0.5);

                // ── Логирование кнопки succ/fail ─────────────────────
                console.log(`[LOG] Контракт "${oldEmbed.title}" завершён как ${isSuccess ? 'УСПЕХ' : 'ПРОВАЛ'} пользователем ${i.user.tag}`);
                console.log(`[LOG] Участники:`);
                participants.forEach(f => console.log(`   -> ${f.name}: ${f.value}`));

                const payEmbed = new EmbedBuilder()
                    .setTitle(oldEmbed.title)
                    .setColor(isSuccess ? 0x00FF00 : 0xFF0000)
                    .setDescription(
                        `**Исполнитель:** <@${contract.creatorId}>\n\n` +
                        `<@${contract.creatorId}>, внесите сумму в казну и нажмите кнопку **Оплатить**\n` +
                        `**Проверяющий:** после оплаты ответьте на это сообщение командой \`!подтвердить\``
                    );

                participants.forEach(f => {
                    const toPay = Math.round((parseInt(f.value.replace(/\D/g, '')) || 0) * 1000 * multiplier);
                    db.prepare('INSERT OR REPLACE INTO debtors (name, amount) VALUES (?, IFNULL((SELECT amount FROM debtors WHERE name = ?), 0) + ?)').run(f.name, f.name, toPay);
                    payEmbed.addFields({ name: f.name, value: `${toPay.toLocaleString()} $` });
                });

                await i.message.edit({
                    content: `✅ Статус: **${isSuccess ? 'УСПЕХ ✅' : 'ПРОВАЛ ❌'}**`,
                    components: [],
                    embeds: [EmbedBuilder.from(oldEmbed).setColor(isSuccess ? 0x00FF00 : 0xFF0000)]
                });

                const payChannel = await client.channels.fetch(CONFIG.PAY);
                if (payChannel) {
                    const rolePings = CONFIG.ALLOWED_ROLES.map(r => `<@&${r}>`).join(' ');
                    await payChannel.send({
                        content: `${rolePings}`,
                        embeds: [payEmbed],
                        components: [new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId('pay_confirm').setLabel('Оплатить').setStyle(ButtonStyle.Success)
                        )]
                    });
                }

                console.log(`[RESULT] ${i.customId} от ${i.user.tag}: Обработано.`);
            }

            if (i.customId === 'pay_confirm') {
                const messages = await i.channel.messages.fetch({ limit: 10 });
                if (!messages.some(m => m.attachments.size > 0)) {
                    return i.reply({ content: '❌ Сначала прикрепите скриншот!', flags: [MessageFlags.Ephemeral] });
                }
                await i.update({
                    content: `⏳ **Ожидание подтверждения...**\nОплата от <@${i.user.id}>. Проверяющий, ответьте на это сообщение командой \`!подтвердить\`.`,
                    components: []
                });
            }
        }

        if (i.isModalSubmit() && i.customId === 'm') {
            await i.deferReply({ flags: [MessageFlags.Ephemeral] });

            const name = i.fields.getTextInputValue('n').trim();
            const nicknamesRaw = i.fields.getTextInputValue('nicknames').trim();
            const billsRaw = i.fields.getTextInputValue('bills').trim();
            const timeRaw = i.fields.getTextInputValue('time').trim();

            if (!/^[а-яА-ЯёЁ\s]+$/.test(name)) return i.editReply('❌ Название должно быть на кириллице.');
            if (!/^[a-zA-Z_\s;]+$/.test(nicknamesRaw)) return i.editReply('❌ Ники: только латиница, _, ;');
            if (!/^[0-9;]+$/.test(billsRaw)) return i.editReply('❌ Векселя: только цифры и ;');
            if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(timeRaw)) return i.editReply('❌ Время: формат ЧЧ:ММ');

            const nicknames = nicknamesRaw.split(';');
            const bills = billsRaw.split(';');
            if (nicknames.length !== bills.length) return i.editReply('❌ Количество ников не совпадает с количеством векселей.');

            const [h, m] = timeRaw.split(':').map(Number);
            const endTime = Date.now() + (h * 60 + m) * 60 * 1000;

            const embed = new EmbedBuilder().setTitle(name).setColor(0x0099FF);
            nicknames.forEach((nick, idx) => {
                embed.addFields({ name: nick.trim(), value: `Векселей: ${bills[idx] || 0}`, inline: false });
            });
            embed.addFields(
                { name: 'Конец', value: `<t:${Math.floor(endTime / 1000)}:R>`, inline: false },
                { name: 'ИНСТРУКЦИЯ', value: 'После таймера нажмите кнопку.', inline: false }
            );

            const processChannel = await client.channels.fetch(CONFIG.PROCESS);
            const msg = await processChannel.send({
                content: `Контракт взял: <@${i.user.id}>`,
                embeds: [embed],
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('succ').setLabel('Успех').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('fail').setLabel('Провал').setStyle(ButtonStyle.Danger)
                )]
            });

            db.prepare('INSERT OR REPLACE INTO active_contracts (msgId, creatorId, endTime, channelId) VALUES (?, ?, ?, ?)').run(msg.id, i.user.id, endTime, msg.channelId);
            setupTimer(msg.channel, i.user.id, endTime);

            // ── Логирование создания контракта ───────────────────
            console.log(`[RESULT] Контракт "${name}" создан от ${i.user.tag}`);
            console.log(`[LOG] Участники:`);
            nicknames.forEach((nick, idx) => console.log(`   -> ${nick.trim()}: ${bills[idx] || 0} векселей`));

            await i.editReply('✅ Контракт успешно создан!');
        }

    } catch (err) { console.error('Ошибка взаимодействия:', err); }
});

const shutdown = () => {
    try { db.close(); } catch (err) { console.error(err); }
    client.destroy();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(process.env.TOKEN);