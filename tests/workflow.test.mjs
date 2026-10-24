import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { Workflow, GitHub, digest, publication, transcript } from '../workflow.mjs';
import { settings, policy, reviewer, publisher, rows, analysis, workflowFor, seedDraft, mockGitHub } from './support/fixtures.mjs';

test('unmocked HTTP and TCP connections fail before reaching external services', () => {
  assert.throws(() => fetch('https://api.github.com'), /Network disabled in tests/);
  assert.throws(() => new Socket().connect(11434, '127.0.0.1'), /Network disabled in tests/);
});

test('transcripts have stable IDs, preserve quotes and sort by timestamp', () => {
  const later = { ...rows[0], start: 5, end: 6 };
  const result = transcript([later, ...rows]);
  assert.deepEqual(result, transcript([...rows, later]));
  assert.equal(result[0].text, rows[0].text);
  assert.notEqual(result[0].id, result[1].id);
  for (const row of [{ ...rows[0], start: -1 }, { ...rows[0], end: NaN }, { ...rows[0], user_id: '' }]) {
    assert.throws(() => transcript([row]), /Invalid/);
  }
});

test('drafts settle after a minute and session settings cannot change', t => {
  const workflow = workflowFor(t);
  const draft = seedDraft(workflow, { ready: false });
  assert.equal(draft.state, 'settling');
  workflow.settle(59_999);
  assert.equal(workflow.get(draft.id).state, 'settling');
  workflow.settle(60_000);
  assert.equal(workflow.get(draft.id).state, 'ready');
  assert.match(draft.body, /Spara-knappen fungerar inte\./);
  assert.throws(() => workflow.openSession('session', { ...settings, language: 'Swedish' }), /configuration changed/);
});

test('only authorized human publishers can approve the current revision', async t => {
  const workflow = workflowFor(t), draft = seedDraft(workflow), github = mockGitHub();
  await assert.rejects(workflow.publish(draft.id, github), /Explicit approval/);
  for (const context of [reviewer, { ...publisher, human: false }, { ...publisher, guild: 'other' }, { ...publisher, channel: 'other' }]) {
    assert.throws(() => workflow.approve(context, draft.id, draft.revision, digest(draft)), /access|authorized/);
  }
  assert.throws(() => workflow.approve(publisher, draft.id, draft.revision - 1, digest(draft)), /stale/);
  assert.throws(() => workflow.approve(publisher, draft.id, draft.revision, 'wrong-hash'), /stale/);
  assert.equal(github.create.mock.callCount(), 0);
});

test('approved content is posted exactly once through a mocked publisher', async t => {
  const workflow = workflowFor(t), draft = seedDraft(workflow), github = mockGitHub();
  workflow.approve(publisher, draft.id, draft.revision, digest(draft));
  const url = await workflow.publish(draft.id, github);
  assert.equal(url, `https://github.com/${settings.repo}/issues/42`);
  assert.deepEqual(github.create.mock.calls[0].arguments, [publication(draft)]);
  assert.equal(await workflow.publish(draft.id, github), url);
  assert.equal(github.create.mock.callCount(), 1);
  assert.equal(workflow.get(draft.id).state, 'published');
  assert.equal(workflow.history(draft.id).filter(e => e.action === 'publication attempt').length, 1);
});

test('uncertain POSTs reconcile after restart without a second creation attempt', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'vera-workflow-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'workflow.sqlite');
  const workflow = new Workflow(path, policy);
  workflow.openSession('session', settings);
  const draft = seedDraft(workflow), github = mockGitHub();
  workflow.approve(publisher, draft.id, draft.revision, digest(draft));
  github.create.mock.mockImplementation(async () => { throw new Error('Connection lost after POST'); });
  try {
    await assert.rejects(workflow.publish(draft.id, github), /Connection lost/);
    assert.equal(workflow.get(draft.id).state, 'uncertain');
  } finally { workflow.close(); }
  const reopened = new Workflow(path, policy);
  t.after(() => reopened.close());
  await assert.rejects(reopened.publish(draft.id, github), /No further create attempt/);
  github.list.mock.mockImplementation(async () => [{ ...publication(draft), html_url: `https://github.com/${settings.repo}/issues/42` }]);
  await reopened.publish(draft.id, github);
  assert.equal(github.create.mock.callCount(), 1);
  assert.equal(reopened.get(draft.id).state, 'published');
});

