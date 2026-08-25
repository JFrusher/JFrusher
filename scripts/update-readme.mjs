/**
 * Rewrites the two marker-delimited blocks in README.md from the GitHub REST API.
 *
 *   <!-- NOW:START -->       the three repositories pushed to most recently
 *   <!-- ACTIVITY:START -->  the five most recent public events
 *
 * Three rules this script exists to hold to:
 *
 *   1. Dates are absolute. A relative date ("2 days ago") changes every night, so the file
 *      would differ on every run and the workflow would commit every night whether or not
 *      anything happened - filling the contribution heatmap on the same page with bot noise.
 *   2. Every request happens before the first write. A failed fetch exits non-zero with
 *      README.md untouched, which leaves yesterday's correct content in place.
 *   3. No dependencies, and no package.json to declare them in. Node 18+ only.
 *
 * On the events endpoint: GitHub strips event payloads. A PushEvent arrives carrying only
 * the head SHA - no commit list, no commit count - and a PullRequestEvent's nested PR object
 * has no title or html_url. So nothing here reads a subject straight out of an event. The
 * list is filtered and collapsed first, and only the handful of events that survive are
 * enriched with a second request each.
 *
 * Run: node scripts/update-readme.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';

const USER = 'JFrusher';
const README = new URL('../README.md', import.meta.url);
const NOW_COUNT = 3;
const ACTIVITY_COUNT = 5;
const SUBJECT_MAX = 70;

/** Repositories that should never appear in the lists: this one, and org meta repos. */
const SKIPPED = new Set([USER.toLowerCase(), '.github']);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * One GET against the API.
 *
 * @param {string} path
 * @returns {Promise<unknown>}
 */
