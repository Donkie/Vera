import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OllamaAnalysis, ClaudeAnalysis, createAnalysis, AnalysisRunner, TranscriptWatcher } from '../../src/js/analysis.mjs';
import { writeJson } from '../../src/js/audio.mjs';
import { digest } from '../../src/js/workflow.mjs';
import { settings, publisher, rows, analysis, input, workflowFor, mockGitHub } from './support/fixtures.mjs';

test('Ollama uses mocked structured responses with CPU-only options and bounded references', async t => {
  const request = input();
  request.language = 'German';
  request.conversation[0].text = 'Le bouton Enregistrer ne fonctionne pas.';
  const fetcher = mock.fn(async () => Response.json({ done: true, done_reason: 'stop', message: { content: JSON.stringify(analysis()) } }));
  const analyzer = new OllamaAnalysis({ fetcher });
  t.after(() => analyzer.close());
  assert.deepEqual(await analyzer.analyze(request), analysis());
  const [url, options] = fetcher.mock.calls[0].arguments, body = JSON.parse(options.body);
  assert.equal(url, 'http://localhost:11434/api/chat');
  assert.equal(body.options.num_gpu, 0);
  assert.equal(body.keep_alive, 0);
  assert.deepEqual(body.format.properties.candidates.items.properties.evidence.items.enum, ['s1']);
  assert.equal(body.format.properties.candidates.items.properties.duplicates.maxItems, 0);
  assert.equal(body.format.properties.withdrawn.maxItems, 0);
  assert.match(body.messages[0].content, /in German\./);
  assert.doesNotMatch(body.messages[0].content, /Swedish/);
  assert.deepEqual(JSON.parse(body.messages[1].content), request);
});

test('Ollama rejects HTTP errors, unfinished responses and malformed JSON', async () => {
  for (const [response, expected] of [
    [new Response('', { status: 503 }), /HTTP 503/],
    [Response.json({ done: false }), /did not finish/],
    [Response.json({ done: true, done_reason: 'length' }), /did not finish/],
    [Response.json({ done: true, message: { content: '{' } }), SyntaxError],
  ]) {
    const analyzer = new OllamaAnalysis({ fetcher: async () => response });
    await assert.rejects(analyzer.analyze(input()), expected);
    analyzer.close();
  }
});

test('Claude parses mocked text blocks and sends the structured output schema', async t => {
  const request = input();
  request.language = 'German';
  request.conversation[0].text = 'Le bouton Enregistrer ne fonctionne pas.';
  const encoded = JSON.stringify(analysis());
  const fetcher = mock.fn(async () => Response.json({ stop_reason: 'end_turn', content: [
    { type: 'text', text: encoded.slice(0, 20) }, { type: 'text', text: encoded.slice(20) },
  ] }));
  const analyzer = new ClaudeAnalysis({ apiKey: 'test-key', fetcher });
  t.after(() => analyzer.close());
  assert.deepEqual(await analyzer.analyze(request), analysis());
  const [url, options] = fetcher.mock.calls[0].arguments, body = JSON.parse(options.body);
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(options.headers.Authorization, 'Bearer test-key');
  assert.equal(options.redirect, 'error');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.output_config.format.schema.properties.summary.maxLength, undefined);
  assert.match(body.system, /in German\./);
  assert.doesNotMatch(body.system, /Swedish/);
  assert.deepEqual(JSON.parse(body.messages[0].content), request);
});

