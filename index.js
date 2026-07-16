require('dotenv').config();
const { Client, GatewayIntentBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, MessageFlags, REST, Routes, SlashCommandBuilder } = require('discord.js');
const db = require('./database');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

// --- ОБРАБОТЧИКИ ОШИБОК ---
process.on('unhandledRejection', error => { console.error('Unhandled rejection:', error); });
process.on('uncaughtException', err => { console.error('Uncaught exception:', err); });

const CONFIG = {
    PICK: process.env.PICK,
    PROCESS: process.env.PROCESS,
    PAY: process.env.PAY,
    ALLOWED_ROLES: process.env.ALLOWED_ROLES ? process.env.ALLOWED_ROLES.split(',') : []
};

// --- ФУНКЦИИ ---
const setupTimer = async (channel, creatorId, endTime) => {
    const remaining = endTime - Date.now();
    setTimeout(async () => {
        try { 
            await channel.send(`⚠️ **ВРЕМЯ ВЫШЛО!** <@${creatorId}>, проверьте и закройте контракт!`); 
        } catch (err) { 
            console.error('Ошибка таймера:', err); 
        }
    }, Math.max(0, remaining));
};

// --- КОМАНДЫ ---
const commands = [
    new SlashCommandBuilder().setName('вызвать').setDescription('Создать контракт'),
    new SlashCommandBuilder().setName('казна').setDescription('Показать баланс казны'),
    new SlashCommandBuilder().setName('пополнить').setDescription('Пополнить казну').addIntegerOption(o => o.setName('сумма').setDescription('Сумма').setRequired(true)),
    new SlashCommandBuilder().setName('вычесть').setDescription('Списать из казны').addIntegerOption(o => o.setName('сумма').setDescription('Сумма').setRequired(true)),
    new SlashCommandBuilder().setName('должники').setDescription('Список должников'),
    new SlashCommandBuilder().setName('долг_добавить').setDescription('Добавить должника').addStringOption(o => o.setName('ник').setDescription('Ник').setRequired(true)).addIntegerOption(o => o.setName('сумма').setDescription('Сумма').setRequired(true)),
    new SlashCommandBuilder().setName('оплачено').setDescription('Закрыть долг').addStringOption(o => o.setName('ник').setDescription('Ник').setRequired(true)).addIntegerOption(o => o.setName('сумма').setDescription('Сумма').setRequired(true)),
    new SlashCommandBuilder().setName('чек_контракты').setDescription('Принудительно проверить все таймеры')
];

// --- ЗАПУСК ---
client.once('clientReady', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    
    // Статистика при старте
    const treasury = db.prepare('SELECT balance FROM treasury WHERE id = 1').get();
    const debtorsList = db.prepare('SELECT name, amount FROM debtors').all();
    const stats = db.prepare('SELECT status, COUNT(*) as count FROM contract_history GROUP BY status').all();
    const activeCount = db.prepare('SELECT COUNT(*) as count FROM active_contracts').get();
    
    console.log(`🚀 Бот ${client.user.tag} запущен!`);
    console.log(`📊 --- СТАТИСТИКА БОТА ---`);
    console.log(`💰 Баланс казны: ${(treasury?.balance || 0).toLocaleString()} $`);
    console.log(`👥 Должники (${debtorsList.length} чел.):`);
    debtorsList.forEach(d => console.log(`   • ${d.name}: ${d.amount.toLocaleString()} $`));
    console.log(`✅ Успешных: ${stats.find(s => s.status === 'success')?.count || 0}`);
    console.log(`❌ Проваленных: ${stats.find(s => s.status === 'fail')?.count || 0}`);
    console.log(`⏳ Активных: ${activeCount.count || 0}`);
    console.log(`--------------------------`);

    const activeContracts = db.prepare('SELECT * FROM active_contracts').all();
    for (const contract of activeContracts) {
        try {
            if (Date.now() >= contract.endTime) {
                const channel = await client.channels.fetch(contract.channelId);
                await channel.send(`⚠️ **ВРЕМЯ КОНТРАКТА ВЫШЛО!** <@${contract.creatorId}>, проверьте и закройте его.`);
                db.prepare('DELETE FROM active_contracts WHERE msgId = ?').run(contract.msgId);
            } else {
                const channel = await client.channels.fetch(contract.channelId);
                setupTimer(channel, contract.creatorId, contract.endTime);
            }
        } catch (err) { console.error(`Ошибка восстановления ${contract.msgId}:`, err); }
    }
});

