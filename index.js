const { 
    Client, GatewayIntentBits, REST, Routes,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags
} = require('discord.js');
const { 
    joinVoiceChannel, 
    createAudioPlayer, 
    createAudioResource, 
    AudioPlayerStatus, 
    VoiceConnectionStatus,
    StreamType
} = require('@discordjs/voice');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const ffmpegPath = 'ffmpeg';
dotenv.config();
const TOKEN = process.env.DISCORD_TOKEN;
const COOKIES_FILE = fs.existsSync('cookies.txt') ? path.resolve('cookies.txt') : null;
if (COOKIES_FILE) console.log('✅ Файл cookies.txt найден, будет использоваться для авторизации.');
const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] 
});
const queues = new Map();
const players = new Map();
const searchResults = new Map(); 
const infoCache = new Map();     
const CACHE_TTL = 10 * 60 * 1000; 
function getCachedInfo(url) {
    const cached = infoCache.get(url);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) return cached.data;
    if (cached) infoCache.delete(url);
    return null;
}
function setCachedInfo(url, data) {
    infoCache.set(url, { data, timestamp: Date.now() });
    if (infoCache.size > 100) {
        const now = Date.now();
        for (const [k, v] of infoCache) {
            if (now - v.timestamp > CACHE_TTL) infoCache.delete(k);
        }
    }
}
function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}
function createProgressBar(current, total, length = 16) {
    if (!total || total <= 0) return '▬'.repeat(length);
    const progress = Math.min(Math.max(current / total, 0), 1);
    const filled = Math.round(progress * length);
    const empty = length - filled;
    return '▬'.repeat(Math.max(filled - 1, 0)) + '🔘' + '▬'.repeat(empty);
}
const YTDLP_BASE_ARGS = [
    '--dump-json', '--no-download', '--no-warnings',
    '--no-check-certificates', '--no-playlist',
    '--geo-bypass', '--socket-timeout', '15',
    '-f', 'bestaudio[ext=webm]/bestaudio/best',
];
function ytdlpExec(args) {
    return new Promise((resolve, reject) => {
        execFile('yt-dlp', args, { maxBuffer: 10 * 1024 * 1024, timeout: 25000 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr || err.message));
            try {
                const info = JSON.parse(stdout);
                const result = {
                    title: info.title || 'Неизвестный трек',
                    url: info.webpage_url || info.url,
                    streamUrl: info.url,
                    thumbnail: info.thumbnail || '',
                    durationInSec: info.duration || 0
                };
                setCachedInfo(result.url, result);
                resolve(result);
            } catch (e) {
                reject(new Error('Не удалось разобрать ответ yt-dlp'));
            }
        });
    });
}
async function ytdlpInfo(query) {
    const isUrl = query.startsWith('http://') || query.startsWith('https://');
    if (isUrl) {
        const cached = getCachedInfo(query);
        if (cached) {
            console.log(`⚡ Из кэша: ${cached.title}`);
            return cached;
        }
    }
    const search = isUrl ? query : `ytsearch1:${query}`;
    const args = [
        ...YTDLP_BASE_ARGS,
        '--extractor-args', 'youtube:player_client=android_vr',
        search
    ];
    if (COOKIES_FILE) args.push('--cookies', COOKIES_FILE);

    try {
        return await ytdlpExec(args);
    } catch (e) {
        throw new Error(`Не удалось загрузить трек: ${e.message.substring(0, 100)}`);
    }
}
function prefetchTrackInfo(url) {
    if (getCachedInfo(url)) return; 
    ytdlpInfo(url).catch(() => {}); 
}
function ytdlpSearch(query, limit = 5) {
    return new Promise((resolve, reject) => {
        const results = [];
        const proc = spawn('yt-dlp', [
            '--dump-json', '--no-download', '--no-warnings',
            '--no-check-certificates', '--flat-playlist',
            '--geo-bypass', '--socket-timeout', '15',
            ...(COOKIES_FILE ? ['--cookies', COOKIES_FILE] : []),
            `ytsearch${limit}:${query}`
        ], { stdio: ['ignore', 'pipe', 'ignore'] });
        let buffer = '';
        proc.stdout.on('data', chunk => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop(); 
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const r = JSON.parse(line);
                    results.push({
                        title: r.title || 'Неизвестный трек',
                        url: r.url || r.webpage_url || `https://www.youtube.com/watch?v=${r.id}`,
                        thumbnail: r.thumbnails?.[r.thumbnails.length - 1]?.url || r.thumbnail || '',
                        duration: r.duration || 0
                    });
                } catch (e) {  }
            }
        });
        proc.on('close', code => {
            if (buffer.trim()) {
                try {
                    const r = JSON.parse(buffer);
                    results.push({
                        title: r.title || 'Неизвестный трек',
                        url: r.url || r.webpage_url || `https://www.youtube.com/watch?v=${r.id}`,
                        thumbnail: r.thumbnails?.[r.thumbnails.length - 1]?.url || r.thumbnail || '',
                        duration: r.duration || 0
                    });
                } catch (e) {}
            }
            if (results.length > 0) resolve(results);
            else reject(new Error('Ничего не найдено'));
        });
        proc.on('error', err => reject(err));
        setTimeout(() => {
            proc.kill();
            if (results.length > 0) resolve(results);
            else reject(new Error('Таймаут поиска'));
        }, 20000);
    });
}
function createStreamFromUrl(streamUrl, seekTime = 0) {
    const args = ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
    if (seekTime > 0) {
        args.push('-ss', String(seekTime));
    }
    args.push('-i', streamUrl, '-f', 'opus', '-c:a', 'libopus', '-b:a', '128k', '-vn', 'pipe:1');
    const ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    return ffmpeg.stdout;
}
function trackEmbed(track, status, requestedBy) {
    const colors = {
        playing: 0x1DB954,   
        queued: 0xFFA500,    
        search: 0x5865F2,    
        stopped: 0xED4245,   
        info: 0x5865F2       
    };
    const embed = new EmbedBuilder()
        .setColor(colors[status] || 0x5865F2);
    if (status === 'playing') {
        embed.setTitle('🎵 Сейчас играет');
    } else if (status === 'queued') {
        embed.setTitle('📋 Добавлено в очередь');
    }
    embed.setDescription(`**${track.title}**`);
    if (track.thumbnail) {
        embed.setImage(track.thumbnail);
    }
    embed.addFields(
        { name: '⏱ Длительность', value: formatDuration(track.durationInSec || track.duration), inline: true }
    );
    if (requestedBy) {
        embed.addFields(
            { name: '👤 Запросил', value: `<@${requestedBy}>`, inline: true }
        );
    }
    return embed;
}
function nowPlayingEmbed(track, elapsed, requestedBy) {
    const duration = track.durationInSec || 0;
    const bar = createProgressBar(elapsed, duration);
    const embed = new EmbedBuilder()
        .setColor(0x1DB954)
        .setTitle('🎵 Сейчас играет')
        .setDescription(`**${track.title}**`)
        .addFields(
            { name: '⏱ Прогресс', value: `\`${formatDuration(elapsed)}\` ${bar} \`${formatDuration(duration)}\``, inline: false }
        );
    if (track.thumbnail) {
        embed.setImage(track.thumbnail);
    }
    if (requestedBy) {
        embed.addFields(
            { name: '👤 Запросил', value: `<@${requestedBy}>`, inline: true }
        );
    }
    return embed;
}
function queueEmbed(currentTrack, queue, guildState) {
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📋 Очередь треков');
    let desc = '';
    if (currentTrack) {
        desc += `**Сейчас играет:**\n🎵 **${currentTrack.title}** — \`${formatDuration(currentTrack.durationInSec)}\``;
        if (currentTrack.requestedBy) desc += ` • <@${currentTrack.requestedBy}>`;
        desc += '\n\n';
    }
    if (queue.length === 0) {
        desc += '*Очередь пуста*';
    } else {
        desc += '**Далее:**\n';
        queue.forEach((track, i) => {
            const line = `\`${i + 1}.\` **${track.title}** — \`${formatDuration(track.durationInSec || track.duration)}\``;
            const by = track.requestedBy ? ` • <@${track.requestedBy}>` : '';
            desc += line + by + '\n';
        });
        const totalDuration = queue.reduce((sum, t) => sum + (t.durationInSec || t.duration || 0), 0);
        desc += `\n📊 **${queue.length}** трек(ов) • Общая длительность: \`${formatDuration(totalDuration)}\``;
    }
    if (guildState && guildState.loop) {
        desc += '\n🔁 Повтор: **ВКЛ**';
    }
    embed.setDescription(desc);
    return embed;
}
function searchEmbed(results) {
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🔍 Результаты поиска')
        .setDescription('Выберите трек кнопкой ниже:');
    let desc = '';
    results.forEach((r, i) => {
        desc += `**${i + 1}.** ${r.title} — \`${formatDuration(r.duration)}\`\n`;
    });
    embed.setDescription(desc);
    if (results[0]?.thumbnail) {
        embed.setImage(results[0].thumbnail);
    }
    return embed;
}
function getGuildState(guildId) {
    if (!players.has(guildId)) {
        players.set(guildId, {
            player: createAudioPlayer(),
            connection: null,
            currentTrack: null,
            loop: false,
            skipNext: false,
            startedAt: 0,
            pausedAt: 0,
            seekOffset: 0,
            textChannel: null
        });
        const state = players.get(guildId);
        state.player.on(AudioPlayerStatus.Idle, () => {
            if (state.skipNext) {
                state.skipNext = false;
                return;
            }
            if (state.loop && state.currentTrack) {
                playTrack(guildId, state.currentTrack);
            } else {
                const queue = queues.get(guildId) || [];
                if (queue.length > 0) {
                    const next = queue.shift();
                    playTrack(guildId, next);
                    if (state.textChannel) {
                        const embed = trackEmbed(next, 'playing', next.requestedBy);
                        state.textChannel.send({ embeds: [embed] }).catch(() => {});
                    }
                } else {
                    state.currentTrack = null;
                }
            }
        });
        state.player.on('error', error => {
            console.error(`AudioPlayer Error: ${error.message}`);
            state.currentTrack = null;
        });
    }
    return players.get(guildId);
}
async function playTrack(guildId, track, seekTime = 0) {
    const state = getGuildState(guildId);
    try {
        let streamUrl = track.streamUrl;
        if (!streamUrl || seekTime > 0) {
            console.log(`🎵 Загрузка: ${track.title}...`);
            const info = await ytdlpInfo(track.url);
            streamUrl = info.streamUrl;
            if (!track.thumbnail && info.thumbnail) track.thumbnail = info.thumbnail;
            if (!track.durationInSec && info.durationInSec) track.durationInSec = info.durationInSec;
        } else {
            console.log(`🎵 Быстрый старт: ${track.title}`);
        }
        const stream = createStreamFromUrl(streamUrl, seekTime);
        const resource = createAudioResource(stream, {
            inputType: StreamType.OggOpus
        });
        state.currentTrack = { ...track, streamUrl };
        state.seekOffset = seekTime;
        state.startedAt = Date.now();
        state.pausedAt = 0;
        state.player.play(resource);
        if (state.connection) {
            state.connection.subscribe(state.player);
        }
        console.log(`▶️ Играет: ${track.title}`);
    } catch (e) {
        console.error("Play error:", e.message);
    }
}
const commands = [
    { name: 'join', description: 'Подключить бота к вашему каналу' },
    { 
        name: 'play', 
        description: 'Найти и воспроизвести трек с YouTube', 
        options: [{ name: 'query', type: 3, description: 'URL или название для поиска', required: true }] 
    },
    { name: 'stop', description: 'Остановить музыку и отключиться' },
    { name: 'skip', description: 'Пропустить текущий трек' },
    { name: 'pause', description: 'Поставить музыку на паузу' },
    { name: 'resume', description: 'Продолжить воспроизведение' },
    { name: 'loop', description: 'Повтор трека ВКЛ/ВЫКЛ' },
    { name: 'np', description: 'Показать текущий трек с прогрессом' },
    { name: 'queue', description: 'Показать очередь треков' },
    { 
        name: 'remove', 
        description: 'Удалить трек из очереди по номеру',
        options: [{ name: 'номер', type: 4, description: 'Номер трека в очереди', required: true }]
    },
    { name: 'clear', description: 'Очистить очередь' },
    { name: 'shuffle', description: 'Перемешать очередь' }
];
const rest = new REST({ version: '10' }).setToken(TOKEN);
client.once('clientReady', async () => {
    console.log(`✅ Бот ${client.user.tag} запущен!`);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Слеш-команды зарегистрированы.');
    } catch (e) {
        console.error(e);
    }
});
client.on('interactionCreate', async interaction => {
    if (interaction.isButton()) {
        const [action, searchId] = interaction.customId.split('_');
        if (action === 'cancel') {
            searchResults.delete(searchId);
            return interaction.update({ 
                content: '❌ Поиск отменён.', 
                embeds: [], 
                components: [] 
            });
        }
        if (action === 'pick') {
            return;
        }
        if (action.startsWith('pick')) {
            const index = parseInt(action.replace('pick', '')) - 1;
            const data = searchResults.get(searchId);
            if (!data) {
                return interaction.update({ 
                    content: '⏳ Результаты поиска устарели, попробуйте снова.', 
                    embeds: [], 
                    components: [] 
                });
            }
            const chosen = data.results[index];
            if (!chosen) {
                return interaction.update({ content: '❌ Неверный выбор.', embeds: [], components: [] });
            }
            searchResults.delete(searchId);
            await interaction.update({ 
                content: `✅ Вы выбрали: **${chosen.title}**\nЗагрузка...`, 
                embeds: [], 
                components: [] 
            });
            const guildId = data.guildId;
            const state = getGuildState(guildId);
            if (!state.connection || state.connection.state.status === VoiceConnectionStatus.Destroyed) {
                const guild = client.guilds.cache.get(guildId);
                const member = guild?.members.cache.get(data.userId);
                if (member?.voice.channel) {
                    state.connection = joinVoiceChannel({
                        channelId: member.voice.channel.id,
                        guildId: guildId,
                        adapterCreator: guild.voiceAdapterCreator,
                    });
                }
            }
            state.textChannel = interaction.channel;
            try {
                const info = await ytdlpInfo(chosen.url);
                const track = {
                    title: info.title,
                    url: info.url,
                    streamUrl: info.streamUrl,
                    thumbnail: info.thumbnail,
                    durationInSec: info.durationInSec,
                    requestedBy: data.userId
                };
                if (state.player.state.status === AudioPlayerStatus.Playing || 
                    state.player.state.status === AudioPlayerStatus.Paused) {
                    if (!queues.has(guildId)) queues.set(guildId, []);
                    queues.get(guildId).push(track);
                    const embed = trackEmbed(track, 'queued', data.userId);
                    await interaction.channel.send({ embeds: [embed] });
                } else {
                    playTrack(guildId, track);
                    const embed = trackEmbed(track, 'playing', data.userId);
                    await interaction.channel.send({ embeds: [embed] });
                }
            } catch (e) {
                await interaction.followUp({ content: `❌ Ошибка: ${e.message}`, flags: MessageFlags.Ephemeral });
            }
        }
        return;
    }
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;
    const guildId = interaction.guildId;
    const member = interaction.member;
    if (!member.voice.channel) {
        return interaction.reply({ content: '❌ Вы должны находиться в голосовом канале!', flags: MessageFlags.Ephemeral });
    }
    const state = getGuildState(guildId);
    state.textChannel = interaction.channel;
    if (commandName === 'join') {
        state.connection = joinVoiceChannel({
            channelId: member.voice.channel.id,
            guildId: guildId,
            adapterCreator: interaction.guild.voiceAdapterCreator,
        });
        interaction.reply(`✅ Подключился к **${member.voice.channel.name}**`);
    }
    if (commandName === 'play') {
        const query = interaction.options.getString('query');
        const isUrl = query.startsWith('http://') || query.startsWith('https://');
        if (!state.connection || state.connection.state.status === VoiceConnectionStatus.Destroyed) {
            state.connection = joinVoiceChannel({
                channelId: member.voice.channel.id,
                guildId: guildId,
                adapterCreator: interaction.guild.voiceAdapterCreator,
            });
        }
        if (isUrl) {
            await interaction.deferReply();
            try {
                const info = await ytdlpInfo(query);
                const track = {
                    title: info.title,
                    url: info.url,
                    streamUrl: info.streamUrl,
                    thumbnail: info.thumbnail,
                    durationInSec: info.durationInSec,
                    requestedBy: interaction.user.id
                };
                if (state.player.state.status === AudioPlayerStatus.Playing || 
                    state.player.state.status === AudioPlayerStatus.Paused) {
                    if (!queues.has(guildId)) queues.set(guildId, []);
                    queues.get(guildId).push(track);
                    const embed = trackEmbed(track, 'queued', interaction.user.id);
                    await interaction.editReply({ embeds: [embed] });
                } else {
                    playTrack(guildId, track);
                    const embed = trackEmbed(track, 'playing', interaction.user.id);
                    await interaction.editReply({ embeds: [embed] });
                }
            } catch (e) {
                await interaction.editReply(`❌ Ошибка: ${e.message}`);
            }
        } else {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            try {
                const results = await ytdlpSearch(query, 5);
                if (results.length === 0) {
                    return interaction.editReply({ content: '❌ Ничего не найдено.' });
                }
                const searchId = interaction.id;
                searchResults.set(searchId, {
                    results,
                    guildId,
                    userId: interaction.user.id
                });
                setTimeout(() => searchResults.delete(searchId), 60000);
                if (results[0]?.url) prefetchTrackInfo(results[0].url);
                const embed = searchEmbed(results);
                const row1 = new ActionRowBuilder();
                results.forEach((_, i) => {
                    row1.addComponents(
                        new ButtonBuilder()
                            .setCustomId(`pick${i + 1}_${searchId}`)
                            .setLabel(`${i + 1}`)
                            .setStyle(ButtonStyle.Primary)
                    );
                });
                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`cancel_${searchId}`)
                        .setLabel('✕ Отмена')
                        .setStyle(ButtonStyle.Danger)
                );
                await interaction.editReply({ embeds: [embed], components: [row1, row2] });
            } catch (e) {
                await interaction.editReply(`❌ Ошибка поиска: ${e.message}`);
            }
        }
    }
    if (commandName === 'stop') {
        if (state.connection) {
            state.connection.destroy();
            state.connection = null;
        }
        state.player.stop();
        queues.set(guildId, []);
        state.currentTrack = null;
        const embed = new EmbedBuilder()
            .setColor(0xED4245)
            .setDescription('⏹️ Воспроизведение остановлено, очередь очищена.');
        interaction.reply({ embeds: [embed] });
    }
    if (commandName === 'skip') {
        const queue = queues.get(guildId) || [];
        const skippedTitle = state.currentTrack?.title || 'Неизвестный трек';
        state.player.stop();
        const embed = new EmbedBuilder()
            .setColor(0xFFA500)
            .setDescription(`⏭️ Пропущено: **${skippedTitle}**`);
        if (queue.length > 0) {
            embed.addFields({ name: 'Далее', value: `🎵 ${queue[0].title}`, inline: false });
        } else {
            embed.addFields({ name: 'Очередь', value: 'Пуста', inline: false });
        }
        interaction.reply({ embeds: [embed] });
    }
    if (commandName === 'pause') {
        state.player.pause();
        state.pausedAt = Date.now();
        const embed = new EmbedBuilder()
            .setColor(0xFFA500)
            .setDescription('⏸️ Воспроизведение на паузе.');
        if (state.currentTrack) {
            embed.addFields({ name: 'Трек', value: state.currentTrack.title, inline: true });
        }
        interaction.reply({ embeds: [embed] });
    }
    if (commandName === 'resume') {
        state.player.unpause();
        state.startedAt += (Date.now() - state.pausedAt);
        const embed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setDescription('▶️ Воспроизведение продолжено.');
        if (state.currentTrack) {
            embed.addFields({ name: 'Трек', value: state.currentTrack.title, inline: true });
        }
        interaction.reply({ embeds: [embed] });
    }
    if (commandName === 'loop') {
        state.loop = !state.loop;
        const embed = new EmbedBuilder()
            .setColor(state.loop ? 0x1DB954 : 0xED4245)
            .setDescription(`🔁 Повтор: **${state.loop ? 'ВКЛ' : 'ВЫКЛ'}**`);
        interaction.reply({ embeds: [embed] });
    }
    if (commandName === 'np') {
        if (!state.currentTrack) {
            return interaction.reply({ content: '❌ Сейчас ничего не играет.', flags: MessageFlags.Ephemeral });
        }
        let elapsed = 0;
        const playerStatus = state.player.state.status;
        if (playerStatus === AudioPlayerStatus.Playing) {
            elapsed = state.seekOffset + (Date.now() - state.startedAt) / 1000;
        } else if (playerStatus === AudioPlayerStatus.Paused) {
            elapsed = state.seekOffset + (state.pausedAt - state.startedAt) / 1000;
        }
        const embed = nowPlayingEmbed(state.currentTrack, Math.floor(elapsed), state.currentTrack.requestedBy);
        const loopStatus = state.loop ? '\n🔁 Повтор: **ВКЛ**' : '';
        if (loopStatus) {
            embed.setFooter({ text: '🔁 Повтор включён' });
        }
        interaction.reply({ embeds: [embed] });
    }
    if (commandName === 'queue') {
        const queue = queues.get(guildId) || [];
        const embed = queueEmbed(state.currentTrack, queue, state);
        interaction.reply({ embeds: [embed] });
    }
    if (commandName === 'remove') {
        const num = interaction.options.getInteger('номер');
        const queue = queues.get(guildId) || [];
        if (num < 1 || num > queue.length) {
            return interaction.reply({ 
                content: `❌ Неверный номер. В очереди ${queue.length} трек(ов).`, 
                flags: MessageFlags.Ephemeral 
            });
        }
        const removed = queue.splice(num - 1, 1)[0];
        const embed = new EmbedBuilder()
            .setColor(0xED4245)
            .setDescription(`🗑️ Удалён из очереди: **${removed.title}**`);
        interaction.reply({ embeds: [embed] });
    }
    if (commandName === 'clear') {
        queues.set(guildId, []);
        const embed = new EmbedBuilder()
            .setColor(0xED4245)
            .setDescription('🗑️ Очередь очищена.');
        interaction.reply({ embeds: [embed] });
    }
    if (commandName === 'shuffle') {
        const queue = queues.get(guildId) || [];
        if (queue.length < 2) {
            return interaction.reply({ content: '❌ Недостаточно треков для перемешивания.', flags: MessageFlags.Ephemeral });
        }
        for (let i = queue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [queue[i], queue[j]] = [queue[j], queue[i]];
        }
        const embed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setDescription(`🔀 Очередь перемешана! (${queue.length} треков)`);
        interaction.reply({ embeds: [embed] });
    }
});
client.login(TOKEN);