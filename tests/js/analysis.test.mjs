import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OllamaAnalysis, ClaudeAnalysis, createAnalysis, AnalysisRunner, TranscriptWatcher } from '../../src/js/analysis.mjs';
import { writeJson } from '../../src/js/audio.mjs';
import { digest, transcript } from '../../src/js/workflow.mjs';
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
  assert.equal(body.format.properties.candidates.items.properties.duplicates, undefined);
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

test('both providers rewrite a draft from the reviewer prompt, sending quotes as context and trimming old ones to fit', async () => {
  const revised = { title: 'Cache fails', description: 'The cache fails on Windows.' };
  const draft = { language: 'German', prompt: 'It was "cache", not "crash"', title: 'Crash', description: 'It crashes.',
    evidence: [{ id: 'old', speaker: 'Ada', text: 'x'.repeat(30_000) }, { id: 'new', speaker: 'Bo', text: 'The crash fails on Windows.' }] };
  for (const [analyzer, reply, read] of [
    [OllamaAnalysis, value => Response.json({ done: true, message: { content: JSON.stringify(value) } }), body => [body.messages[0].content, body.messages[1].content, body.format]],
    [ClaudeAnalysis, value => Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(value) }] }), body => [body.system, body.messages[0].content, body.output_config.format.schema]],
  ]) {
    const fetcher = mock.fn(async () => reply(revised)), model = new analyzer({ apiKey: 'test-key', fetcher });
    assert.deepEqual(await model.rewrite(draft), revised);
    const [system, content, format] = read(JSON.parse(fetcher.mock.calls[0].arguments[1].body));
    assert.match(system, /in German\./);
    assert.deepEqual(format.required, ['title', 'description']);
    assert.deepEqual(JSON.parse(content), { request: draft.prompt, title: 'Crash', description: 'It crashes.',
      evidence: analyzer === OllamaAnalysis ? [{ speaker: 'Bo', text: 'The crash fails on Windows.' }] : draft.evidence.map(({ speaker, text }) => ({ speaker, text })) });
    model.close();
  }
});

test('provider configuration and oversized context fail before any model request', async () => {
  assert.throws(() => createAnalysis({ LLM_PROVIDER: 'unknown' }), /LLM_PROVIDER/);
  assert.throws(() => createAnalysis({ LLM_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'replace_me' }), /ANTHROPIC_API_KEY/);
  assert.throws(() => new OllamaAnalysis({ url: 'file:///model' }), /Invalid Ollama URL/);
  const analyzer = createAnalysis({});
  assert.ok(analyzer instanceof OllamaAnalysis);
  analyzer.close();
  const fetcher = mock.fn();
  for (const [model, kb] of [[new OllamaAnalysis({ fetcher }), 25], [new ClaudeAnalysis({ apiKey: 'test-key', fetcher }), 100]]) {
    const oversized = input();
    oversized.previous_summary = 'x'.repeat(model.contextLimit);
    await assert.rejects(model.analyze(oversized), new RegExp(`exceeds ${kb} KB`));
    model.close();
  }
  assert.equal(fetcher.mock.callCount(), 0);
});

test('analysis runner batches 12 turns, restores evidence IDs and does not reprocess transcripts', async t => {
  const log = t.mock.method(console, 'log', () => {});
  const workflow = workflowFor(t), github = mockGitHub();
  const analyzer = { analyze: mock.fn(async request => analysis(request.new_segment_ids)) };
  const runner = new AnalysisRunner(workflow, analyzer);
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
  assert.equal(github.list.mock.callCount(), 0);
  assert.equal(github.create.mock.callCount(), 0);
  assert.equal(log.mock.calls.filter(call => call.arguments[0].includes('] analysis complete:')).length, 1);
});