test('a mismatched GitHub response stays uncertain and a different destination is refused', async t => {
  const workflow = workflowFor(t), draft = seedDraft(workflow), github = mockGitHub();
  workflow.approve(publisher, draft.id, draft.revision, digest(draft));
  await assert.rejects(workflow.publish(draft.id, { ...github, repo: 'other/repo' }), /destination/);
  github.create.mock.mockImplementation(async payload => ({ ...payload, html_url: 'https://github.com/other/repo/issues/42' }));
  await assert.rejects(workflow.publish(draft.id, github), /does not match/);
  assert.equal(workflow.get(draft.id).state, 'uncertain');
});

test('edits invalidate approvals, retain original evidence and reject stale controls', async t => {
  const workflow = workflowFor(t), draft = seedDraft(workflow), github = mockGitHub();
  workflow.approve(publisher, draft.id, draft.revision, digest(draft));
  const updated = workflow.edit(reviewer, draft.id, draft.revision, 'Corrected title', 'Corrected description');
  assert.equal(updated.state, 'ready');
  assert.equal(updated.approval, null);
  assert.deepEqual(updated.evidence, draft.evidence);
  assert.equal(updated.revision, draft.revision + 1);
  assert.throws(() => workflow.approve(publisher, draft.id, draft.revision, digest(draft)), /stale/);
  await assert.rejects(workflow.publish(draft.id, github), /Explicit approval/);
});

test('revoking publisher access cancels pending approvals and survives a restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'vera-access-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'workflow.sqlite'), workflow = new Workflow(path, policy);
  try {
    workflow.openSession('session', settings);
    const draft = seedDraft(workflow);
    workflow.approve(publisher, draft.id, draft.revision, digest(draft));
    assert.throws(() => workflow.setAccess(reviewer, publisher.user, 'none'), /Manage Server/);
    workflow.setAccess({ ...reviewer, manageGuild: true }, publisher.user, 'none');
    assert.equal(workflow.get(draft.id).approval, null);
    assert.equal(workflow.get(draft.id).state, 'ready');
  } finally { workflow.close(); }
  const reopened = new Workflow(path, policy);
  t.after(() => reopened.close());
  assert.equal(reopened.role(publisher.user), 'none');
});

test('invalid model references leave drafts and processed segments untouched', t => {
  const workflow = workflowFor(t), segments = transcript(rows), result = analysis(['invented']);
  assert.throws(() => workflow.applyAnalysis('session', segments, segments.map(s => s.id), result, []), /references/);
  assert.deepEqual(workflow.list(), []);
  assert.deepEqual(workflow.session('session').processed, []);
  result.candidates[0].evidence = segments.map(s => s.id);
  result.candidates[0].duplicates = [999];
  assert.throws(() => workflow.applyAnalysis('session', segments, segments.map(s => s.id), result, []), /references/);
});

test('GitHub HTTP adapter posts through an injected fetcher', async () => {
  const fetcher = mock.fn(async (_url, options) => Response.json({ ...JSON.parse(options.body), number: 42 }));
  const github = new GitHub(settings.repo, 'test-token', fetcher), payload = { title: 'Test', body: 'Mock issue' };
  assert.deepEqual(await github.create(payload), { ...payload, number: 42 });
  const [url, options] = fetcher.mock.calls[0].arguments;
  assert.equal(url, `https://api.github.com/repos/${settings.repo}/issues`);
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(options.body), payload);
});

test('GitHub listing paginates and excludes pull requests', async () => {
  const page = Array.from({ length: 100 }, (_, index) => ({ number: index + 1, title: `Issue ${index}` }));
  page[0].pull_request = {};
  const fetcher = mock.fn(async url => Response.json(url.endsWith('page=1') ? page : [{ number: 101, title: 'Last issue' }]));
  const issues = await new GitHub(settings.repo, 'test-token', fetcher).list();
  assert.equal(issues.length, 100);
  assert.equal(issues[0].number, 2);
  assert.equal(issues.at(-1).number, 101);
  assert.equal(fetcher.mock.callCount(), 2);
});

test('GitHub rejects HTTP errors, malformed listings and missing credentials', async () => {
  await assert.rejects(new GitHub(settings.repo, 'test-token', async () => new Response('', { status: 403 })).list(), /HTTP 403/);
  await assert.rejects(new GitHub(settings.repo, 'test-token', async () => Response.json({})).list(), /Invalid GitHub issue list/);
  const fetcher = mock.fn();
  await assert.rejects(new GitHub(settings.repo, '', fetcher).list(), /Configure/);
  assert.equal(fetcher.mock.callCount(), 0);
});