// --- СООБЩЕНИЯ ---
client.on('messageCreate', async msg => {
    if (msg.author.bot) return;

    if ((msg.channel.id === CONFIG.PICK || msg.channel.id === CONFIG.PROCESS) && msg.content !== '!подтвердить') {
        return await msg.delete().catch(() => {});
    }

    if (msg.channel.id === CONFIG.PAY && msg.content.toLowerCase().trim() === '!подтвердить') {
        const hasRole = msg.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
        if (!hasRole) return await msg.reply('❌ Ошибка! У вас нет прав проверяющего.');

        if (!msg.reference || !msg.reference.messageId) {
            return await msg.reply('❌ Ошибка! Вы должны ответить на сообщение с контрактом.');
        }

        try {
            const targetMsg = await msg.channel.messages.fetch(msg.reference.messageId);
            if (targetMsg.author.id !== client.user.id || !targetMsg.content.includes('⏳') && !targetMsg.embeds.length) {
                return await msg.reply('❌ Ошибка! Это не сообщение с ожиданием оплаты.');
            }

            console.log(`[LOG] Контракт закрыт пользователем: ${msg.author.tag}`);
            console.log(`[LOG] Списания по должникам:`);

            let totalPaid = 0;
            targetMsg.embeds[0].fields.forEach(field => {
                const amount = parseInt(field.value.replace(/\D/g, ''));
                if (!isNaN(amount)) {
                    db.prepare('UPDATE debtors SET amount = amount - ? WHERE name = ?').run(amount, field.name);
                    const debtor = db.prepare('SELECT amount FROM debtors WHERE name = ?').get(field.name);
                    console.log(`   -> ${field.name}: ${amount.toLocaleString()} $ (Остаток: ${debtor ? debtor.amount.toLocaleString() : 0} $)`);
                    totalPaid += amount;
                }
            });

            db.prepare('DELETE FROM debtors WHERE amount <= 0').run();
            if (totalPaid > 0) {
                db.prepare('UPDATE treasury SET balance = balance + ? WHERE id = 1').run(totalPaid);
            }

            await targetMsg.edit({ content: `✅ **Оплата подтверждена! Проверяющий: <@${msg.author.id}>**`, components: [] });
            await msg.reply('✅ Контракт успешно закрыт, долги обновлены.');
        } catch (err) {
            console.error(err);
            await msg.reply('❌ Ошибка при поиске сообщения.');
        }
    }
});