for (const provider of ['ollama', 'claude']) {
  test(`${provider} fits long Unicode turns into smaller requests without losing evidence or progress`, async t => {
    const workflow = workflowFor(t), requests = [];
    const fetcher = async (_url, options) => {
      const body = JSON.parse(options.body);
      const content = body.messages.at(-1).content;
      assert.ok(Buffer.byteLength(content + (body.system || body.messages[0].content)) < analyzer.contextLimit);
      const request = JSON.parse(content);
      requests.push(request);
      const result = JSON.stringify(analysis(request.new_segment_ids));
      return Response.json(provider === 'ollama'
        ? { done: true, message: { content: result } }
        : { stop_reason: 'end_turn', content: [{ type: 'text', text: result }] });
    };
    const analyzer = provider === 'ollama' ? new OllamaAnalysis({ fetcher }) : new ClaudeAnalysis({ apiKey: 'test-key', fetcher });
    t.after(() => analyzer.close());
    const runner = new AnalysisRunner(workflow, analyzer);
    const turns = Array.from({ length: 13 }, (_, i) => ({ ...rows[0], start: i * 2, end: i * 2 + 1, text: (provider === 'ollama' ? 'Åäö '.repeat(400) : '界'.repeat(3500)) + i }));
    const [draft] = await runner.ingest('session', turns, { ended: true });
    assert.ok(requests.length > 2);
    assert.ok(requests[0].new_segment_ids.length < 12);
    assert.ok(requests.some(request => request.context_omitted.prior_segments > 0));
    assert.equal(requests.reduce((n, request) => n + request.new_segment_ids.length, 0), turns.length);
    assert.deepEqual(draft.evidence, transcript(turns).map(s => ({ ...s, session_id: 'session' })));
    assert.deepEqual(workflow.session('session').processed, transcript(turns).map(s => s.id));
    assert.equal(workflow.session('session').ended, true);
    const calls = requests.length;
    await new AnalysisRunner(workflow, analyzer).ingest('session', turns, { ended: true });
    assert.equal(requests.length, calls);
  });
}

test('large saved topic descriptions and evidence are compacted without changing saved drafts', async t => {
  const workflow = workflowFor(t);
  const turns = transcript(Array.from({ length: 15 }, (_, i) => ({ ...rows[0], start: i * 2, end: i * 2 + 1 })));
  const seed = analysis(turns.map(s => s.id));
  seed.candidates = Array.from({ length: 25 }, (_, i) => ({ ...seed.candidates[0], key: `topic-${i}`, description: 'ä'.repeat(3500) }));
  workflow.applyAnalysis('session', turns, turns.map(s => s.id), seed, [], 0);
  workflow.settle(60_000);
  const saved = workflow.list('session');
  saved[0].state = 'rejected'; workflow.save(saved[0]);
  saved[1].human_edited = true; workflow.save(saved[1]);
  const requests = [];
  const analyzer = new OllamaAnalysis({ fetcher: async (_url, options) => {
    const request = JSON.parse(JSON.parse(options.body).messages[1].content);
    requests.push(request);
    return Response.json({ done: true, message: { content: JSON.stringify({ summary: 'No new issue.', candidates: [], withdrawn: [] }) } });
  } });
  t.after(() => analyzer.close());
  await new AnalysisRunner(workflow, analyzer).ingest('session', [...turns, { ...rows[0], start: 40, end: 41 }], { ended: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].topics.length, saved.length);
  const sent = new Map(requests[0].topics.map(topic => [topic.key, topic]));
  assert.equal(sent.get(saved[0].topic).state, 'rejected');
  assert.equal(sent.get(saved[1].topic).human_edited, true);
  assert.ok(requests[0].topics.every(topic => topic.evidence.length === 12 && !('description' in topic)));
  assert.equal(requests[0].context_omitted.topic_descriptions, saved.length);
  assert.equal(requests[0].context_omitted.topic_evidence, 75);
  assert.deepEqual(saved.map(d => workflow.get(d.id)), saved);
});

test('closed topic descriptions are dropped before open topic context or new turns', async t => {
  const workflow = workflowFor(t);
  const turns = transcript(Array.from({ length: 12 }, (_, i) => ({ ...rows[0], start: i * 2, end: i * 2 + 1 })));
  const seed = analysis(turns.map(s => s.id));
  seed.candidates = Array.from({ length: 10 }, (_, i) => ({ ...seed.candidates[0], key: `topic-${i}`, description: 'ä'.repeat(1200) }));
  workflow.applyAnalysis('session', turns, turns.map(s => s.id), seed, [], 0);
  workflow.settle(60_000);
  for (const draft of workflow.list('session').slice(1)) { draft.state = 'rejected'; workflow.save(draft); }
  const requests = [];
  const analyzer = { analyze: async request => { requests.push(request); return { summary: 'No new issue.', candidates: [], withdrawn: [] }; } };
  const more = Array.from({ length: 12 }, (_, i) => ({ ...rows[0], start: 30 + i * 2, end: 31 + i * 2 }));
  await new AnalysisRunner(workflow, analyzer).ingest('session', [...turns, ...more], { ended: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].new_segment_ids.length, 12);
  assert.equal(requests[0].context_omitted.topic_descriptions, 9);
  assert.deepEqual(requests[0].topics.filter(topic => topic.description).map(topic => topic.key), ['topic-0']);
});

