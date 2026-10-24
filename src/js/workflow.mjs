import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function text(value, name, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`Invalid ${name} (1–${limit} characters required)`);
  return value.trim();
}
export function transcript(rows) {
  if (!Array.isArray(rows) || rows.length > 100_000) throw new Error('Expected a transcript array (at most 100,000 segments)');
  return rows.map(row => {
    if (![row.start, row.end].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) || row.end < row.start) throw new Error('Invalid transcript timestamps');
    const segment = { start: row.start, end: row.end, user_id: text(row.user_id, 'speaker ID', 100), speaker: text(row.speaker, 'speaker', 100), text: text(row.text, 'transcript text', 8000) };
    return { ...segment, id: hash(segment).slice(0, 20) };
  }).sort((a, b) => a.start - b.start || a.user_id.localeCompare(b.user_id));
}
function timestamp(value) {
  const ms = Math.round(value * 1000);
  return `${String(Math.floor(ms / 60_000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
function body(draft) {
  const evidence = draft.evidence.map(s => `> [${timestamp(s.start)}–${timestamp(s.end)}] ${s.speaker.replaceAll('\n', ' ')} (${s.session_id}; ${s.id}): ${s.text.replaceAll('\n', '\n> ')}`).join('\n\n');
  const duplicates = draft.duplicates.length ? `\n\n### ${draft.duplicates_label}\n${draft.duplicates.map(n => `- https://github.com/${draft.repo}/issues/${n}`).join('\n')}` : '';
  return `${draft.description}\n\n### ${draft.evidence_label}\n${evidence}${duplicates}`;
}
export const digest = draft => hash({ repo: draft.repo, mode: draft.mode, language: draft.language, title: draft.title, body: draft.body });
export const marker = draft => `<!-- vera:${draft.id}:${digest(draft)} -->`;
export const publication = draft => ({ title: draft.title, body: `${draft.body}\n\n${marker(draft)}` });
const editable = new Set(['settling', 'ready', 'rejected', 'withdrawn', 'approved']);

