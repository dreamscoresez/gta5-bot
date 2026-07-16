require('dotenv').config();
const { Client, GatewayIntentBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, MessageFlags, REST, Routes, SlashCommandBuilder } = require('discord.js');
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
            await channel.send(`⚠️ **ВРЕМЯ ВЫШЛО!** <@${creatorId}>, проверьте и закройте контракт!`); 
        }
        catch (err) { console.error('Ошибка таймера:', err); }
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
    new SlashCommandBuilder().setName('чек_контракты').setDescription('Принудительно проверить все таймеры')
];

client.once('clientReady', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log(`🚀 Бот ${client.user.tag} запущен!`);

    const treasury = db.prepare('SELECT balance FROM treasury WHERE id = 1').get();
    const debtorsCount = db.prepare('SELECT COUNT(*) as count FROM debtors').get();
    const totalDebts = db.prepare('SELECT SUM(amount) as total FROM debtors').get();
    const stats = db.prepare('SELECT status, COUNT(*) as count FROM contract_history GROUP BY status').all();
    
    const succCount = stats.find(s => s.status === 'success')?.count || 0;
    const failCount = stats.find(s => s.status === 'fail')?.count || 0;

    console.log(`\n📊 --- СТАТИСТИКА БОТА ---`);
    console.log(`💰 Баланс казны: ${(treasury?.balance || 0).toLocaleString()}$`);
    console.log(`👥 Должники: ${debtorsCount.count} чел. (Общий долг: ${(totalDebts.total || 0).toLocaleString()}$ )`);
    console.log(`✅ Успешных контрактов: ${succCount}`);
    console.log(`❌ Проваленных контрактов: ${failCount}`);
    console.log(`--------------------------\n`);

    const activeContracts = db.prepare('SELECT * FROM active_contracts').all();
    console.log(`🔍 [LOG] Найдено активных контрактов в БД: ${activeContracts.length}`);

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

client.on('messageCreate', async msg => {
    if (msg.author.bot) return;

    if ((msg.channel.id === CONFIG.PICK || msg.channel.id === CONFIG.PROCESS) && msg.content !== '!подтвердить') {
        return await msg.delete().catch(() => {});
    }

    if (msg.channel.id === CONFIG.PAY && msg.content.toLowerCase().trim() === '!подтвердить') {
        const hasRole = msg.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
        if (!hasRole) return await msg.reply('❌ Ошибка! У вас нет прав проверяющего.');

        const channelMessages = await msg.channel.messages.fetch({ limit: 20 });
        const pendingMsg = channelMessages.find(m => m.author.id === client.user.id && m.content.includes('⏳ **Ожидание подтверждения...**'));
        
        if (pendingMsg) {
            const embed = pendingMsg.embeds[0];
            if (embed) {    
                let totalPaid = 0;    
                embed.fields.forEach(field => {        
                    const amount = parseInt(field.value.replace(/\D/g, ''));        
                    if (!isNaN(amount)) {            
                        db.prepare('UPDATE debtors SET amount = amount - ? WHERE name = ?').run(amount, field.name);            
                        totalPaid += amount;        
                    }    
                });    
                db.prepare('DELETE FROM debtors WHERE amount <= 0').run();    
                if (totalPaid > 0) {        
                    db.prepare('UPDATE treasury SET balance = balance + ? WHERE id = 1').run(totalPaid);    
                }
                console.log(`[LOG] Оплата контракта подтверждена. Сумма: ${totalPaid}$. Проверяющий: ${msg.author.tag}`);
            }
            await pendingMsg.edit({ content: `✅ **Оплата подтверждена! Проверяющий: <@${msg.author.id}>**`, components: [] });
            await msg.reply('✅ Контракт успешно закрыт, долги обновлены.');
        } else {
            await msg.reply('❌ Нет активных оплат в статусе ожидания.');
        }
    }
});

client.on('interactionCreate', async i => {
    try {
        if (i.isChatInputCommand()) {
            // Публичные команды
            if (i.commandName === 'казна') {
                const row = db.prepare('SELECT balance FROM treasury WHERE id = 1').get();
                return i.reply({ content: `💰 Баланс: **${(row?.balance || 0).toLocaleString()} $**`, flags: [MessageFlags.Ephemeral] });
            }
            if (i.commandName === 'должники') {
                const debtors = db.prepare('SELECT * FROM debtors').all();
                const text = debtors.length ? debtors.map(d => `• **${d.name}**: ${d.amount.toLocaleString()}$`).join('\n') : 'Должников нет.';
                return i.reply({ content: `📋 **Должники:**\n${text}`, flags: [MessageFlags.Ephemeral] });
            }

            // Проверка прав
            const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
            if (!hasRole) return i.reply({ content: '❌ Ошибка! У вас нет прав.', flags: [MessageFlags.Ephemeral] });

            // Админ команды
            if (i.commandName === 'вызвать') {
                return i.reply({ 
                    content: "📢 **ПАНЕЛЬ КОНТРАКТОВ**\nЗа всеми вопросами обращаться к <@702529657718833162>", 
                    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('start').setLabel('Создать контракт').setStyle(ButtonStyle.Primary))] 
                });
            }
            if (i.commandName === 'чек_контракты') {
                const activeContracts = db.prepare('SELECT * FROM active_contracts').all();
                for (const contract of activeContracts) {
                    const channel = await client.channels.fetch(contract.channelId);
                    setupTimer(channel, contract.creatorId, contract.endTime);
                }
                console.log(`[LOG] Администратор ${i.user.tag} принудительно проверил таймеры.`);
                return i.reply({ content: `✅ Проверено контрактов: ${activeContracts.length}`, flags: [MessageFlags.Ephemeral] });
            }
            if (['пополнить', 'вычесть', 'долг_добавить', 'оплачено'].includes(i.commandName)) {
                const amt = i.options.getInteger('сумма');
                if (i.commandName === 'пополнить') { db.prepare('UPDATE treasury SET balance = balance + ? WHERE id = 1').run(amt); console.log(`[LOG] ${i.user.tag} пополнил казну на ${amt}$`); }
                if (i.commandName === 'вычесть') { db.prepare('UPDATE treasury SET balance = balance - ? WHERE id = 1').run(amt); console.log(`[LOG] ${i.user.tag} списал из казны ${amt}$`); }
                if (i.commandName === 'долг_добавить') { db.prepare('INSERT OR REPLACE INTO debtors (name, amount) VALUES (?, ?)').run(i.options.getString('ник'), amt); console.log(`[LOG] ${i.user.tag} добавил долг ${i.options.getString('ник')}: ${amt}$`); }
                if (i.commandName === 'оплачено') {
                    db.prepare('UPDATE debtors SET amount = amount - ? WHERE name = ?').run(amt, i.options.getString('ник'));
                    db.prepare('DELETE FROM debtors WHERE amount <= 0').run();
                    console.log(`[LOG] ${i.user.tag} закрыл ${amt}$ долга за ${i.options.getString('ник')}`);
                }
                return i.reply({ content: '✅ Выполнено.', flags: [MessageFlags.Ephemeral] });
            }
        }

        if (i.isButton()) {
            if (i.customId === 'start') {
                const modal = new ModalBuilder().setCustomId('m').setTitle('Создание контракта').addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('n').setLabel('Название').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ограбление')),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nicknames').setLabel('Ники (через ;)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Artem;Yuto')),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bills').setLabel('Векселя (через ;)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('25;20')),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('time').setLabel('Время (ЧЧ:ММ)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('02:20'))
                );
                return i.showModal(modal);
            }
            if (i.customId === 'succ' || i.customId === 'fail') {
                const oldEmbed = i.message.embeds[0];
                const timeField = oldEmbed.fields.find(f => f.name === 'Конец');
                const timestampMatch = timeField.value.match(/<t:(\d+):R>/);
                const endTime = parseInt(timestampMatch[1]) * 1000;
                
                if (Date.now() < endTime) return i.reply({ content: '❌ Рано! Контракт ещё не завершён.', flags: [MessageFlags.Ephemeral] });
                
                await i.deferUpdate();
                db.prepare('DELETE FROM active_contracts WHERE msgId = ?').run(i.message.id);
                
                const isSuccess = i.customId === 'succ';
                console.log(`[LOG] Контракт ${oldEmbed.title} завершен со статусом: ${isSuccess ? 'УСПЕХ' : 'ПРОВАЛ'}`);
                
                db.prepare('INSERT INTO contract_history (msgId, creatorId, status, finishedAt) VALUES (?, ?, ?, ?)').run(i.message.id, null, isSuccess ? 'success' : 'fail', new Date().toISOString());
                const multiplier = isSuccess ? 0.2 : 0.3;
                
                const payEmbed = new EmbedBuilder().setTitle(oldEmbed.title).setColor(isSuccess ? 0x00FF00 : 0xFF0000);
                
                const participants = oldEmbed.fields.filter(f => f.name !== 'Конец' && f.name !== 'ИНСТРУКЦИЯ');
                participants.forEach(f => {
                    const toPay = (parseInt(f.value.replace(/\D/g, '')) || 0) * 1000 * multiplier;
                    db.prepare('INSERT OR REPLACE INTO debtors (name, amount) VALUES (?, IFNULL((SELECT amount FROM debtors WHERE name = ?), 0) + ?)').run(f.name, f.name, toPay);
                    payEmbed.addFields({ name: f.name, value: `${toPay.toLocaleString()} $`, inline: false });
                });
                
                await i.message.edit({ content: `✅ Статус: **${isSuccess ? 'УСПЕХ ✅' : 'ПРОВАЛ ❌'}**`, components: [], embeds: [EmbedBuilder.from(oldEmbed).setColor(isSuccess ? 0x00FF00 : 0xFF0000)] });
                
                const payChannel = await client.channels.fetch(CONFIG.PAY);
                if (payChannel) {
                    await payChannel.send({ content: `🔔 **Оплата по контракту**`, embeds: [payEmbed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('pay_confirm').setLabel('Оплатить').setStyle(ButtonStyle.Success))] });
                }
            }
            if (i.customId === 'pay_confirm') {
                const messages = await i.channel.messages.fetch({ limit: 10 });
                if (!messages.some(msg => msg.attachments.size > 0)) return i.reply({ content: '❌ Ошибка! Сначала прикрепите скриншот.', flags: [MessageFlags.Ephemeral] });
                await i.update({ content: `⏳ **Ожидание подтверждения...**`, components: [] });
            }
        }
        
        if (i.isModalSubmit() && i.customId === 'm') {
            await i.deferReply({ flags: [MessageFlags.Ephemeral] });
            try {
                const name = i.fields.getTextInputValue('n');
                const [h, m] = i.fields.getTextInputValue('time').split(':').map(Number);
                const endTime = Date.now() + (h * 60 + m) * 60 * 1000;
                
                const embed = new EmbedBuilder().setTitle(name).setColor(0x0099FF);
                embed.addFields({ name: 'Конец', value: `<t:${Math.floor(endTime / 1000)}:R>`, inline: false });
                
                const processChannel = await client.channels.fetch(CONFIG.PROCESS);
                const msg = await processChannel.send({ content: `Контракт взял: <@${i.user.id}>`, embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('succ').setLabel('Успех').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('fail').setLabel('Провал').setStyle(ButtonStyle.Danger))] });
                
                db.prepare('INSERT OR REPLACE INTO active_contracts (msgId, creatorId, endTime, channelId) VALUES (?, ?, ?, ?)').run(msg.id, i.user.id, endTime, msg.channelId);
                
                console.log(`[LOG] Пользователь ${i.user.tag} создал контракт "${name}"`);
                await i.editReply('✅ Контракт успешно создан!');
            } catch (err) { console.error('Ошибка модалки:', err); await i.editReply('❌ Ошибка.'); }
        }
    } catch (err) { console.error('Ошибка:', err); }
});

const shutdown = () => {
    console.log('🛑 Бот выключается...');
    try { db.close(); } catch (err) { console.error('Ошибка при закрытии БД:', err); }
    client.destroy();
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(process.env.TOKEN);