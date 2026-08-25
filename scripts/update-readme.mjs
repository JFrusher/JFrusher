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
 * One GET against the API. Throws on anything that is not a 2xx JSON array, because every
 * endpoint used here returns a list and a surprise shape means the output would be wrong
 * rather than merely stale.
 *
 * @param {string} path
 * @returns {Promise<object[]>}
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

  const body = await response.json();
  if (!Array.isArray(body)) {
    throw new Error(`GET ${path} -> expected an array, got ${typeof body}`);
  }
  return body;
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

/**
 * A commit subject is arbitrary text going into a markdown table cell. Take the first line,
 * neutralise the characters that would otherwise break the table or turn into formatting,
 * and trim to length on a word boundary.
 *
 * @param {string} message
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
  return subject || '_no message_';
}

/**
 * The three repositories pushed to most recently, with the subject of the head commit on
 * each. Forks, archived repositories and this repository itself are left out - the nightly
 * workflow pushes here, so including it would pin this repo to the top of its own list.
 *
 * @returns {Promise<string>}
 */
async function buildNow() {
  const repos = (await api(`/users/${USER}/repos?sort=pushed&per_page=100&type=owner`))
    .filter((repo) => !repo.fork && !repo.archived && !SKIPPED.has(repo.name.toLowerCase()))
    .slice(0, NOW_COUNT);

  if (repos.length === 0) {
    return '| Repository | Last push | Latest commit |\n| --- | --- | --- |\n| _nothing public_ | | |';
  }

  const rows = await Promise.all(
    repos.map(async (repo) => {
      const [commit] = await api(`/repos/${repo.full_name}/commits?per_page=1`);
      const subject = commit ? cell(commit.commit?.message) : '_no commits_';
      return `| [${repo.name}](${repo.html_url}) | ${formatDate(repo.pushed_at)} | ${subject} |`;
    })
  );

  return ['| Repository | Last push | Latest commit |', '| --- | --- | --- |', ...rows].join('\n');
}

/**
 * Turn one event into a line, or null for the event types this page does not care about.
 * Branch and tag creations are dropped; a new repository is worth a line.
 *
 * @param {object} event
 * @returns {{ date: string, repo: string, kind: string, text: string, commits: number } | null}
 */
function describeEvent(event) {
  const repo = event.repo?.name ?? '';
  const name = repo.split('/')[1] ?? repo;
  const url = `https://github.com/${repo}`;
  const link = `[${name}](${url})`;
  const date = formatDate(event.created_at);
  const base = { date, repo, kind: event.type, commits: 0 };

  switch (event.type) {
    case 'PushEvent': {
      const commits = Number(event.payload?.size) || event.payload?.commits?.length || 0;
      const head = event.payload?.commits?.at(-1)?.message;
      const subject = head ? ` - ${cell(head)}` : '';
      return { ...base, commits, text: `pushed to ${link}${subject}` };
    }
    case 'PullRequestEvent': {
      const pr = event.payload?.pull_request;
      if (!pr) return null;
      const action = event.payload.action === 'closed' && pr.merged ? 'merged' : event.payload.action;
      if (!['opened', 'merged', 'reopened'].includes(action)) return null;
      return {
        ...base,
        text: `${action} [${name}#${pr.number}](${pr.html_url}) - ${cell(pr.title)}`
      };
    }
    case 'ReleaseEvent': {
      const release = event.payload?.release;
      if (!release || event.payload.action !== 'published') return null;
      return {
        ...base,
        text: `released [${name} ${cell(release.tag_name)}](${release.html_url})`
      };
    }
    case 'CreateEvent': {
      if (event.payload?.ref_type !== 'repository') return null;
      return { ...base, text: `started ${link}` };
    }
    default:
      return null;
  }
}

/**
 * The five most recent public events. Consecutive pushes to the same repository on the same
 * day collapse into one line with a commit count, so a busy afternoon does not fill the
 * whole list with the same repository name.
 *
 * @returns {Promise<string>}
 */
async function buildActivity() {
  const events = await api(`/users/${USER}/events/public?per_page=100`);
  const lines = [];

  for (const event of events) {
    if (SKIPPED.has((event.repo?.name ?? '').split('/')[1]?.toLowerCase() ?? '')) continue;

    const described = describeEvent(event);
    if (!described) continue;

    const previous = lines.at(-1);
    const sameRun =
      previous?.kind === 'PushEvent' &&
      described.kind === 'PushEvent' &&
      previous.repo === described.repo &&
      previous.date === described.date;

    if (sameRun) {
      previous.commits += described.commits;
      continue;
    }

    lines.push(described);
    if (lines.length === ACTIVITY_COUNT) break;
  }

  if (lines.length === 0) {
    return '- _Nothing public in the last 90 days._';
  }

  return lines
    .map(({ date, text, kind, commits }) => {
      const count = kind === 'PushEvent' && commits > 1 ? ` (${commits} commits)` : '';
      return `- **${date}** - ${text}${count}`;
    })
    .join('\n');
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
  process.exit(1);
});