test('live sessions wait for full batches and flush partial ones after the wait', async t => {
  const workflow = workflowFor(t);
  const analyzer = { analyze: mock.fn(async request => analysis(request.new_segment_ids)) };
  const runner = new AnalysisRunner(workflow, analyzer);
  const turns = Array.from({ length: 17 }, (_, i) => ({ ...rows[0], start: i * 2, end: i * 2 + 1 }));
  await runner.ingest('session', turns.slice(0, 5), { now: 0 });
  assert.equal(analyzer.analyze.mock.callCount(), 0);
  assert.equal(runner.deferred, true);
  await runner.ingest('session', turns, { now: 60_000 });
  assert.equal(analyzer.analyze.mock.callCount(), 1);
  assert.equal(analyzer.analyze.mock.calls[0].arguments[0].new_segment_ids.length, 12);
  assert.equal(runner.deferred, true);
  await runner.ingest('session', turns, { now: 179_999 });
  assert.equal(analyzer.analyze.mock.callCount(), 1);
  await runner.ingest('session', turns, { now: 180_000 });
  assert.equal(analyzer.analyze.mock.callCount(), 2);
  assert.equal(analyzer.analyze.mock.calls[1].arguments[0].new_segment_ids.length, 5);
  assert.equal(runner.deferred, false);
  assert.deepEqual(Object.keys(analyzer.analyze.mock.calls[1].arguments[0].conversation[0]), ['id', 'speaker', 'text']);
  assert.equal(workflow.session('session').processed.length, 17);
});

test('reanalysis keeps duplicates already on a draft without sending issue titles', async t => {
  const workflow = workflowFor(t);
  const seed = analysis(transcript(rows).map(s => s.id));
  seed.candidates[0].duplicates = [5];
  seed.candidates[0].duplicates_label = 'Possible duplicates';
  workflow.applyAnalysis('session', transcript(rows), transcript(rows).map(s => s.id), seed, [{ number: 5 }], 0);
  const analyzer = { analyze: mock.fn(async request => analysis(request.new_segment_ids)) };
  const [draft] = await new AnalysisRunner(workflow, analyzer).ingest('session', [...rows, { ...rows[0], start: 3, end: 4 }], { ended: true });
  assert.equal(analyzer.analyze.mock.callCount(), 1);
  assert.deepEqual(draft.duplicates, [5]);
  assert.equal(draft.duplicates_label, 'Possible duplicates');
  assert.equal(draft.evidence.length, 2);
});

test('a later batch failure resumes from the last committed batch', async t => {
  const workflow = workflowFor(t);
  const turns = Array.from({ length: 13 }, (_, i) => ({ ...rows[0], start: i * 2, end: i * 2 + 1 }));
  const analyzer = { analyze: mock.fn(async request => {
    if (request.new_segment_ids.length === 1) throw new Error('Model unavailable');
    return analysis(request.new_segment_ids);
  }) };
  await assert.rejects(new AnalysisRunner(workflow, analyzer).ingest('session', turns, { ended: true }), /Model unavailable/);
  assert.equal(workflow.session('session').processed.length, 12);
  assert.equal(workflow.session('session').ended, false);
  analyzer.analyze.mock.mockImplementation(async request => analysis(request.new_segment_ids));
  const [draft] = await new AnalysisRunner(workflow, analyzer).ingest('session', turns, { ended: true });
  assert.equal(analyzer.analyze.mock.calls.at(-1).arguments[0].new_segment_ids.length, 1);
  assert.equal(workflow.session('session').processed.length, 13);
  assert.equal(draft.evidence.length, 13);
});

test('invented model citations are rejected without advancing transcript progress', async t => {
  const workflow = workflowFor(t), github = mockGitHub();
  const runner = new AnalysisRunner(workflow, { analyze: async () => analysis(['s999']) });
  await assert.rejects(runner.ingest('session', rows, { ended: true }), /evidence it was not given/);
  assert.deepEqual(workflow.session('session').processed, []);
  assert.deepEqual(workflow.list(), []);
});