// --- ВЗАИМОДЕЙСТВИЯ (КНОПКИ И КОМАНДЫ) ---
client.on('interactionCreate', async i => {
    try {
        if (i.isChatInputCommand()) {
            console.log(`[LOG] Команда /${i.commandName} от ${i.user.tag}`);
            
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
            if (!hasRole) return i.reply({ content: '❌ Ошибка! У вас нет прав.', flags: [MessageFlags.Ephemeral] });

            if (i.commandName === 'вызвать') {
                return i.reply({ 
                    content: "📢 **ПАНЕЛЬ КОНТРАКТОВ**", 
                    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('start').setLabel('Создать контракт').setStyle(ButtonStyle.Primary))] 
                });
            }
            
            if (i.commandName === 'чек_контракты') {
                const activeContracts = db.prepare('SELECT * FROM active_contracts').all();
                for (const contract of activeContracts) {
                    const channel = await client.channels.fetch(contract.channelId);
                    setupTimer(channel, contract.creatorId, contract.endTime);
                }
                return i.reply({ content: `✅ Проверено контрактов: ${activeContracts.length}`, flags: [MessageFlags.Ephemeral] });
            }

            if (['пополнить', 'вычесть', 'долг_добавить', 'оплачено'].includes(i.commandName)) {
                const amt = i.options.getInteger('сумма');
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
        }

        if (i.isButton()) {
            console.log(`[LOG] Нажата кнопка: ${i.customId} от ${i.user.tag}`);
            
            if (i.customId === 'start') {
                const modal = new ModalBuilder().setCustomId('m').setTitle('Создание контракта').addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('n').setLabel('Название').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ограбление')),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nicknames').setLabel('Ники (через ;)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Artem;Yuto')),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bills').setLabel('Векселя (через ;)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('25;52')),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('time').setLabel('Время (ЧЧ:ММ)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('02:22'))
                );
                return i.showModal(modal);
            }
            
            if (i.customId === 'succ' || i.customId === 'fail') {
                const oldEmbed = i.message.embeds[0];
                const timeField = oldEmbed.fields.find(f => f.name === 'Конец');
                const timestampMatch = timeField.value.match(/<t:(\d+):R>/);
                const endTime = parseInt(timestampMatch[1]) * 1000;
                
                if (Date.now() < endTime) return i.reply({ content: '❌ Рано!', flags: [MessageFlags.Ephemeral] });
                
                await i.deferUpdate();
                db.prepare('DELETE FROM active_contracts WHERE msgId = ?').run(i.message.id);
                
                const isSuccess = i.customId === 'succ';
                db.prepare('INSERT INTO contract_history (msgId, creatorId, status, finishedAt) VALUES (?, ?, ?, ?)').run(i.message.id, i.user.id, isSuccess ? 'success' : 'fail', new Date().toISOString());
                
                const participants = oldEmbed.fields.filter(f => f.name !== 'Конец' && f.name !== 'ИНСТРУКЦИЯ');
                
                // --- ЛОГИРОВАНИЕ ДЕТАЛЕЙ КОНТРАКТА ---
                console.log(`[LOG] Завершен контракт: ${oldEmbed.title}`);
                console.log(`[LOG] Участники контракта:`);
                participants.forEach(f => console.log(`   -> ${f.name}: ${f.value}`));
                
                const count = participants.length;
                const multiplier = isSuccess ? (count >= 2 ? 0.2 : 0.4) : (count >= 2 ? 0.3 : 0.5);
                
                const payEmbed = new EmbedBuilder().setTitle(oldEmbed.title).setColor(isSuccess ? 0x00FF00 : 0xFF0000).setDescription(`Исполнитель: <@${i.user.id}>`);
                participants.forEach(f => {
                    const toPay = (parseInt(f.value.replace(/\D/g, '')) || 0) * 1000 * multiplier;
                    db.prepare('INSERT OR REPLACE INTO debtors (name, amount) VALUES (?, IFNULL((SELECT amount FROM debtors WHERE name = ?), 0) + ?)').run(f.name, f.name, toPay);
                    payEmbed.addFields({ name: f.name, value: `${toPay.toLocaleString()} $`, inline: false });
                });
                
                await i.message.edit({ content: `✅ Статус: **${isSuccess ? 'УСПЕХ ✅' : 'ПРОВАЛ ❌'}**`, components: [], embeds: [EmbedBuilder.from(oldEmbed).setColor(isSuccess ? 0x00FF00 : 0xFF0000)] });
                
                const payChannel = await client.channels.fetch(CONFIG.PAY);
                if (payChannel) {
                    await payChannel.send({ 
                        content: `🔔 **Новая оплата по контракту.** Исполнитель: <@${i.user.id}>`, 
                        embeds: [payEmbed], 
                        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('pay_confirm').setLabel('Оплатить').setStyle(ButtonStyle.Success))] 
                    });
                }
            }

            if (i.customId === 'pay_confirm') {
                const pingRoles = CONFIG.ALLOWED_ROLES.map(id => `<@&${id}>`).join(' ');
                await i.update({ content: `⏳ **Ожидание подтверждения оплаты!** ${pingRoles}`, components: [] });
            }
        }
        
        if (i.isModalSubmit() && i.customId === 'm') {
            await i.deferReply({ flags: [MessageFlags.Ephemeral] });
            const name = i.fields.getTextInputValue('n');
            const nicknames = i.fields.getTextInputValue('nicknames').split(';');
            const bills = i.fields.getTextInputValue('bills').split(';');
            const [h, m] = i.fields.getTextInputValue('time').split(':').map(Number);
            const endTime = Date.now() + (h * 60 + m) * 60 * 1000;
            
            const embed = new EmbedBuilder().setTitle(name).setColor(0x0099FF);
            nicknames.forEach((nick, idx) => {
                embed.addFields({ name: nick.trim(), value: `Векселей: ${bills[idx] || 0}`, inline: false });
            });
            embed.addFields({ name: 'Конец', value: `<t:${Math.floor(endTime / 1000)}:R>`, inline: false });
            embed.addFields({ name: 'ИНСТРУКЦИЯ', value: 'После окончания таймера нажмите "Успех" или "Провал".', inline: false });
            
            const processChannel = await client.channels.fetch(CONFIG.PROCESS);
            const msg = await processChannel.send({ 
                content: `Контракт взял: <@${i.user.id}>`, 
                embeds: [embed], 
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('succ').setLabel('Успех').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('fail').setLabel('Провал').setStyle(ButtonStyle.Danger))] 
            });
            
            db.prepare('INSERT OR REPLACE INTO active_contracts (msgId, creatorId, endTime, channelId) VALUES (?, ?, ?, ?)').run(msg.id, i.user.id, endTime, msg.channelId);
            await i.editReply('✅ Контракт успешно создан!');
        }
    } catch (err) { console.error('Ошибка взаимодействия:', err); }
});

const shutdown = () => { try { db.close(); } catch (err) { console.error(err); } client.destroy(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(process.env.TOKEN);