export class Workflow {
  constructor(path, policy) {
    this.policy = policy;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, topic TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(session_id, topic));
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, draft_id TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS preview_messages(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS access(guild TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    // Import legacy environment permissions once; revoked access must never return after a restart.
    this.db.prepare('INSERT OR IGNORE INTO access VALUES (?,?)').run(policy.guild, JSON.stringify({ editors: [...new Set(policy.editors || [])], approvers: [...new Set(policy.approvers || [])] }));
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  authorize(context, approval = false) {
    this.authorizeChannel(context);
    const access = this.access();
    const allowed = approval ? access.approvers : [...access.editors, ...access.approvers];
    if (!allowed.includes(context.user)) throw new Error(`You need Vera ${approval ? 'publisher' : 'reviewer'} access. Use /vera access to check your access; a member with Manage Server can grant it with /vera access user:@you role:${approval ? 'publisher' : 'reviewer'}`);
  }
  authorizeChannel(context) {
    if (!context?.human || context.guild !== this.policy.guild || context.channel !== this.policy.channel) throw new Error('This person/channel is not authorized for that action');
  }
  access() { return JSON.parse(this.db.prepare('SELECT data FROM access WHERE guild=?').get(this.policy.guild).data); }
  role(user) { const access = this.access(); return access.approvers.includes(user) ? 'publisher' : access.editors.includes(user) ? 'reviewer' : 'none'; }
  setAccess(context, user, role) {
    this.authorizeChannel(context);
    if (!context.manageGuild) throw new Error('Manage Server permission is required to change Vera access');
    user = text(user, 'Discord user ID', 100);
    if (!['reviewer', 'publisher', 'none'].includes(role)) throw new Error('Choose reviewer, publisher, or none');
    return this.transaction(() => {
      const access = this.access();
      access.editors = access.editors.filter(id => id !== user);
      access.approvers = access.approvers.filter(id => id !== user);
      if (role === 'reviewer') access.editors.push(user);
      if (role === 'publisher') access.approvers.push(user);
      this.db.prepare('UPDATE access SET data=? WHERE guild=?').run(JSON.stringify(access), this.policy.guild);
      if (role !== 'publisher') for (const draft of this.list()) if (draft.state === 'approved' && draft.approval?.user === user) {
        draft.approval = null; draft.state = 'ready'; draft.revision++; this.save(draft);
        this.event(draft.id, 'approval revoked', context.user, { revision: draft.revision });
      }
      this.event(null, 'access changed', context.user, { user, role });
      return role;
    });
  }
  session(id) { const row = this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; }
  saveSession(session) { this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?)').run(session.id, JSON.stringify(session)); }
  openSession(id, { repo, language, mode }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || mode !== 'github') throw new Error('Configure a valid repository and publish mode');
    const previous = this.session(id);
    if (previous) {
      if (previous.repo !== repo || previous.language !== language || previous.mode !== mode) throw new Error('Session configuration changed; use a new session ID to avoid changing previously reviewed content');
      return previous;
    }
    const session = { id: text(id, 'session ID', 100), repo, language: text(language, 'issue language', 80), mode, processed: [], segments: {}, summary: '', ended: false };
    this.saveSession(session);
    return session;
  }
  get(id) {
    const row = this.db.prepare('SELECT data FROM drafts WHERE id=?').get(id);
    if (!row) throw new Error('Draft not found');
    return JSON.parse(row.data);
  }
  list(sessionId) {
    const rows = sessionId ? this.db.prepare('SELECT data FROM drafts WHERE session_id=? ORDER BY rowid').all(sessionId) : this.db.prepare('SELECT data FROM drafts ORDER BY rowid').all();
    return rows.map(row => JSON.parse(row.data)).filter(draft => draft.mode === 'github');
  }
  save(draft) { this.db.prepare('INSERT OR REPLACE INTO drafts VALUES (?,?,?,?)').run(draft.id, draft.session_id, draft.topic, JSON.stringify(draft)); }
  event(draftId, action, user, detail) { this.db.prepare('INSERT INTO events(draft_id,data) VALUES (?,?)').run(draftId, JSON.stringify({ at: new Date().toISOString(), action, user, detail })); }
  history(id) { return this.db.prepare('SELECT data FROM events WHERE draft_id=? ORDER BY id').all(id).map(row => JSON.parse(row.data)); }
  registerPreview(message, draft) {
    if (message.guildId !== this.policy.guild || message.channelId !== this.policy.channel || !message.author?.bot) throw new Error('Preview must be sent by the bot in the configured review channel');
    this.db.prepare('INSERT OR REPLACE INTO preview_messages VALUES (?,?)').run(message.id, JSON.stringify({ id: draft.id, revision: draft.revision, hash: digest(draft), author: message.author.id }));
  }
  previewForDraft(id) {
    const row = this.db.prepare("SELECT id,data FROM preview_messages WHERE json_extract(data,'$.id')=? ORDER BY rowid DESC LIMIT 1").get(id);
    return row ? { messageId: row.id, ...JSON.parse(row.data) } : null;
  }

  applyAnalysis(sessionId, rows, processedIds, result, existingIssues, now = Date.now()) {
    if (!Array.isArray(result.candidates) || !Array.isArray(result.withdrawn) || result.candidates.length > 30) throw new Error('Invalid analysis result');
    const session = this.session(sessionId);
    if (!session) throw new Error('Session not found');
    const source = { ...session.segments, ...Object.fromEntries(rows.map(s => [s.id, { ...s, session_id: sessionId }])) };
    const issueNumbers = new Set(existingIssues.map(issue => issue.number));
    const candidates = result.candidates.map(candidate => {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(candidate.key) || !Array.isArray(candidate.evidence) || !candidate.evidence.length || candidate.evidence.some(id => !source[id]) || !Array.isArray(candidate.duplicates) || candidate.duplicates.some(n => !issueNumbers.has(n))) throw new Error('Analysis contains invalid topic/evidence/duplicate references');
      return { topic: candidate.key, title: text(candidate.title, 'title', 200), description: text(candidate.description, 'description', 3500), evidence_label: text(candidate.evidence_label, 'evidence heading', 80), duplicates_label: candidate.duplicates.length || candidate.duplicates_label?.trim() ? text(candidate.duplicates_label, 'duplicate heading', 80) : '', evidence: [...new Set(candidate.evidence)].map(id => source[id]), duplicates: [...new Set(candidate.duplicates)] };
    });
    if (new Set(candidates.map(c => c.topic)).size !== candidates.length || result.withdrawn.some(key => typeof key !== 'string')) throw new Error('Analysis contains repeated or invalid topics');
    const summary = text(result.summary, 'summary', 5000);
    return this.transaction(() => {
      for (const candidate of candidates) {
        const previous = this.list(sessionId).find(d => d.topic === candidate.topic);
        if (previous && (!editable.has(previous.state) || ['rejected', 'withdrawn'].includes(previous.state))) continue;
        if (previous?.human_edited) {
          candidate.evidence = candidate.evidence.filter(s => !(previous.excluded_evidence || []).includes(s.id));
          candidate.duplicates = previous.duplicates;
          candidate.evidence_label = previous.evidence_label;
          candidate.duplicates_label = previous.duplicates_label;
        }
        const hasNewDiscussion = !previous || candidate.evidence.some(s => !previous.evidence.some(old => old.id === s.id));
        const next = previous
          ? { ...previous, ...candidate, topic: previous.topic, title: previous.human_edited ? previous.title : candidate.title, description: previous.human_edited ? previous.description : candidate.description }
          : { ...candidate, id: randomUUID().replaceAll('-', '').slice(0, 16), session_id: sessionId, repo: session.repo, mode: session.mode, language: session.language, revision: 0, human_edited: false, state: 'settling', approval: null, url: null };
        // Never drop evidence when a later analysis window only refers to the latest turn.
        next.evidence = [...new Map([...(previous?.evidence ?? []), ...candidate.evidence].map(s => [s.id, s])).values()].sort((a, b) => a.start - b.start);
        next.body = text(body(next), 'issue body (split this topic if too large)', 60_000);
        if (previous && digest(previous) === digest(next) && !hasNewDiscussion) continue;
        next.revision++;
        next.approval = null;
        if (hasNewDiscussion) { next.state = 'settling'; next.due = now + 60_000; }
        else if (next.state === 'approved') next.state = 'ready';
        this.save(next);
        this.event(next.id, 'analysis', 'vera', { revision: next.revision, hash: digest(next) });
      }
      for (const key of result.withdrawn) {
        const draft = this.list(sessionId).find(d => d.topic === key);
        if (draft && editable.has(draft.state) && !draft.human_edited && !['rejected', 'withdrawn'].includes(draft.state)) {
          draft.state = 'withdrawn'; draft.approval = null; draft.revision++; this.save(draft);
          this.event(draft.id, 'withdrawn by discussion', 'vera', { revision: draft.revision });
        }
      }
      session.segments = source;
      session.processed = [...new Set([...session.processed, ...processedIds])];
      session.summary = summary;
      this.saveSession(session);
    });
  }
  settle(now = Date.now(), finalSession) {
    return this.transaction(() => {
      for (const draft of this.list()) if (draft.state === 'settling' && (draft.due <= now || draft.session_id === finalSession)) {
        draft.state = 'ready'; this.save(draft);
      }
    });
  }
  edit(context, id, revision, title, description, { evidenceIds, duplicates, evidenceLabel } = {}) {
    this.authorize(context);
    return this.transaction(() => {
      const draft = this.get(id);
      if (!editable.has(draft.state) || draft.revision !== revision) throw new Error('Draft changed or publication has started; reopen the current draft');
      draft.title = text(title, 'title', 200); draft.description = text(description, 'description', 3500);
      if (evidenceIds !== undefined) {
        const source = { ...this.session(draft.session_id).segments, ...Object.fromEntries(draft.evidence.map(s => [s.id, s])) };
        if (!Array.isArray(evidenceIds) || !evidenceIds.length || evidenceIds.some(id => !source[id])) throw new Error('Select existing evidence IDs; original quotations cannot be rewritten');
        draft.excluded_evidence = [...new Set([...(draft.excluded_evidence || []), ...draft.evidence.filter(s => !evidenceIds.includes(s.id)).map(s => s.id)])].filter(id => !evidenceIds.includes(id));
        draft.evidence = [...new Set(evidenceIds)].map(id => source[id]);
      }
      if (duplicates !== undefined) {
        if (!Array.isArray(duplicates) || duplicates.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error('Duplicate issue numbers must be positive integers');
        draft.duplicates = [...new Set(duplicates)];
        if (draft.duplicates.length && !draft.duplicates_label) draft.duplicates_label = 'GitHub';
      }
      if (evidenceLabel !== undefined) draft.evidence_label = text(evidenceLabel, 'evidence heading', 80);
      draft.body = text(body(draft), 'issue body', 60_000); draft.revision++; draft.approval = null; draft.human_edited = true;
      draft.state = 'ready'; this.save(draft);
      this.event(id, 'edited', context.user, { revision: draft.revision, title: draft.title, description: draft.description, evidence: draft.evidence.map(s => s.id), duplicates: draft.duplicates });
      return draft;
    });
  }
  note(context, id, note) {
    this.authorize(context); this.get(id);
    this.event(id, 'comment', context.user, text(note, 'comment', 2000));
    const draft = this.get(id); draft.announced = null; this.save(draft);
  }
  reject(context, id) {
    this.authorize(context);
    return this.transaction(() => {
      const draft = this.get(id);
      if (!editable.has(draft.state)) throw new Error('Publication started or draft is already closed');
      draft.state = 'rejected'; draft.approval = null; draft.revision++; this.save(draft);
      this.event(id, 'rejected', context.user, null);
      return draft;
    });
  }
  merge(context, keepId, removeId) {
    this.authorize(context);
    return this.transaction(() => {
      const keep = this.get(keepId), remove = this.get(removeId);
      if (keepId === removeId || [keep, remove].some(d => !['ready', 'settling', 'approved'].includes(d.state)) || ['repo', 'language', 'mode'].some(key => keep[key] !== remove[key])) throw new Error('Choose two unpublished drafts for the same repository, language, and publish mode');
      keep.description = text(`${keep.description}\n\n---\n\n${remove.description}`, 'combined description (shorten it with Edit first)', 3500);
      keep.evidence = [...new Map([...keep.evidence, ...remove.evidence].map(s => [s.id, s])).values()];
      keep.excluded_evidence = [...new Set([...(keep.excluded_evidence || []), ...(remove.excluded_evidence || [])])].filter(id => !keep.evidence.some(s => s.id === id));
      keep.duplicates = [...new Set([...keep.duplicates, ...remove.duplicates])];
      if (!keep.duplicates_label) keep.duplicates_label = remove.duplicates_label;
      keep.body = text(body(keep), 'issue body', 60_000); keep.revision++; keep.approval = null; keep.human_edited = true; keep.state = 'ready';
      remove.state = 'merged'; remove.merged_into = keepId; remove.approval = null; remove.revision++;
      this.save(keep); this.save(remove);
      this.event(keepId, 'merged', context.user, { from: removeId, revision: keep.revision });
      this.event(removeId, 'merged into', context.user, keepId);
      return keep;
    });
  }
  approve(context, id, revision, expectedHash) {
    this.authorize(context, true);
    return this.transaction(() => {
      const draft = this.get(id);
      if (draft.revision !== revision || digest(draft) !== expectedHash) throw new Error('That preview is stale; reopen the draft and approve the current content');
      if (['approved', 'publishing', 'uncertain', 'published'].includes(draft.state)) return draft;
      if (draft.state !== 'ready') throw new Error('Only a settled, unrejected draft can be approved');
      draft.approval = { user: context.user, revision, hash: expectedHash, at: new Date().toISOString() };
      draft.state = 'approved'; this.save(draft);
      this.event(id, 'approved', context.user, draft.approval);
      return draft;
    });
  }
  async publish(id, github) {
    const claim = this.transaction(() => {
      const draft = this.get(id);
      if (draft.mode !== 'github' || github.repo !== draft.repo || github.mode !== draft.mode) throw new Error('Publisher does not match the reviewed destination');
      if (!draft.approval || draft.approval.hash !== digest(draft) || draft.approval.revision !== draft.revision) throw new Error('Explicit approval of this exact content is required');
      if (draft.state === 'published') return { draft, action: 'done' };
      if (['publishing', 'uncertain'].includes(draft.state)) return { draft, action: 'reconcile' };
      if (draft.state !== 'approved') throw new Error('Draft is not approved');
      // Commit the one permitted POST attempt before making the network request.
      draft.state = 'publishing'; this.save(draft);
      this.event(id, 'publication attempt', 'vera', { hash: digest(draft) });
      return { draft, action: 'create' };
    });
    if (claim.action === 'done') return claim.draft.url;
    try {
      let issue;
      if (claim.action === 'create') issue = await github.create(publication(claim.draft));
      else {
        const matches = (await github.list()).filter(issue => issue.body?.includes(marker(claim.draft)));
        if (matches.length !== 1) throw new Error('Publication is uncertain. No further create attempt will be made; reconcile after checking GitHub.');
        issue = matches[0];
      }
      if (issue.title !== claim.draft.title || issue.body !== publication(claim.draft).body || typeof issue.html_url !== 'string' || !issue.html_url.startsWith(`https://github.com/${github.repo}/issues/`)) throw new Error('GitHub response does not match the approved issue');
      this.transaction(() => {
        const draft = this.get(id); draft.state = 'published'; draft.url = issue.html_url; this.save(draft);
        this.event(id, 'published', 'vera', draft.url);
      });
      return issue.html_url;
    } catch (error) {
      this.transaction(() => { const draft = this.get(id); if (draft.state !== 'published') { draft.state = 'uncertain'; this.save(draft); } });
      throw error;
    }
  }
}


export class GitHub {
  constructor(repo, token, fetcher = fetch) { this.repo = repo; this.token = token; this.fetcher = fetcher; this.mode = 'github'; }
  async request(suffix, payload) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(this.repo) || !this.token) throw new Error('Configure GITHUB_REPO and a repository-scoped GITHUB_TOKEN');
    const response = await this.fetcher(`https://api.github.com/repos/${this.repo}/issues${suffix}`, {
      method: payload ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    return response.json();
  }
  async list() {
    const issues = [];
    for (let page = 1; ; page++) {
      const rows = await this.request(`?state=all&per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw new Error('Invalid GitHub issue list');
      issues.push(...rows.filter(row => !row.pull_request));
      if (rows.length < 100) return issues;
    }
  }
  async create(payload) { return this.request('', payload); }
}