test('human evidence exclusions and duplicate selections survive later model analysis', t => {
  const workflow = workflowFor(t);
  const segments = transcript([...rows, { ...rows[0], start: 3, end: 4, text: 'That first report was mistaken.' }]);
  const ids = segments.map(row => row.id), result = analysis(ids);
  workflow.applyAnalysis('session', segments, ids, result, [], 0); workflow.settle(60_000);
  const draft = workflow.list()[0];
  workflow.edit(reviewer, draft.id, draft.revision, 'Developer correction', 'Only the second report is relevant.', {
    evidenceIds: [ids[1]], duplicates: [42], evidenceLabel: 'Relevant original quote',
  });
  workflow.applyAnalysis('session', segments, ids, analysis(ids), [], 1000);
  const updated = workflow.get(draft.id);
  assert.deepEqual(updated.evidence.map(row => row.id), [ids[1]]);
  assert.equal(updated.evidence[0].text, segments[1].text);
  assert.equal(updated.title, 'Developer correction');
  assert.deepEqual(updated.duplicates, [42]);
  assert.match(updated.body, /Relevant original quote/);
  assert.ok(!updated.body.includes(segments[0].text));
});

test('invalid evidence or duplicate edits roll back the entire approved revision', t => {
  const workflow = workflowFor(t), draft = seedDraft(workflow);
  workflow.approve(publisher, draft.id, draft.revision, digest(draft));
  const before = workflow.get(draft.id), history = workflow.history(draft.id);
  for (const change of [{ evidenceIds: ['unknown'] }, { evidenceIds: [] }, { duplicates: [-1] }]) {
    assert.throws(() => workflow.edit(reviewer, draft.id, draft.revision, 'Should not persist', 'Invalid edit', change));
    assert.deepEqual(workflow.get(draft.id), before);
    assert.deepEqual(workflow.history(draft.id), history);
  }
});

test('rejected and withdrawn topics stay closed; human-corrected drafts resist model withdrawal', t => {
  for (const decision of ['rejected', 'withdrawn', 'human-edited']) {
    const workflow = workflowFor(t), draft = seedDraft(workflow), segments = transcript(rows), ids = segments.map(row => row.id);
    if (decision === 'rejected') workflow.reject(reviewer, draft.id);
    if (decision === 'human-edited') workflow.edit(reviewer, draft.id, draft.revision, 'Confirmed by a developer', draft.description);
    workflow.applyAnalysis('session', [], [], { summary: 'The idea was corrected.', candidates: [], withdrawn: [draft.topic] }, [], 1000);
    workflow.applyAnalysis('session', segments, ids, analysis(ids), [], 2000);
    assert.equal(workflow.list().length, 1);
    assert.equal(workflow.get(draft.id).state, decision === 'human-edited' ? 'ready' : decision);
  }
});

test('an unrelated topic does not postpone an existing draft settling', t => {
  const workflow = workflowFor(t), first = seedDraft(workflow, { ready: false });
  const segments = transcript([{ ...rows[0], start: 10, end: 12, text: 'Add a dark mode.' }]), ids = segments.map(row => row.id);
  const result = analysis(ids); result.candidates[0].key = 'dark-mode';
  workflow.applyAnalysis('session', segments, ids, result, [], 59_000);
  workflow.settle(60_000);
  assert.equal(workflow.get(first.id).state, 'ready');
  assert.equal(workflow.list().find(draft => draft.topic === 'dark-mode').state, 'settling');
});

test('model wording changes cancel approval even without new evidence, without another settling delay', t => {
  const workflow = workflowFor(t), draft = seedDraft(workflow), segments = transcript(rows), ids = segments.map(row => row.id);
  workflow.approve(publisher, draft.id, draft.revision, digest(draft));
  const result = analysis(ids); result.candidates[0].title = 'The save action fails';
  workflow.applyAnalysis('session', segments, ids, result, [], 61_000);
  const updated = workflow.get(draft.id);
  assert.equal(updated.approval, null);
  assert.equal(updated.state, 'ready');
  assert.equal(updated.due, draft.due);
  assert.equal(updated.revision, draft.revision + 1);
});

test('simultaneous publication calls can reconcile but never send another POST', async t => {
  const workflow = workflowFor(t), draft = seedDraft(workflow), github = mockGitHub();
  workflow.approve(publisher, draft.id, draft.revision, digest(draft));
  let finish;
  github.create.mock.mockImplementation(payload => new Promise(resolve => { finish = () => resolve({ ...payload,
    html_url: `https://github.com/${draft.repo}/issues/42` }); }));
  const posting = workflow.publish(draft.id, github);
  await assert.rejects(workflow.publish(draft.id, github), /No further create attempt/);
  finish();
  await posting;
  assert.equal(workflow.get(draft.id).state, 'published');
  assert.equal(github.create.mock.callCount(), 1);
});
