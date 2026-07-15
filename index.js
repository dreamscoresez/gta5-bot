require('dotenv').config();
const { Client, GatewayIntentBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, MessageFlags, REST, Routes, SlashCommandBuilder } = require('discord.js');
const db = require('./database');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

process.on('unhandledRejection', error => { console.error('Unhandled rejection:', error); });
process.on('uncaughtException', err => { console.error('Uncaught exception:', err); });

db.prepare('CREATE TABLE IF NOT EXISTS debtors (name TEXT PRIMARY KEY, amount INTEGER)').run();
db.prepare('CREATE TABLE IF NOT EXISTS treasury (id INTEGER PRIMARY KEY, balance INTEGER)').run();
db.prepare('CREATE TABLE IF NOT EXISTS active_contracts (msgId TEXT PRIMARY KEY, creatorId TEXT, endTime INTEGER)').run();
db.prepare('INSERT OR IGNORE INTO treasury (id, balance) VALUES (1, 0)').run();

const CONFIG = {
    PICK: process.env.PICK,
    PROCESS: process.env.PROCESS,
    PAY: process.env.PAY,
    ALLOWED_ROLES: process.env.ALLOWED_ROLES ? process.env.ALLOWED_ROLES.split(',') : []
};

const setupTimer = async (channel, creatorId, endTime) => {
    const remaining = endTime - Date.now();
    setTimeout(async () => {
        try { await channel.send(`⚠️ **ВРЕМЯ ВЫШЛО!** <@${creatorId}>, проверьте и закройте контракт!`); }
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
    new SlashCommandBuilder().setName('оплачено').setDescription('Закрыть долг').addStringOption(o => o.setName('ник').setDescription('Ник').setRequired(true)).addIntegerOption(o => o.setName('сумма').setDescription('Сумма').setRequired(true))
];

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log(`🚀 Бот ${client.user.tag} запущен!`);
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
                embed.fields.forEach(field => {
                    const amount = parseInt(field.value.replace(/\D/g, ''));
                    if (!isNaN(amount)) {
                        db.prepare('UPDATE debtors SET amount = amount - ? WHERE name = ?').run(amount, field.name);
                    }
                });
                db.prepare('DELETE FROM debtors WHERE amount <= 0').run();
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
            if (i.commandName === 'казна') {
                const row = db.prepare('SELECT balance FROM treasury WHERE id = 1').get();
                return i.reply({ content: `💰 Баланс: **${(row?.balance || 0).toLocaleString()} $**`, flags: [MessageFlags.Ephemeral] });
            }
            if (['пополнить', 'вычесть', 'долг_добавить', 'оплачено'].includes(i.commandName)) {
                if (i.commandName === 'пополнить') db.prepare('UPDATE treasury SET balance = balance + ? WHERE id = 1').run(i.options.getInteger('сумма'));
                if (i.commandName === 'вычесть') db.prepare('UPDATE treasury SET balance = balance - ? WHERE id = 1').run(i.options.getInteger('сумма'));
                if (i.commandName === 'долг_добавить') db.prepare('INSERT OR REPLACE INTO debtors (name, amount) VALUES (?, ?)').run(i.options.getString('ник'), i.options.getInteger('сумма'));
                if (i.commandName === 'оплачено') {
                    db.prepare('UPDATE debtors SET amount = amount - ? WHERE name = ?').run(i.options.getInteger('сумма'), i.options.getString('ник'));
                    db.prepare('DELETE FROM debtors WHERE amount <= 0').run();
                }
                return i.reply({ content: '✅ Выполнено.', flags: [MessageFlags.Ephemeral] });
            }
            if (i.commandName === 'должники') {
                const debtors = db.prepare('SELECT * FROM debtors').all();
                const text = debtors.length ? debtors.map(d => `• **${d.name}**: ${d.amount.toLocaleString()}$`).join('\n') : 'Должников нет.';
                return i.reply({ content: `📋 **Должники:**\n${text}`, flags: [MessageFlags.Ephemeral] });
            }
            if (i.commandName === 'вызвать') {
                return i.reply({ components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('start').setLabel('Создать контракт').setStyle(ButtonStyle.Primary))] });
            }
        }

        if (i.isButton()) {
            if (i.customId === 'start') {
                const modal = new ModalBuilder().setCustomId('m').setTitle('Создание контракта').addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('n').setLabel('Название').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ограбление')),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nicknames').setLabel('Ники (через ;)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Artem Minoru;Yuto Minoru')),
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

                if (Date.now() < endTime) {
                    return i.reply({ content: '❌ Рано! Контракт ещё не завершён.', flags: [MessageFlags.Ephemeral] });
                }

                await i.deferUpdate();

                const creatorMatch = i.message.content.match(/<@(\d+)>/);
                const creatorId = creatorMatch ? creatorMatch[1] : null;

                const participants = oldEmbed.fields.filter(f => f.name !== 'Конец' && f.name !== 'ИНСТРУКЦИЯ');
                const isSuccess = i.customId === 'succ';

                const multiplier = isSuccess
                    ? (participants.length < 2 ? 0.4 : 0.2)
                    : (participants.length < 2 ? 0.5 : 0.3);

                const payEmbed = new EmbedBuilder()
                    .setTitle(oldEmbed.title)
                    .setColor(isSuccess ? 0x00FF00 : 0xFF0000)
                    .setDescription(isSuccess ? '**Детали оплаты (Успех):**' : '**Детали оплаты (Провал - Штраф):**');

                participants.forEach(f => {
                    const toPay = (parseInt(f.value.replace(/\D/g, '')) || 0) * 1000 * multiplier;
                    db.prepare('INSERT OR REPLACE INTO debtors (name, amount) VALUES (?, IFNULL((SELECT amount FROM debtors WHERE name = ?), 0) + ?)').run(f.name, f.name, toPay);
                    payEmbed.addFields({ name: f.name, value: `${toPay.toLocaleString()} $`, inline: false });
                });

                await i.message.edit({
                    content: `✅ Статус: **${isSuccess ? 'УСПЕХ ✅' : 'ПРОВАЛ ❌'}**`,
                    components: [],
                    embeds: [EmbedBuilder.from(oldEmbed).setColor(isSuccess ? 0x00FF00 : 0xFF0000)]
                });

                const payChannel = await client.channels.fetch(CONFIG.PAY);
                if (payChannel) {
                    await payChannel.send({
                        content: `🔔 **Оплата по контракту**${creatorId ? ` — <@${creatorId}>` : ''}`,
                        embeds: [payEmbed],
                        components: [new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId('pay_confirm').setLabel('Оплатить').setStyle(ButtonStyle.Success)
                        )]
                    });
                }
            }

            if (i.customId === 'pay_confirm') {
                const messages = await i.channel.messages.fetch({ limit: 10 });
                if (!messages.some(msg => msg.attachments.size > 0)) {
                    return i.reply({ content: '❌ Ошибка! Сначала прикрепите скриншот.', flags: [MessageFlags.Ephemeral] });
                }
                await i.update({
                    content: `⏳ **Ожидание подтверждения...**\nОплата от <@${i.user.id}>. Проверяющий, введите \`!подтвердить\` для завершения.`,
                    components: []
                });
            }
        }

        if (i.isModalSubmit() && i.customId === 'm') {
            await i.deferReply({ flags: [MessageFlags.Ephemeral] });
            try {
                const name = i.fields.getTextInputValue('n').trim();
                const nicksStr = i.fields.getTextInputValue('nicknames').trim();
                const billsStr = i.fields.getTextInputValue('bills').trim();
                const timeStr = i.fields.getTextInputValue('time').trim();

                const nameNickRegex = /^[a-zA-Zа-яА-ЯёЁ0-9_\s;]+$/;
                const billRegex = /^\d+(;\d+)*$/;
                const timeRegex = /^\d{2}:\d{2}$/;

                function NicknamesCheck(str) { return /^[a-zA-Zа-яА-ЯёЁ0-9_\s;]+$/.test(str); }

                if (!nameNickRegex.test(name) || !NicknamesCheck(nicksStr) || !billRegex.test(billsStr) || !timeRegex.test(timeStr)) {
                    return i.editReply({ content: '❌ Ошибка синтаксиса! Проверьте данные:\n- Ники: текст через ; (без _-/ между именем и фамилией, а так же без пробела между фамилией и следующим ником(Artem Minoru;Kimito Minoru))\n- Векселя: цифры через ;\n- Время: ЧЧ:ММ' });
                }

                const [h, m] = timeStr.split(':').map(Number);
                const endTime = Date.now() + (h * 60 + m) * 60 * 1000;
                const nicks = nicksStr.split(';');
                const bills = billsStr.split(';');

                const embed = new EmbedBuilder().setTitle(name).setColor(0x0099FF);
                nicks.forEach((n, idx) => embed.addFields({ name: n.trim(), value: `Векселей: ${parseInt(bills[idx]?.trim()) || 0}`, inline: false }));
                embed.addFields(
                    { name: 'Конец', value: `<t:${Math.floor(endTime / 1000)}:R>`, inline: false },
                    { name: 'ИНСТРУКЦИЯ', value: 'После окончания таймера нажмите "Успех" или "Провал".', inline: false }
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

                setupTimer(msg.channel, i.user.id, endTime);
                await i.editReply('✅ Контракт успешно создан!');
            } catch (err) {
                console.error('Ошибка модалки:', err);
                await i.editReply('❌ Произошла ошибка при создании контракта.');
            }
        }

    } catch (err) { console.error('Ошибка:', err); }
});

const shutdown = () => {
    console.log('🛑 Выключение бота...');
    client.destroy();
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(process.env.TOKEN);