async function api(path) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': `${USER}-profile-readme`
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) {
    throw new Error(`GET ${path} -> ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/**
 * A list endpoint. An unexpected shape means the output would be wrong rather than merely
 * stale, so it throws.
 *
 * @param {string} path
 * @returns {Promise<object[]>}
 */
async function apiList(path) {
  const body = await api(path);
  if (!Array.isArray(body)) {
    throw new Error(`GET ${path} -> expected an array, got ${typeof body}`);
  }
  return body;
}

/**
 * An optional detail lookup - a commit subject, a pull request title. These enrich a line
 * that is already correct without them, so a failure degrades the line rather than the run:
 * a force-pushed-away SHA should not take the whole page down. It is logged, not swallowed.
 *
 * @param {string} path
 * @returns {Promise<object | null>}
 */
async function apiDetail(path) {
  try {
    const body = await api(path);
    return body && typeof body === 'object' ? body : null;
  } catch (error) {
    console.warn(`update-readme: detail lookup failed, continuing without it - ${error.message}`);
    return null;
  }
}

/**
 * `25 Aug 2026`, in UTC so the output does not depend on where the runner is.
 *
 * @param {string} iso
 * @returns {string}
 */
function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`unparseable date: ${iso}`);
  }
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** The calendar day an event landed on, for grouping. @param {string} iso */
function dayKey(iso) {
  return iso.slice(0, 10);
}

/**
 * A commit subject is arbitrary text going into a markdown table cell. Take the first line,
 * neutralise the characters that would otherwise break the table or turn into formatting,
 * and trim to length on a word boundary.
 *
 * @param {string} [message]
 * @returns {string}
 */
function cell(message) {
  let subject = String(message ?? '')
    .split('\n')[0]
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_[\]<>|]/g, '\\$&');

  if (subject.length > SUBJECT_MAX) {
    const cut = subject.slice(0, SUBJECT_MAX);
    const lastSpace = cut.lastIndexOf(' ');
    subject = `${(lastSpace > SUBJECT_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
  }
  return subject;
}

/**
 * The three repositories pushed to most recently, with the subject of the head commit on
 * each. Forks, archived repositories and this repository itself are left out - the nightly
 * workflow pushes here, so including it would pin this repo to the top of its own list.
 *
 * @returns {Promise<string>}
 */
async function buildNow() {
  const header = ['| Repository | Last push | Latest commit |', '| --- | --- | --- |'];

  const repos = (await apiList(`/users/${USER}/repos?sort=pushed&per_page=100&type=owner`))
    .filter((repo) => !repo.fork && !repo.archived && !SKIPPED.has(repo.name.toLowerCase()))
    .slice(0, NOW_COUNT);

  if (repos.length === 0) {
    return [...header, '| _nothing public_ | | |'].join('\n');
  }

  const rows = await Promise.all(
    repos.map(async (repo) => {
      const [commit] = await apiList(`/repos/${repo.full_name}/commits?per_page=1`);
      const subject = cell(commit?.commit?.message) || '_no commits_';
      return `| [${repo.name}](${repo.html_url}) | ${formatDate(repo.pushed_at)} | ${subject} |`;
    })
  );

  return [...header, ...rows].join('\n');
}

/**
 * Reduce the raw event feed to the lines worth showing, newest first.
 *
 * Pushes to the same repository on the same day collapse into one entry keyed on the newest
 * head SHA, so an afternoon of five pushes to one repo is one line rather than five. Branch
 * and tag creations are dropped as noise; a new repository is worth a line. Stars, forks and
 * issue activity are not this page's business.
 *
 * @param {object[]} events
 * @returns {Array<{ date: string, repo: string, name: string, type: string, payload: object }>}
 */
function selectEvents(events) {
  const selected = [];
  const seenPushes = new Set();
  const seenPulls = new Set();

  for (const event of events) {
    const repo = event.repo?.name ?? '';
    const name = repo.split('/')[1] ?? repo;
    if (!name || SKIPPED.has(name.toLowerCase())) continue;

    const entry = { date: formatDate(event.created_at), repo, name, type: event.type, payload: event.payload ?? {} };

    switch (event.type) {
      case 'PushEvent': {
        if (!entry.payload.head) continue;
        const key = `${repo}@${dayKey(event.created_at)}`;
        if (seenPushes.has(key)) continue;
        seenPushes.add(key);
        break;
      }
      case 'PullRequestEvent': {
        const action = entry.payload.action;
        if (!['opened', 'merged', 'reopened', 'closed'].includes(action)) continue;
        const number = entry.payload.number ?? entry.payload.pull_request?.number;
        if (!number) continue;
        // The feed is newest first, so the first event seen for a pull request is its
        // latest state: keep "merged" and drop the "opened" further down the list.
        const key = `${repo}#${number}`;
        if (seenPulls.has(key)) continue;
        seenPulls.add(key);
        break;
      }
      case 'ReleaseEvent': {
        if (entry.payload.action !== 'published' || !entry.payload.release?.tag_name) continue;
        break;
      }
      case 'CreateEvent': {
        if (entry.payload.ref_type !== 'repository') continue;
        break;
      }
      default:
        continue;
    }

    selected.push(entry);
    if (selected.length === ACTIVITY_COUNT) break;
  }

  return selected;
}

/**
 * Turn one selected event into its markdown line, fetching the one detail the stripped
 * payload does not carry.
 *
 * @param {{ date: string, repo: string, name: string, type: string, payload: object }} entry
 * @returns {Promise<string>}
 */
async function renderEvent({ date, repo, name, type, payload }) {
  const link = `[${name}](https://github.com/${repo})`;

  switch (type) {
    case 'PushEvent': {
      const commit = await apiDetail(`/repos/${repo}/commits/${payload.head}`);
      const subject = cell(commit?.commit?.message);
      return `- **${date}** - pushed to ${link}${subject ? ` - ${subject}` : ''}`;
    }
    case 'PullRequestEvent': {
      const number = payload.number ?? payload.pull_request.number;
      const action = payload.action === 'closed' && payload.pull_request?.merged ? 'merged' : payload.action;
      const pull = await apiDetail(`/repos/${repo}/pulls/${number}`);
      const title = cell(pull?.title);
      const url = `https://github.com/${repo}/pull/${number}`;
      return `- **${date}** - ${action} [${name}#${number}](${url})${title ? ` - ${title}` : ''}`;
    }
    case 'ReleaseEvent': {
      const tag = payload.release.tag_name;
      const url = payload.release.html_url ?? `https://github.com/${repo}/releases/tag/${tag}`;
      return `- **${date}** - released [${name} ${cell(tag)}](${url})`;
    }
    case 'CreateEvent':
      return `- **${date}** - started ${link}`;
    default:
      throw new Error(`unhandled event type reached rendering: ${type}`);
  }
}

/**
 * @returns {Promise<string>}
 */
async function buildActivity() {
  const selected = selectEvents(await apiList(`/users/${USER}/events/public?per_page=100`));

  if (selected.length === 0) {
    return '- _Nothing public in the last 90 days._';
  }

  const lines = await Promise.all(selected.map(renderEvent));
  return lines.join('\n');
}

/**
 * @param {string} text
 * @param {string} name marker name, e.g. `NOW`
 * @param {string} body replacement content, without the markers
 * @returns {string}
 */
function replaceBlock(text, name, body) {
  const markers = new RegExp(`(<!-- ${name}:START -->)[\\s\\S]*?(<!-- ${name}:END -->)`);
  if (!markers.test(text)) {
    throw new Error(`marker block ${name} not found in README.md`);
  }
  return text.replace(markers, `$1\n${body}\n$2`);
}

async function main() {
  // Everything is fetched before anything is written: a failure here leaves the file alone.
  const [now, activity] = await Promise.all([buildNow(), buildActivity()]);

  const before = readFileSync(README, 'utf8');
  const after = replaceBlock(replaceBlock(before, 'NOW', now), 'ACTIVITY', activity);

  if (after === before) {
    console.log('README.md unchanged.');
    return;
  }

  writeFileSync(README, after);
  console.log('README.md updated.');
}

main().catch((error) => {
  console.error(`update-readme: ${error.message}`);
  // Set the code and let Node unwind rather than calling process.exit(): tearing the
  // process down with requests still in flight trips a libuv assertion on Windows, which
  // turns a clean "the API said no" into a crash with a misleading exit code.
  process.exitCode = 1;
});
