import { mock } from 'node:test';
import { Workflow, transcript } from '../../../src/js/workflow.mjs';

export const settings = { repo: 'example/project', mode: 'github', language: 'English' };
export const reviewer = { user: 'reviewer', human: true, guild: 'guild', channel: 'review' };
export const publisher = { ...reviewer, user: 'publisher' };
export const policy = { guild: 'guild', channel: 'review', editors: [reviewer.user], approvers: [publisher.user] };
export const rows = [{ start: 0, end: 2, user_id: '123', speaker: 'Ada', text: 'Spara-knappen fungerar inte.' }];
export const candidate = (evidence = ['s1']) => ({ key: 'save-button', title: 'Save button fails', description: 'The save button does not work.',
  evidence, duplicates: [], evidence_label: 'Original transcript evidence', duplicates_label: 'Possible duplicates' });
export const analysis = (evidence = ['s1']) => ({ summary: 'A save button problem was reported.', candidates: [candidate(evidence)], withdrawn: [] });
export const input = () => ({ language: 'English', previous_summary: '', conversation: [{ ...rows[0], id: 's1' }],
  new_segment_ids: ['s1'], topics: [], existing_issues: [] });

export function workflowFor(t, path = ':memory:') {
  const workflow = new Workflow(path, policy);
  t.after(() => workflow.close());
  workflow.openSession('session', settings);
  return workflow;
}

export function seedDraft(workflow, { ready = true } = {}) {
  const segments = transcript(rows);
  workflow.applyAnalysis('session', segments, segments.map(s => s.id), analysis(segments.map(s => s.id)), [], 0);
  if (ready) workflow.settle(60_000);
  return workflow.list('session')[0];
}

export function mockGitHub() {
  return { ...settings, list: mock.fn(async () => []), create: mock.fn(async payload => ({ ...payload, number: 42,
    html_url: `https://github.com/${settings.repo}/issues/42` })) };
}

export function githubAccessResponse(url, options) {
  if (url === `https://api.github.com/repos/${settings.repo}` && options.method === 'GET') return Response.json({ has_issues: true, archived: false, disabled: false });
  if (url.endsWith('/issues?state=all&per_page=1') && options.method === 'GET') return Response.json([]);
  if (url.endsWith('/issues') && options.method === 'POST' && options.body === '{"title":""}') return Response.json({ message: 'Validation Failed', errors: [{ message: "title can't be blank", value: null, resource: 'Issue', field: 'title', code: 'invalid' }] }, { status: 422 });
  throw new Error('Unexpected GitHub access request');
}

export function startupResponse(url, options) {
  if (url.startsWith('https://api.github.com/')) return githubAccessResponse(url, options);
  const content = JSON.stringify({ summary: 'A greeting.', candidates: [], withdrawn: [] });
  if (url === 'http://localhost:11434/api/chat') return Response.json({ done: true, message: { content } });
  if (url === 'https://api.anthropic.com/v1/messages') return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: content }] });
  throw new Error('Unexpected startup request');
}

export function commandFor(action, values = {}, context = reviewer) {
  return { user: { id: context.user, bot: !context.human }, guildId: context.guild, channelId: context.channel,
    memberPermissions: { has: () => context.manageGuild === true }, commandName: 'vera',
    isButton: () => false, isModalSubmit: () => false, isChatInputCommand: () => true,
    options: { getSubcommand: () => action, getString: key => values[key] ?? null, getUser: key => values[key] ?? null },
    reply: mock.fn(async () => {}), deferReply: mock.fn(async () => {}), editReply: mock.fn(async () => {}),
    showModal: mock.fn(async () => {}), deferUpdate: mock.fn(async () => {}) };
}
