import { mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus, EndBehaviorType, generateDependencyReport } from '@discordjs/voice';
import OpusScript from 'opusscript';
import { Capture, writeJson } from './audio.mjs';
import { addReviewCommands, contextFor } from './review.mjs';
import { createWorkflow } from './runtime.mjs';

function snowflake(key) {
  const value = process.env[key] ?? '';
  if (!/^\d{17,20}$/.test(value)) throw new Error(`Set ${key} in .env to a Discord ID`);
  return value;
}
const token = process.env.DISCORD_TOKEN;
if (!token || token === 'replace_me') throw new Error('Set DISCORD_TOKEN in .env; never paste it in chat');
const guildId = snowflake('DISCORD_GUILD_ID');
const voiceId = process.env.DISCORD_VOICE_CHANNEL_ID;
const textId = snowflake('DISCORD_TEXT_CHANNEL_ID');
const root = resolve(process.env.RECORDINGS_DIR || 'data');
mkdirSync(root, { recursive: true, mode: 0o700 });
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates], allowedMentions: { parse: [] } });
const issues = await createWorkflow({ root, client, guildId, textId });
let active;
let starting = false;

function event(session, type, detail = {}) {
  const entry = { at: new Date().toISOString(), type, ...detail };
  appendFileSync(join(session.directory, 'events.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
  if (type !== 'decode_error') console.log(`[${entry.at}] recording ${type}: ${JSON.stringify({ session: session.info.session_id, ...detail })}`);
}

async function stop(reason, actor = 'vera') {
  const session = active;
  if (!session) return;
  active = undefined;
  clearInterval(session.timer);
  session.connection.destroy();
  const duration = (performance.now() - session.started) / 1000;
  session.capture.flush(duration, true);
  writeJson(join(session.directory, 'session.json'), {
    ...session.info, status: 'stopped', duration, packets: session.capture.packets,
    late_packets: session.capture.latePackets, decode_errors: session.decodeErrors,
    dave_failures: session.daveFailures, reason,
  });
  event(session, 'stopped', { actor, reason, duration, packets: session.capture.packets, decode_errors: session.decodeErrors, dave_failures: session.daveFailures });
  await session.text.send(`Recording stopped: ${reason}. ${session.capture.packets} packets captured; final audio queued for transcription.`);
}

async function start(actor) {
  snowflake('DISCORD_VOICE_CHANNEL_ID');
  if (active || starting) throw new Error('A recording is already active or starting');
  starting = true;
  let connection;
  try {
    const guild = await client.guilds.fetch(guildId);
    const voice = await guild.channels.fetch(voiceId);
    const text = await guild.channels.fetch(textId);
    if (!voice?.isVoiceBased() || !text?.isTextBased() || !text.send) throw new Error('Check voice/text channel IDs and bot permissions');
    await text.send('Starting discussion recording and local transcription. Everyone in the voice channel will be recorded until /vera stop. Tell everyone before starting.');
    connection = joinVoiceChannel({ channelId: voiceId, guildId, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: true, debug: true });
    connection.on('error', () => {}); // entersState handles a failed initial connection; avoid an unhandled emitter error.
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    const directory = join(root, randomUUID());
    mkdirSync(directory, { mode: 0o700 });
    const info = { session_id: directory.split(/[\\/]/).at(-1), started_utc: new Date().toISOString(), guild_id: guildId, voice_channel_id: voiceId, status: 'recording' };
    const session = { directory, info, text, connection, capture: new Capture(directory), started: performance.now(), decodeErrors: 0, daveFailures: 0 };
    active = session;
    writeJson(join(directory, 'session.json'), info);
    event(session, 'started', { actor, directory });
    connection.on('debug', message => {
      // Raw voice debug output includes session credentials; store counters only.
      if (/failed to decrypt/i.test(message)) session.daveFailures++;
    });
    connection.on('error', () => {
      event(session, 'connection_error');
      void stop('Voice connection failed').catch(console.error);
    });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      if (active === session) void stop('Voice disconnected; start a new session to resume').catch(console.error);
    });
    connection.receiver.speaking.on('start', userId => {
      if (active !== session || connection.receiver.subscriptions.has(userId)) return;
      const member = guild.members.cache.get(userId);
      const name = member?.displayName || client.users.cache.get(userId)?.username || `Discord user ${userId}`;
      const decoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
      const stream = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
      stream.once('close', () => decoder.delete());
      stream.on('data', packet => {
        if (active !== session) return;
        try {
          const pcm = decoder.decode(packet);
          session.capture.add(userId, name, pcm, (performance.now() - session.started) / 1000);
        } catch {
          session.decodeErrors++;
          event(session, 'decode_error', { user_id: userId });
        }
      });
      stream.on('error', () => {
        event(session, 'receive_error', { user_id: userId });
        void stop('Audio receive failed; inspect events before restarting').catch(console.error);
      });
    });
    session.timer = setInterval(() => {
      try {
        session.capture.flush((performance.now() - session.started) / 1000);
      } catch {
        event(session, 'audio_write_error');
        void stop('Audio could not be saved').catch(console.error);
      }
    }, 1000);
    return 'Recording started. Use /vera status to check audio receipt and /vera stop when finished.';
  } catch (error) {
    if (active) await stop('Start failed');
    else connection?.destroy();
    throw error;
  } finally {
    starting = false;
  }
}

client.once('clientReady', async () => {
  const command = new SlashCommandBuilder().setName('vera').setDescription('Control the discussion recorder');
  for (const action of ['start', 'stop', 'status']) command.addSubcommand(sub => sub.setName(action).setDescription(`${action} recording`));
  addReviewCommands(command, issues.publishingEnabled);
  try {
    await new REST().setToken(token).put(Routes.applicationGuildCommands(client.user.id, guildId), { body: [command.toJSON()] });
    console.log(generateDependencyReport());
    console.log('Ready. Capture starts only with /vera start in the configured text channel.');
    issues.start();
  } catch {
    console.error('Command registration failed. Check the guild ID and applications.commands install scope.');
    client.destroy();
    process.exitCode = 1;
  }
});

client.on('interactionCreate', async interaction => {
  if (await issues.review.handle(interaction)) return;
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'vera') return;
  try { issues.workflow.authorize(contextFor(interaction)); }
  catch (error) {
    await interaction.reply({ content: error.message, flags: 64 });
    return;
  }
  await interaction.deferReply({ flags: 64 });
  try {
    const action = interaction.options.getSubcommand();
    if (action === 'start') await interaction.editReply(await start(interaction.user.id));
    if (action === 'stop') {
      if (starting) throw new Error('Still connecting; wait for start to finish');
      await stop('Stopped by a controller', interaction.user.id);
      await interaction.editReply('Recording is stopped.');
    }
    if (action === 'status') {
      const files = active ? readdirSync(active.directory) : [];
      await interaction.editReply(active
        ? `Recording: ${active.capture.packets} decoded packets, ${active.decodeErrors} decode errors, ${active.daveFailures} DAVE failures, ${files.filter(f => f.endsWith('.job.json')).length} queued chunks. Speak, then check that packets increase. Silence alone cannot validate capture.`
        : 'No recording active.');
    }
  } catch (error) {
    // SDK errors can contain request details: expose only our own actionable messages.
    const message = error.constructor === Error ? error.message : 'Discord operation failed; check bot permissions and channel IDs.';
    await interaction.editReply(message);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  try { await stop('Recorder process shutting down'); }
  finally { issues.stop(); client.destroy(); }
});
client.login(token).catch(() => { console.error('Discord login failed. Check the bot token in .env.'); process.exitCode = 1; });