test('new discussion invalidates approval while human corrections survive reanalysis', async t => {
  const workflow = workflowFor(t), github = mockGitHub();
  const analyzer = { analyze: async request => analysis(request.new_segment_ids) };
  const runner = new AnalysisRunner(workflow, analyzer, { wait: 0 });
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
    config: { ...settings, sttRun: 'live', analysisWait: 0 } });
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

test('watcher applies labels to new sessions and preserves saved labels after configuration changes', async t => {
  const { watcher, workflow, directory } = watcherFor(t, { analyze: async () => analysis() });
  const legacy = workflow.session('session');
  delete legacy.label; workflow.saveSession(legacy);
  watcher.config.label = 'vera:raw';
  await watcher.tick();
  assert.equal(workflow.list('session')[0].label, '');
  writeJson(join(directory, 'session.json'), { session_id: 'new-session', status: 'stopped' });
  await watcher.tick();
  assert.equal(workflow.session('new-session').label, 'vera:raw');
  assert.equal(workflow.list('new-session')[0].label, 'vera:raw');
  watcher.config.label = 'other';
  await watcher.tick();
  assert.equal(existsSync(join(directory, 'analysis-error.json')), false);
  assert.equal(workflow.session('new-session').label, 'vera:raw');
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
  const runner = new AnalysisRunner(workflow, analyzer);
  const drafts = await runner.ingest('local-session', rows, { ended: true });
  assert.equal('existing_issues' in analyzer.analyze.mock.calls[0].arguments[0], false);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].mode, 'local');
  assert.equal(drafts[0].repo, null);
  assert.equal(drafts[0].state, 'ready');
  assert.throws(() => workflow.approve(publisher, drafts[0].id, drafts[0].revision, digest(drafts[0])), /disabled for this draft/);
  assert.equal(workflow.session('local-session').ended, true);
});

test('watcher persists failures, backs off and recovers using the same transcript', async t => {
  t.mock.method(console, 'error', () => {});
  const log = t.mock.method(console, 'log', () => {});
  const analyzer = { analyze: mock.fn(async () => { throw new Error('Mock model unavailable'); }) };
  const { watcher, workflow, directory } = watcherFor(t, analyzer);
  await watcher.tick();
  const errorPath = join(directory, 'analysis-error.json');
  assert.equal(JSON.parse(readFileSync(errorPath, 'utf8')).error, 'Mock model unavailable');
  assert.equal(watcher.running, false);
  await watcher.tick();
  assert.equal(analyzer.analyze.mock.callCount(), 1);
  analyzer.analyze.mock.mockImplementation(async () => analysis());
  watcher.failures.get('session').retryAt = 0;
  await watcher.tick();
  assert.equal(existsSync(errorPath), false);
  assert.equal(workflow.list().length, 1);
  await watcher.tick();
  assert.equal(log.mock.calls.filter(call => call.arguments[0].includes('] analysis resumed:')).length, 1);
});

test('an oversized single turn waits quietly for changed input and recovers without deleting progress', async t => {
  const errors = t.mock.method(console, 'error', () => {});
  const fetcher = mock.fn(async () => Response.json({ done: true, message: { content: JSON.stringify(analysis()) } }));
  const analyzer = new OllamaAnalysis({ fetcher });
  t.after(() => analyzer.close());
  const { watcher, workflow, directory } = watcherFor(t, analyzer);
  const path = join(directory, 'recognitions', 'live', 'transcript.json');
  writeJson(path, [{ ...rows[0], text: '界'.repeat(8000) }]);
  await watcher.tick();
  assert.deepEqual(workflow.session('session').processed, []);
  assert.equal(JSON.parse(readFileSync(join(directory, 'analysis-error.json'), 'utf8')).retry_after, null);
  assert.match(errors.mock.calls[0].arguments[0], /Waiting for a transcript change or restart/);
  await watcher.tick();
  assert.equal(errors.mock.callCount(), 1);
  assert.equal(fetcher.mock.callCount(), 0);
  writeJson(path, rows);
  await watcher.tick();
  assert.equal(fetcher.mock.callCount(), 1);
  assert.equal(workflow.session('session').processed.length, 1);
  assert.equal(existsSync(join(directory, 'analysis-error.json')), false);
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
