#!/usr/bin/env node
/**
 * One-way sync: one Jira project -> Multica issues.
 *
 * - Dry run by default. Pass --apply to write to Multica.
 * - Jira is only read. Multica issues are created or updated.
 * - Jira key -> Multica issue id mapping is kept in a local state file
 *   (outside the repo by default). The Jira key is also prefixed in the title.
 * - Fields synced: title, description, status, priority, due date.
 *   Edits made in Multica to these fields are overwritten on the next change in Jira.
 * - Variables are read from the environment, and from a ".env" file in the
 *   current directory if one exists (needs Node 20.12+; real env vars win).
 *
 * Required env:
 *   JIRA_BASE_URL        e.g. https://your-site.atlassian.net
 *   JIRA_EMAIL           Atlassian account email
 *   JIRA_API_TOKEN       Atlassian API token (read-only account recommended)
 *   JIRA_PROJECT_KEY     Jira project key to sync, e.g. ABC
 *                        (not needed when JIRA_JQL is set)
 *   MULTICA_API_URL      e.g. https://api.multica.ai
 *   MULTICA_TOKEN        Multica personal access token (mul_...)
 *   MULTICA_WORKSPACE_SLUG  Multica workspace slug (the <slug> in multica.ai/<slug>)
 *                        or MULTICA_WORKSPACE_ID (workspace UUID). If both are set, the UUID is used.
 *
 * Optional env:
 *   MULTICA_PROJECT_ID   Multica project id. When set, synced issues are put in this project.
 *   JIRA_JQL             Custom JQL. Overrides JIRA_PROJECT_KEY.
 *                        Default: project = "<JIRA_PROJECT_KEY>" ORDER BY created ASC
 *   STATUS_MAP           JSON, e.g. {"In Review":"in_review","Won't Do":"cancelled"}
 *                        Keys are Jira status names. Overrides the category default.
 *   MULTICA_SYNC_STATE   state file path.
 *                        Default: ~/.multica-sync/state-<workspace slug or id>.json
 *
 * Usage:
 *   node sync-jira-to-multica.mjs              # dry run
 *   node sync-jira-to-multica.mjs --apply      # write
 *   node sync-jira-to-multica.mjs --apply --limit 5
 *   node sync-jira-to-multica.mjs --apply --sprint-labels
 *   node sync-jira-to-multica.mjs --apply --comments
 *   node sync-jira-to-multica.mjs --apply --issue ABC-12
 *   node sync-jira-to-multica.mjs --apply --issue ABC-12,ABC-15
 *
 * --issue KEY[,KEY...]: sync only these Jira issues (repeatable). It replaces
 *   JIRA_PROJECT_KEY and JIRA_JQL for that run. Other issues are not touched.
 *
 * --comments: copy new Jira comments to the Multica issue, oldest first.
 *   Multica sets the author (the token owner) and the time (now), so each comment
 *   starts with "/note [Jira author, date]". The "/note" prefix stops Multica
 *   from starting an agent run for the comment. Jira comment ids are stored in the
 *   state file, so only new comments are added. Edits and deletions in Jira are
 *   not synced. The Jira author name is written into the Multica comment.
 * --refresh-comments: also rewrite comments that were already pushed, using the
 *   current conversion (for example after a converter fix). It implies --comments.
 *   Comments pushed before Multica comment ids were stored are paired by push order
 *   and are only rewritten when their "[author, date]" header matches.
 *
 * --sprint-labels: label each issue in Multica with its Jira sprint name
 *   ("Backlog" when it has no sprint). An active sprint wins, then a future one,
 *   then the latest one. Label names are cut to 32 characters. Labels are created
 *   in the workspace when missing. Turning the flag off later does not remove labels.
 *   Needs a Jira site that uses sprints (Scrum board).
 *
 * --attachments: upload every file attached to the Jira issue (images, PDFs, archives...)
 *   to the Multica issue. Files are downloaded from Jira and uploaded to Multica
 *   (limit 100 MiB per file, bigger files are skipped). Uploaded Jira attachment ids are
 *   stored in the state file, so each file is uploaded once. Images and files shown in
 *   the description or in comments are linked when their name in Jira matches the
 *   attachment file name. Others show as "[attachment: name]". Run with --refresh-comments
 *   as well to fix comments that were pushed earlier.
 *   The files are stored in Multica, so make sure that is allowed for your data.
 *
 * Never commit tokens or the state file.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const limitIndex = args.indexOf('--limit');
const LIMIT = limitIndex >= 0 ? Number(args[limitIndex + 1]) : Infinity;
if (Number.isNaN(LIMIT) || LIMIT < 1) {
  throw new Error('--limit must be a positive number');
}
const SPRINT_LABELS = args.includes('--sprint-labels');
const REFRESH_COMMENTS = args.includes('--refresh-comments');
const COMMENTS = args.includes('--comments') || REFRESH_COMMENTS;
const ATTACHMENTS = args.includes('--attachments');

// --issue KEY[,KEY...] (repeatable): sync only these Jira issues. Overrides JIRA_PROJECT_KEY and JIRA_JQL.
const ISSUE_KEYS = args
  .flatMap((arg, index) => (args[index - 1] === '--issue' ? arg.split(',') : []))
  .map((key) => key.trim().toUpperCase())
  .filter(Boolean);
if (args.includes('--issue') && ISSUE_KEYS.length === 0) {
  throw new Error('--issue needs at least one issue key, e.g. --issue ABC-12');
}
for (const key of ISSUE_KEYS) {
  // Keep the JQL safe: accept only the PROJECT-123 shape.
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) {
    throw new Error(`Invalid issue key for --issue: ${key}`);
  }
}

// Load ".env" from the current directory when present. Existing env vars are not overridden.
try {
  process.loadEnvFile();
} catch (error) {
  // Ignore a missing file, or an older Node without loadEnvFile.
  if (error.code !== 'ENOENT' && error instanceof TypeError === false) {
    throw error;
  }
}

function buildDefaultJql(projectKey) {
  if (!projectKey) {
    throw new Error('Set JIRA_PROJECT_KEY (or JIRA_JQL) to choose what to sync');
  }
  // Project keys are alphanumeric with underscores. Reject anything else to keep the JQL safe.
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(projectKey)) {
    throw new Error('JIRA_PROJECT_KEY must match [A-Za-z][A-Za-z0-9_]*');
  }
  return `project = "${projectKey}" ORDER BY created ASC`;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const jiraBase = requireEnv('JIRA_BASE_URL').replace(/\/+$/, '');
const jiraAuth = Buffer.from(
  `${requireEnv('JIRA_EMAIL')}:${requireEnv('JIRA_API_TOKEN')}`,
).toString('base64');
const multicaBase = requireEnv('MULTICA_API_URL').replace(/\/+$/, '');
const multicaToken = requireEnv('MULTICA_TOKEN');
// The workspace is selected by UUID (X-Workspace-ID) or by slug (X-Workspace-Slug).
// The slug is the part after the domain in the workspace URL, e.g. multica.ai/<slug>.
const workspaceId = process.env.MULTICA_WORKSPACE_ID || '';
const workspaceSlug = process.env.MULTICA_WORKSPACE_SLUG || '';
if (!workspaceId && !workspaceSlug) {
  throw new Error('Set MULTICA_WORKSPACE_SLUG or MULTICA_WORKSPACE_ID');
}
const multicaProjectId = process.env.MULTICA_PROJECT_ID || '';
const jql =
  ISSUE_KEYS.length > 0
    ? `key in (${ISSUE_KEYS.join(', ')}) ORDER BY created ASC`
    : process.env.JIRA_JQL || buildDefaultJql(process.env.JIRA_PROJECT_KEY);
const statePath =
  process.env.MULTICA_SYNC_STATE ||
  path.join(
    homedir(),
    '.multica-sync',
    `state-${(workspaceId || workspaceSlug).replace(/[^A-Za-z0-9_-]/g, '_')}.json`,
  );
const statusOverrides = process.env.STATUS_MAP
  ? JSON.parse(process.env.STATUS_MAP)
  : {};

// Jira status category key -> Multica status key.
// UNVERIFIED: "done" must exist in the workspace status catalog. Override with STATUS_MAP if not.
const CATEGORY_STATUS = { new: 'todo', indeterminate: 'in_progress', done: 'done' };
// Multica accepts: urgent, high, medium, low, none.
const PRIORITY_MAP = {
  Highest: 'urgent',
  High: 'high',
  Medium: 'medium',
  Low: 'low',
  Lowest: 'low',
};

async function http(url, options, label) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(url, options);
    if (response.status === 429 || response.status >= 500) {
      const wait = Number(response.headers.get('retry-after')) || attempt * 2;
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      continue;
    }
    if (!response.ok) {
      // Do not print the response body or headers: they may contain ticket content or tokens.
      throw new Error(`${label} failed with HTTP ${response.status}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  throw new Error(`${label} failed after retries`);
}

// Sprint support (only used with --sprint-labels).
let sprintFieldId = '';
const BACKLOG_NAME = 'Backlog';
const LABEL_NAME_MAX = 32;

// The Sprint field is a custom field, so its id differs per Jira site. Find it by type.
async function discoverSprintField() {
  const allFields = await http(
    `${jiraBase}/rest/api/3/field`,
    { headers: { Authorization: `Basic ${jiraAuth}`, Accept: 'application/json' } },
    'Jira field list',
  );
  const sprintField = allFields.find(
    (field) => field.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint',
  );
  if (!sprintField) {
    throw new Error('No Sprint field found in Jira. Does this site use sprints?');
  }
  return sprintField.id;
}

function pickSprintName(issue) {
  const value = issue.fields[sprintFieldId];
  const sprints = Array.isArray(value) ? value : [];
  const chosen =
    sprints.find((sprint) => sprint.state === 'active') ||
    sprints.find((sprint) => sprint.state === 'future') ||
    sprints[sprints.length - 1];
  // Label names must be trimmed, free of control characters, and at most 32 characters.
  const name = (chosen?.name || BACKLOG_NAME)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, LABEL_NAME_MAX);
  return name || BACKLOG_NAME;
}

async function* searchJira() {
  let nextPageToken;
  do {
    const body = {
      jql,
      maxResults: 100,
      fields: [
        'summary',
        'description',
        'status',
        'priority',
        'duedate',
        ...(ATTACHMENTS ? ['attachment'] : []),
        ...(sprintFieldId ? [sprintFieldId] : []),
      ],
      ...(nextPageToken ? { nextPageToken } : {}),
    };
    const data = await http(
      `${jiraBase}/rest/api/3/search/jql`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${jiraAuth}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      },
      'Jira search',
    );
    yield* data.issues;
    nextPageToken = data.nextPageToken;
  } while (nextPageToken);
}

// Attachments already uploaded to Multica for the current issue, by file name.
// Filled by setMediaContext() so that adfToText() can link images and files.
let mediaIndex = new Map();

function setMediaContext(entry) {
  mediaIndex = new Map(
    Object.values(entry?.attachments || {}).map((attachment) => [
      attachment.filename,
      attachment,
    ]),
  );
}

// ADF "media" nodes: pasted images carry the file name in attrs.alt.
// Files in a media group often carry no name, so they can only show as a placeholder.
function renderMedia(node) {
  const alt = (node.attrs?.alt || '').replace(/[[\]\r\n]/g, ' ').trim();
  if (node.attrs?.type === 'external' && node.attrs.url) {
    return `![${alt}](${node.attrs.url})`;
  }
  const found = alt ? mediaIndex.get(alt) : undefined;
  if (!found) return `[attachment: ${alt || 'file'}]`;
  if ((found.contentType || '').startsWith('image/')) {
    return `![${alt}](${found.markdownUrl || found.url})`;
  }
  return `[${found.filename}](${found.downloadUrl || found.url})`;
}

// Minimal Atlassian Document Format -> plain text.
function adfToText(node) {
  if (!node) return '';
  if (node.type === 'text') {
    // A link in ADF is a "link" mark on a text node. Keep the URL as a Markdown link.
    const link = (node.marks || []).find((mark) => mark.type === 'link');
    const text = node.text || '';
    const href = link?.attrs?.href;
    return href && href !== text ? `[${text}](${href})` : text;
  }
  if (node.type === 'hardBreak') return '\n';
  const inner = (node.content || []).map(adfToText).join('');
  switch (node.type) {
    case 'paragraph':
    case 'heading':
    case 'codeBlock':
      return `${inner}\n\n`;
    // Smart links (a pasted URL shown as a card) carry the URL in attrs.url.
    case 'inlineCard':
      return node.attrs?.url || '';
    case 'blockCard':
    case 'embedCard':
      return node.attrs?.url ? `${node.attrs.url}\n\n` : '';
    case 'media':
      return renderMedia(node);
    case 'mediaSingle':
      return `${inner}\n\n`;
    case 'mediaGroup':
      return `${inner}\n`;
    case 'mention':
      return node.attrs?.text || '';
    case 'listItem':
      return `- ${inner.trim()}\n`;
    case 'bulletList':
    case 'orderedList':
      return `${inner}\n`;
    default:
      return inner;
  }
}

function toMulticaPayload(issue) {
  const { fields } = issue;
  const statusName = fields.status?.name;
  const category = fields.status?.statusCategory?.key;
  const description = [
    `Jira: ${jiraBase}/browse/${issue.key}`,
    '',
    adfToText(fields.description).trim(),
  ]
    .join('\n')
    .trim();
  return {
    title: `[${issue.key}] ${fields.summary}`,
    description,
    status: statusOverrides[statusName] || CATEGORY_STATUS[category] || 'todo',
    priority: PRIORITY_MAP[fields.priority?.name] || 'none',
    due_date: fields.duedate || '',
    ...(multicaProjectId ? { project_id: multicaProjectId } : {}),
  };
}

const multicaHeaders = {
  Authorization: `Bearer ${multicaToken}`,
  ...(workspaceId
    ? { 'X-Workspace-ID': workspaceId }
    : { 'X-Workspace-Slug': workspaceSlug }),
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

async function createIssue(payload) {
  return http(
    `${multicaBase}/api/issues`,
    { method: 'POST', headers: multicaHeaders, body: JSON.stringify(payload) },
    'Multica create issue',
  );
}

async function updateIssue(id, payload) {
  return http(
    `${multicaBase}/api/issues/${encodeURIComponent(id)}`,
    { method: 'PUT', headers: multicaHeaders, body: JSON.stringify(payload) },
    'Multica update issue',
  );
}

const labelIdsByName = new Map();
let labelsLoaded = false;

async function loadLabels() {
  const data = await http(
    `${multicaBase}/api/labels?resource_type=issue`,
    { headers: multicaHeaders },
    'Multica list labels',
  );
  labelIdsByName.clear();
  for (const label of data?.labels || []) {
    labelIdsByName.set(label.name, label.id);
  }
  labelsLoaded = true;
}

// Deterministic color per name, so reruns do not depend on creation order.
function labelColor(name) {
  return `#${createHash('sha256').update(name).digest('hex').slice(0, 6)}`;
}

// Returns the label id and creates the label when it is missing.
// On a dry run a missing label is not created and '' is returned.
async function ensureLabel(name) {
  if (!labelsLoaded) await loadLabels();
  if (labelIdsByName.has(name)) return labelIdsByName.get(name);
  if (!APPLY) return '';
  try {
    const created = await http(
      `${multicaBase}/api/labels`,
      {
        method: 'POST',
        headers: multicaHeaders,
        body: JSON.stringify({
          name,
          color: labelColor(name),
          resource_type: 'issue',
        }),
      },
      'Multica create label',
    );
    labelIdsByName.set(name, created.id);
  } catch (error) {
    // A 409 means the name exists already. Reload and look again before giving up.
    await loadLabels();
    if (!labelIdsByName.has(name)) throw error;
  }
  return labelIdsByName.get(name);
}

async function attachLabel(issueId, labelId) {
  return http(
    `${multicaBase}/api/issues/${encodeURIComponent(issueId)}/labels`,
    {
      method: 'POST',
      headers: multicaHeaders,
      body: JSON.stringify({ label_id: labelId }),
    },
    'Multica attach label',
  );
}

async function detachLabel(issueId, labelId) {
  return http(
    `${multicaBase}/api/issues/${encodeURIComponent(issueId)}/labels/${encodeURIComponent(labelId)}`,
    { method: 'DELETE', headers: multicaHeaders },
    'Multica detach label',
  );
}

// Comment support (only used with --comments).
// Multica documents a 64 KB comment limit. Cut at 20000 characters to stay below it
// even with 3-byte characters.
const COMMENT_MAX_CHARS = 20000;

async function fetchJiraComments(issueKey) {
  const all = [];
  let startAt = 0;
  for (;;) {
    const data = await http(
      `${jiraBase}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?orderBy=created&maxResults=100&startAt=${startAt}`,
      { headers: { Authorization: `Basic ${jiraAuth}`, Accept: 'application/json' } },
      'Jira comments',
    );
    const page = data.comments || [];
    all.push(...page);
    startAt += page.length;
    if (page.length === 0 || startAt >= data.total) break;
  }
  return all;
}

function formatComment(comment) {
  const author = (comment.author?.displayName || 'Unknown').replace(/[\r\n\]]/g, ' ');
  const date = (comment.created || '').slice(0, 10);
  const body = adfToText(comment.body).trim() || '(no text content)';
  // "/note" first: Multica stores the comment but never triggers an agent for it.
  return `/note [${author}, ${date}]\n${body}`.slice(0, COMMENT_MAX_CHARS);
}

async function createComment(issueId, content) {
  return http(
    `${multicaBase}/api/issues/${encodeURIComponent(issueId)}/comments`,
    { method: 'POST', headers: multicaHeaders, body: JSON.stringify({ content }) },
    'Multica create comment',
  );
}

async function listMulticaComments(issueId) {
  const data = await http(
    `${multicaBase}/api/issues/${encodeURIComponent(issueId)}/comments`,
    { headers: multicaHeaders },
    'Multica list comments',
  );
  return Array.isArray(data) ? data : [];
}

async function updateComment(commentId, content) {
  return http(
    `${multicaBase}/api/comments/${encodeURIComponent(commentId)}`,
    { method: 'PUT', headers: multicaHeaders, body: JSON.stringify({ content }) },
    'Multica update comment',
  );
}

// Rewrites comments that were pushed before. Returns how many differ from the current conversion.
async function refreshComments(issueKey, entry, jiraComments, state) {
  const ids = { ...(entry.commentIds || {}) };
  const multicaComments = await listMulticaComments(entry.multicaId);
  const byId = new Map(multicaComments.map((comment) => [comment.id, comment]));
  // Entries from older runs stored only Jira ids. Pair them by push order with the
  // comments that start with "/note [", and trust the pairing only when the header matches.
  const scripted = multicaComments
    .filter((c) => typeof c.content === 'string' && c.content.startsWith('/note ['))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const jiraById = new Map(jiraComments.map((comment) => [comment.id, comment]));
  let changed = 0;

  for (const [index, jiraId] of (entry.comments || []).entries()) {
    const jira = jiraById.get(jiraId);
    if (!jira) continue; // Deleted in Jira. Left as is in Multica.
    const expected = formatComment(jira);
    const target = ids[jiraId] ? byId.get(ids[jiraId]) : scripted[index];
    if (!target) continue;
    if (!ids[jiraId] && !target.content.startsWith(expected.split('\n')[0])) {
      console.warn(`skip    ${issueKey}: comment ${jiraId} does not match, left as is`);
      continue;
    }
    ids[jiraId] = target.id;
    if (target.content === expected) continue;
    changed += 1;
    if (APPLY) await updateComment(target.id, expected);
  }

  if (APPLY) {
    entry.commentIds = ids;
    await saveState(state);
  }
  return changed;
}

// Adds Jira comments that were not pushed before, and optionally refreshes the old ones.
// Returns how many comments were added or rewritten (or would be, on a dry run).
async function syncComments(issueKey, state) {
  const entry = state.issues[issueKey];
  const jiraComments = await fetchJiraComments(issueKey);
  let touched = 0;

  if (REFRESH_COMMENTS && entry) {
    const refreshed = await refreshComments(issueKey, entry, jiraComments, state);
    if (refreshed > 0) console.log(`refresh ${issueKey}  ~${refreshed}`);
    touched += refreshed;
  }

  const pushed = new Set(entry?.comments || []);
  const fresh = jiraComments.filter((comment) => !pushed.has(comment.id));
  if (fresh.length > 0) console.log(`comment ${issueKey}  +${fresh.length}`);
  if (!APPLY || !entry) return touched + fresh.length;

  for (const comment of fresh) {
    const created = await createComment(entry.multicaId, formatComment(comment));
    entry.comments = [...(entry.comments || []), comment.id];
    entry.commentIds = { ...(entry.commentIds || {}), [comment.id]: created?.id };
    await saveState(state);
  }
  return touched + fresh.length;
}

// Attachment support (only used with --attachments).
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // Multica rejects files above 100 MiB.

async function downloadJiraAttachment(attachment) {
  // Never send the Jira credentials to another host.
  if (!String(attachment.content || '').startsWith(`${jiraBase}/`)) {
    throw new Error('Attachment URL is not on the Jira site');
  }
  // Jira answers with a redirect to its media host. fetch drops the Authorization header
  // when a redirect goes to another origin, so the credentials stay on the Jira site.
  const response = await fetch(attachment.content, {
    headers: { Authorization: `Basic ${jiraAuth}` },
  });
  if (!response.ok) {
    throw new Error(`Jira attachment download failed with HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function uploadAttachment(issueId, attachment, buffer) {
  const form = new FormData();
  form.append('issue_id', issueId);
  form.append(
    'file',
    new Blob([buffer], { type: attachment.mimeType || 'application/octet-stream' }),
    attachment.filename,
  );
  // Let fetch set the multipart Content-Type with its boundary.
  const headers = { ...multicaHeaders };
  delete headers['Content-Type'];
  return http(
    `${multicaBase}/api/upload-file`,
    { method: 'POST', headers, body: form },
    'Multica upload file',
  );
}

// Uploads Jira attachments that were not uploaded before. Returns how many were uploaded
// (or would be, on a dry run).
async function syncAttachments(issue, state) {
  const entry = state.issues[issue.key];
  const done = entry?.attachments || {};
  const fresh = (issue.fields.attachment || []).filter(
    (attachment) => !done[attachment.id],
  );
  if (fresh.length === 0) return 0;
  const totalMb = (
    fresh.reduce((sum, attachment) => sum + (attachment.size || 0), 0) / 1048576
  ).toFixed(1);
  console.log(`attach  ${issue.key}  +${fresh.length} (${totalMb} MB)`);
  if (!APPLY || !entry) return fresh.length;

  let uploaded = 0;
  for (const attachment of fresh) {
    if ((attachment.size || 0) > MAX_UPLOAD_BYTES) {
      console.warn(`skip    ${issue.key}: ${attachment.filename} is larger than 100 MiB`);
      continue;
    }
    try {
      const buffer = await downloadJiraAttachment(attachment);
      const result = await uploadAttachment(entry.multicaId, attachment, buffer);
      if (!result?.id) throw new Error('Multica returned no attachment id');
      entry.attachments = {
        ...(entry.attachments || {}),
        [attachment.id]: {
          multicaId: result.id,
          filename: attachment.filename,
          contentType: attachment.mimeType || '',
          url: result.url || '',
          downloadUrl: result.download_url || '',
          markdownUrl: result.markdown_url || '',
        },
      };
      await saveState(state);
      uploaded += 1;
    } catch (error) {
      // Keep going: the file is retried on the next run because it is not in the state file.
      console.error(`failed  ${issue.key}: attachment ${attachment.filename}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  return uploaded;
}

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { issues: {} };
    throw error;
  }
}

async function saveState(state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

const hashOf = (payload) =>
  createHash('sha256').update(JSON.stringify(payload)).digest('hex');

async function main() {
  const state = await loadState();
  const counts = {
    created: 0,
    updated: 0,
    unchanged: 0,
    comments: 0,
    attachments: 0,
    failed: 0,
  };
  let seen = 0;

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} | JQL: ${jql}`);
  if (SPRINT_LABELS) {
    sprintFieldId = await discoverSprintField();
  }

  for await (const issue of searchJira()) {
    if (seen >= LIMIT) break;
    seen += 1;

    // Link files that were uploaded in earlier runs (empty when --attachments is off).
    setMediaContext(state.issues[issue.key]);
    const payload = toMulticaPayload(issue);
    const sprintName = SPRINT_LABELS ? pickSprintName(issue) : '';
    const hash = hashOf(SPRINT_LABELS ? { ...payload, sprint: sprintName } : payload);
    const known = state.issues[issue.key];
    const suffix = sprintName ? `  [${sprintName}]` : '';

    try {
      if (!known) {
        console.log(`create  ${issue.key}${suffix}`);
        if (APPLY) {
          const labelId = sprintName ? await ensureLabel(sprintName) : '';
          const created = await createIssue({
            ...payload,
            ...(labelId ? { label_ids: [labelId] } : {}),
          });
          state.issues[issue.key] = { multicaId: created.id, hash, labelId };
          await saveState(state);
        }
        counts.created += 1;
      } else if (known.hash !== hash) {
        console.log(`update  ${issue.key}${suffix}`);
        if (APPLY) {
          await updateIssue(known.multicaId, payload);
          let labelId = known.labelId || '';
          if (sprintName) {
            const wanted = await ensureLabel(sprintName);
            if (wanted !== labelId) {
              await attachLabel(known.multicaId, wanted);
              if (labelId) await detachLabel(known.multicaId, labelId);
              labelId = wanted;
            }
          }
          state.issues[issue.key] = { ...known, hash, labelId };
          await saveState(state);
        }
        counts.updated += 1;
      } else {
        counts.unchanged += 1;
      }

      if (ATTACHMENTS) {
        const uploaded = await syncAttachments(issue, state);
        counts.attachments += uploaded;
        // The description may link files that were uploaded just now. Rebuild it and
        // update the issue when it changed.
        const entry = state.issues[issue.key];
        if (APPLY && entry && uploaded > 0) {
          setMediaContext(entry);
          const finalPayload = toMulticaPayload(issue);
          const finalHash = hashOf(
            SPRINT_LABELS ? { ...finalPayload, sprint: sprintName } : finalPayload,
          );
          if (finalHash !== entry.hash) {
            await updateIssue(entry.multicaId, finalPayload);
            entry.hash = finalHash;
            await saveState(state);
          }
        }
      }

      if (COMMENTS) {
        // Comments may link files too, so use the latest uploaded set.
        setMediaContext(state.issues[issue.key]);
        counts.comments += await syncComments(issue.key, state);
      }
    } catch (error) {
      console.error(`failed  ${issue.key}: ${error.message}`);
      counts.failed += 1;
    }
  }

  console.log(JSON.stringify(counts));
  if (counts.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
