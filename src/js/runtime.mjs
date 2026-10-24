import { join } from 'node:path';
import { Workflow, GitHub, text } from './workflow.mjs';
import { createAnalysis, TranscriptWatcher } from './analysis.mjs';
import { Review, preview } from './review.mjs';

export async function createWorkflow({ root, client, guildId, textId, env = process.env }) {
  const repo = env.GITHUB_REPO?.trim() || null;
  const githubToken = env.GITHUB_TOKEN?.trim() || null;
  const label = env.GITHUB_ISSUE_LABEL?.trim() || '';
  if (label) text(label, 'GITHUB_ISSUE_LABEL', 50);
  const publishingEnabled = Boolean(repo || githubToken);
  const mode = publishingEnabled ? 'github' : 'local';
  const language = env.ISSUE_LANGUAGE || 'English';
  const legacyIds = key => {
    const ids = (env[key] || '').split(',').map(s => s.trim()).filter(s => s && s !== 'replace_me');
    if (ids.some(id => !/^\d{17,20}$/.test(id))) throw new Error(`${key} must be comma-separated Discord user IDs`);
    return ids;
  };
  const editors = legacyIds('DISCORD_CONTROLLER_IDS'), approvers = legacyIds('ISSUE_APPROVER_IDS');
  if (publishingEnabled) {
    try { await new GitHub(repo, githubToken).checkAccess(label); }
    catch (error) { throw new Error(`GitHub startup check failed: ${error.message}. Set both GITHUB_REPO and GITHUB_TOKEN with Issues read/write access, or leave both unset to disable GitHub. If set, GITHUB_ISSUE_LABEL must name an existing repository label.`); }
    console.log(`GitHub startup check passed: ${repo}.`);
  } else {
    console.warn('\n' + '!'.repeat(72) + '\nWARNING: GITHUB PUBLISHING IS DISABLED\nGITHUB_REPO and GITHUB_TOKEN are unset. Recording, analysis and draft review\nremain available. GitHub posting controls are disabled.\n' + '!'.repeat(72) + '\n');
  }
  const analyzer = createAnalysis(env);
  console.log(`Checking analysis model: ${analyzer.label}...`);
  try {
    const result = await analyzer.analyze({ language: 'English', previous_summary: '',
      conversation: [{ id: 's1', speaker: 'Startup check', text: 'Hello.' }],
      new_segment_ids: ['s1'], topics: [] });
    if (!result || typeof result.summary !== 'string' || !result.summary.trim() || !Array.isArray(result.candidates) || result.candidates.length || !Array.isArray(result.withdrawn) || result.withdrawn.length) throw new Error('Model returned an unexpected startup analysis');
  } catch (error) {
    analyzer.close();
    throw new Error(`LLM startup check failed: ${error.message}. Check the configured provider, model, credentials and available resources.`);
  }
  console.log('LLM startup check passed.');
  const workflow = new Workflow(join(root, 'workflow.sqlite'), { editors, approvers, guild: guildId, channel: textId, mode });
  const publishers = new Map();
  const publisherFor = (publishMode, repository) => {
    if (!publishingEnabled || publishMode === 'local') return null;
    const key = `${publishMode}:${repository}`;
    if (publishMode !== 'github') throw new Error('This session uses an unsupported publishing destination; start a new session');
    if (!publishers.has(key)) publishers.set(key, new GitHub(repository, githubToken));
    return publishers.get(key);
  };
  const announcing = new Map();
  const announce = draft => {
    if (announcing.has(draft.id)) return announcing.get(draft.id);
    const pending = (async () => {
      const channel = await client.channels.fetch(textId);
      const previous = workflow.previewForDraft(draft.id);
      let message;
      if (previous) {
        try { message = await channel.messages.fetch(previous.messageId); }
        catch (error) { if (error.code !== 10008) throw error; } // Only recreate a deleted message; permission/network errors preserve its identity.
      }
      const current = workflow.get(draft.id);
      const history = workflow.history(current.id);
      const payload = preview(current, history, publishingEnabled);
      message = message ? await message.edit({ ...payload, attachments: [] }) : await channel.send(payload);
      workflow.registerPreview(message, current);
      const latest = workflow.get(current.id);
      if (latest.state === current.state && latest.revision === current.revision && workflow.history(current.id).length === history.length) {
        latest.announced = `${current.state}:${current.revision}`; workflow.save(latest);
      }
      for (const reaction of message.reactions?.cache.values() || []) if (reaction.me && ['✅', '❌'].includes(reaction.emoji.name)) {
        try { await reaction.users.remove(); } catch { /* Old human reactions may remain visible; reactions no longer perform actions. */ }
      }
    })().finally(() => announcing.delete(draft.id));
    announcing.set(draft.id, pending);
    return pending;
  };
  const watcher = new TranscriptWatcher({ root, workflow, analyzer, publisherFor, announce, config: { mode, repo, language, label, sttRun: env.STT_RUN || 'live' } });
  const review = new Review(workflow, publisherFor, announce, publishingEnabled);
  let timer;
  return {
    workflow, review, publishingEnabled,
    start() {
      console.log(`Issue workflow: ${mode.toUpperCase()} destination ${repo || 'none'}; language ${language}; ${workflow.access().approvers.length} publishers. Manage access with /vera access. Analysis uses ${analyzer.label}.`);
      for (const draft of workflow.list()) if (workflow.previewForDraft(draft.id)) { draft.announced = null; workflow.save(draft); }
      const tick = () => watcher.tick().catch(error => console.error(`Workflow: ${error.message}`));
      void tick(); timer = setInterval(tick, 5000);
    },
    stop() { clearInterval(timer); analyzer.close(); },
  };
}