test('Claude rejects incomplete, empty and invalid results without exposing provider secrets', async () => {
  for (const [fetcher, expected] of [
    [async () => { throw new Error('SECRET request details'); }, /request failed/],
    [async () => new Response('SECRET response body', { status: 429 }), /HTTP 429/],
    [async () => Response.json({ stop_reason: 'max_tokens' }), /did not finish/],
    [async () => Response.json({ stop_reason: 'end_turn', content: [] }), /no analysis text/],
    [async () => Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{' }] }), /invalid analysis JSON/],
  ]) {
    const analyzer = new ClaudeAnalysis({ apiKey: 'test-key', fetcher });
    await assert.rejects(analyzer.analyze(input()), error => expected.test(error.message) && !error.message.includes('SECRET'));
    assert.equal(analyzer.lastResult, undefined);
    analyzer.close();
  }
});

test('provider configuration and oversized context fail before any model request', async () => {
  assert.throws(() => createAnalysis({ LLM_PROVIDER: 'unknown' }), /LLM_PROVIDER/);
  assert.throws(() => createAnalysis({ LLM_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'replace_me' }), /ANTHROPIC_API_KEY/);
  assert.throws(() => new OllamaAnalysis({ url: 'file:///model' }), /Invalid Ollama URL/);
  const analyzer = createAnalysis({});
  assert.ok(analyzer instanceof OllamaAnalysis);
  analyzer.close();
  const fetcher = mock.fn(), oversized = input();
  oversized.previous_summary = 'x'.repeat(25_000);
  for (const model of [new OllamaAnalysis({ fetcher }), new ClaudeAnalysis({ apiKey: 'test-key', fetcher })]) {
    await assert.rejects(model.analyze(oversized), /exceeds 25 KB/);
    model.close();
  }
  assert.equal(fetcher.mock.callCount(), 0);
});

test('analysis runner batches 12 turns, restores evidence IDs and does not reprocess transcripts', async t => {
  const workflow = workflowFor(t), github = mockGitHub();
  const analyzer = { analyze: mock.fn(async request => analysis(request.new_segment_ids)) };
  const runner = new AnalysisRunner(workflow, analyzer, github);
  const turns = Array.from({ length: 13 }, (_, index) => ({ ...rows[0], start: index * 2, end: index * 2 + 1 }));
  const [draft] = await runner.ingest('session', turns, { ended: true, now: 0 });
  assert.equal(analyzer.analyze.mock.callCount(), 2);
  assert.equal(analyzer.analyze.mock.calls[0].arguments[0].new_segment_ids.length, 12);
  assert.equal(analyzer.analyze.mock.calls[1].arguments[0].new_segment_ids.length, 1);
  assert.equal(draft.evidence.length, 13);
  assert.ok(draft.evidence.every(s => /^[a-f0-9]{20}$/.test(s.id)));
  assert.equal(draft.state, 'ready');
  await runner.ingest('session', turns, { ended: true, now: 1 });
  assert.equal(analyzer.analyze.mock.callCount(), 2);
  assert.equal(github.list.mock.callCount(), 1);
  assert.equal(github.create.mock.callCount(), 0);
});

test('invented model citations are rejected without advancing transcript progress', async t => {
  const workflow = workflowFor(t), github = mockGitHub();
  const runner = new AnalysisRunner(workflow, { analyze: async () => analysis(['s999']) }, github);
  await assert.rejects(runner.ingest('session', rows), /evidence it was not given/);
  assert.deepEqual(workflow.session('session').processed, []);
  assert.deepEqual(workflow.list(), []);
});

test('new discussion invalidates approval while human corrections survive reanalysis', async t => {
  const workflow = workflowFor(t), github = mockGitHub();
  const analyzer = { analyze: async request => analysis(request.new_segment_ids) };
  const runner = new AnalysisRunner(workflow, analyzer, github);
  let [draft] = await runner.ingest('session', rows, { ended: true, now: 0 });
  draft = workflow.edit(publisher, draft.id, draft.revision, 'Human title', 'Human description');
  workflow.approve(publisher, draft.id, draft.revision, digest(draft));
  [draft] = await runner.ingest('session', [...rows, { ...rows[0], start: 3, end: 4, text: 'It also fails on retry.' }], { now: 1000 });
  assert.equal(draft.title, 'Human title');
  assert.equal(draft.description, 'Human description');
  assert.equal(draft.approval, null);
  assert.equal(draft.state, 'settling');
  assert.equal(draft.evidence.length, 2);
  assert.equal(github.create.mock.callCount(), 0);
});

function watcherFor(t, analyzer) {
  const root = mkdtempSync(join(tmpdir(), 'vera-watcher-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'session'), chunks = join(directory, 'recognitions', 'live', 'chunks');
  mkdirSync(chunks, { recursive: true });
  writeJson(join(directory, 'session.json'), { session_id: 'session', status: 'stopped' });
  writeJson(join(directory, '0-123.job.json'), {});
  writeJson(join(directory, 'recognitions', 'live', 'transcript.json'), rows);
  const workflow = workflowFor(t), github = mockGitHub(), announce = mock.fn(async () => {});
  const watcher = new TranscriptWatcher({ root, workflow, analyzer, publisherFor: () => github, announce,
    config: { ...settings, sttRun: 'live' } });
  return { watcher, workflow, github, announce, directory, chunks };
}

test('watcher waits for final STT chunks, announces once and never auto-approves', async t => {
  const analyzer = { analyze: mock.fn(async () => analysis()) };
  const { watcher, workflow, github, announce, chunks } = watcherFor(t, analyzer);
  await watcher.tick();
  assert.equal(workflow.session('session').ended, false);
  assert.equal(workflow.list()[0].state, 'settling');
  writeJson(join(chunks, '0-123.result.json'), {});
  await watcher.tick();
  assert.equal(workflow.session('session').ended, true);
  assert.equal(workflow.list()[0].state, 'ready');
  assert.equal(announce.mock.callCount(), 1);
  await watcher.tick();
  assert.equal(announce.mock.callCount(), 1);
  assert.equal(analyzer.analyze.mock.callCount(), 1);
  assert.equal(github.create.mock.callCount(), 0);
});

test('watcher waits for speech tails and checks completion against every source job', async t => {
  const { watcher, workflow, directory, chunks } = watcherFor(t, { analyze: async () => analysis() });
  writeJson(join(chunks, 'speech-123-0.result.json'), { segments: rows });
  await watcher.tick();
  assert.equal(workflow.session('session').ended, false);
  const completion = join(directory, 'recognitions', 'live', 'complete.json');
  writeJson(completion, { source_jobs: [] });
  await watcher.tick();
  assert.equal(workflow.session('session').ended, false);
  writeJson(completion, { source_jobs: ['0-123.job.json'] });
  await watcher.tick();
  assert.equal(workflow.session('session').ended, true);
  writeJson(join(directory, '1-123.job.json'), {});
  await watcher.tick();
  assert.equal(workflow.session('session').ended, false);
});

test('local sessions analyze and settle drafts without a GitHub publisher', async t => {
  const workflow = workflowFor(t);
  workflow.openSession('local-session', { repo: null, mode: 'local', language: 'English' });
  const analyzer = { analyze: mock.fn(async () => analysis()) };
  const runner = new AnalysisRunner(workflow, analyzer, null);
  const drafts = await runner.ingest('local-session', rows, { ended: true });
  assert.deepEqual(analyzer.analyze.mock.calls[0].arguments[0].existing_issues, []);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].mode, 'local');
  assert.equal(drafts[0].repo, null);
  assert.equal(drafts[0].state, 'ready');
  assert.throws(() => workflow.approve(publisher, drafts[0].id, drafts[0].revision, digest(drafts[0])), /disabled for this draft/);
  assert.equal(workflow.session('local-session').ended, true);
});

test('watcher persists failures, backs off and recovers using the same transcript', async t => {
  t.mock.method(console, 'error', () => {});
  const analyzer = { analyze: mock.fn(async () => { throw new Error('Mock model unavailable'); }) };
  const { watcher, workflow, directory } = watcherFor(t, analyzer);
  await watcher.tick();
  const errorPath = join(directory, 'analysis-error.json');
  assert.equal(JSON.parse(readFileSync(errorPath, 'utf8')).error, 'Mock model unavailable');
  assert.equal(watcher.running, false);
  await watcher.tick();
  assert.equal(analyzer.analyze.mock.callCount(), 1);
  analyzer.analyze.mock.mockImplementation(async () => analysis());
  watcher.failures.set('session', 0);
  await watcher.tick();
  assert.equal(existsSync(errorPath), false);
  assert.equal(workflow.list().length, 1);
});

for (const fail of [false, true]) {
  test(`watcher resumes persisted approval${fail ? ' but never retries an uncertain POST' : ' and announces the published issue'}`, async t => {
    const { watcher, workflow, github, announce } = watcherFor(t, { analyze: async () => analysis() });
    await watcher.tick(); workflow.settle(Infinity);
    const draft = workflow.list()[0];
    workflow.approve(publisher, draft.id, draft.revision, digest(draft));
    if (fail) github.create.mock.mockImplementation(async () => { throw new Error('Network response lost'); });
    await watcher.deliver();
    assert.equal(workflow.get(draft.id).state, fail ? 'uncertain' : 'published');
    assert.equal(announce.mock.calls.at(-1).arguments[0].state, fail ? 'uncertain' : 'published');
    await watcher.deliver();
    assert.equal(github.create.mock.callCount(), 1);
  });
}
