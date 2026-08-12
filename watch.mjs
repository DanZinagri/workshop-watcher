#!/usr/bin/env node
// Polls Steam Workshop collections and posts additions/removals to a Discord webhook.
// Zero dependencies - uses Node 18+ built-in fetch.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(ROOT, 'state');
const CONFIG_PATH = path.join(ROOT, 'collections.json');

const STEAM_API = 'https://api.steampowered.com';
const itemUrl = (id) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;

const COLOR = {
  added: 0x57f287,
  removed: 0xed4245,
  mixed: 0x5865f2,
  info: 0x99aab5,
  error: 0xfee75c,
};

// Discord caps a single embed description at 4096 chars AND the combined
// text of every embed in one message at 6000. The per-message ceiling is the
// binding one, so keep individual blocks small enough to pack a few per post.
const DESC_BUDGET = 2400;
const MESSAGE_BUDGET = 5500;
const MAX_EMBEDS_PER_MESSAGE = 10;
const BASELINE = process.argv.includes('--baseline');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Strip characters that would break a markdown link label. */
function escapeLabel(text) {
  return String(text).replace(/([\\\[\]`*_~|])/g, '\\$1');
}

async function steamPost(endpoint, params, attempt = 1) {
  const body = new URLSearchParams(params);
  try {
    const res = await fetch(`${STEAM_API}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json?.response) throw new Error('missing response body');
    return json.response;
  } catch (err) {
    if (attempt >= 4) throw new Error(`Steam ${endpoint} failed: ${err.message}`);
    await sleep(attempt * 2000);
    return steamPost(endpoint, params, attempt + 1);
  }
}

/** Ordered list of publishedfileids currently in the collection. */
async function fetchCollectionItemIds(collectionId) {
  const res = await steamPost('/ISteamRemoteStorage/GetCollectionDetails/v1/', {
    collectioncount: 1,
    'publishedfileids[0]': collectionId,
  });
  const details = res.collectiondetails?.[0];
  if (!details) throw new Error('Steam returned no collection details');
  // result 9 = not found, private, deleted, or not actually a collection.
  if (Number(details.result) !== 1) {
    throw new Error(
      `collection unavailable (Steam result ${details.result}) - is it still public?`,
    );
  }
  return (details.children ?? []).map((c) => String(c.publishedfileid));
}

/** Map of id -> title. Items Steam can't resolve are omitted. */
async function fetchItemTitles(ids) {
  const titles = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const params = { itemcount: chunk.length };
    chunk.forEach((id, n) => {
      params[`publishedfileids[${n}]`] = id;
    });
    const res = await steamPost('/ISteamRemoteStorage/GetPublishedFileDetails/v1/', params);
    for (const item of res.publishedfiledetails ?? []) {
      if (Number(item.result) === 1 && item.title) {
        titles.set(String(item.publishedfileid), item.title);
      }
    }
  }
  return titles;
}

async function readState(collectionId) {
  let raw;
  try {
    raw = await readFile(path.join(STATE_DIR, `${collectionId}.json`), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { items: {}, initialized: false };
    throw new Error(`could not read snapshot: ${err.message}`);
  }
  // A corrupt snapshot must not look like a first run, or we'd silently
  // re-baseline and swallow whatever changed.
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `snapshot state/${collectionId}.json is corrupt (${err.message}) - ` +
        'delete it to re-baseline',
    );
  }
  return {
    items: parsed.items ?? {},
    initialized: parsed.initialized === true,
  };
}

async function writeState(collectionId, items) {
  await mkdir(STATE_DIR, { recursive: true });
  const payload = {
    collectionId,
    initialized: true,
    updatedAt: new Date().toISOString(),
    count: Object.keys(items).length,
    items,
  };
  await writeFile(
    path.join(STATE_DIR, `${collectionId}.json`),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  );
}

/** Rough character weight of an embed, matching what Discord counts. */
function embedSize(embed) {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.footer?.text?.length ?? 0) +
    (embed.author?.name?.length ?? 0)
  );
}

/** Pack embeds into messages that respect both Discord ceilings. */
function batchEmbeds(embeds) {
  const batches = [];
  let batch = [];
  let size = 0;
  for (const embed of embeds) {
    const cost = embedSize(embed);
    if (batch.length && (batch.length >= MAX_EMBEDS_PER_MESSAGE || size + cost > MESSAGE_BUDGET)) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(embed);
    size += cost;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function postToDiscord(webhookUrl, embeds) {
  for (const batch of batchEmbeds(embeds)) {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: batch }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429) {
        if (attempt >= 6) throw new Error('Discord kept rate limiting us; giving up');
        const retryAfter = Number(res.headers.get('retry-after')) || 5;
        await sleep((Math.min(retryAfter, 60) + 0.5) * 1000);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (attempt >= 3) throw new Error(`Discord webhook ${res.status}: ${text.slice(0, 300)}`);
        await sleep(attempt * 2000);
        continue;
      }
      break;
    }
    await sleep(1200); // stay friendly to the webhook rate limit
  }
}

/**
 * Render id/title pairs as markdown link lines, split across as many
 * description blocks as needed to respect Discord's embed limits.
 */
function renderChunks(entries) {
  const lines = entries.map(
    ([id, title]) => `- [${escapeLabel(title ?? `Unknown item ${id}`)}](${itemUrl(id)})`,
  );
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + line.length + 1 > DESC_BUDGET) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [''];
}

function buildEmbeds({ label, collectionId, added, removed }) {
  const embeds = [];
  const collectionLink = itemUrl(collectionId);
  const parts = [];
  if (added.length) parts.push(`+${added.length}`);
  if (removed.length) parts.push(`-${removed.length}`);
  const color = added.length && removed.length ? COLOR.mixed : added.length ? COLOR.added : COLOR.removed;

  let first = true;
  const section = (entries, heading, sectionColor) => {
    if (!entries.length) return;
    const chunks = renderChunks(entries);
    chunks.forEach((desc, i) => {
      embeds.push({
        ...(first
          ? {
              title: `${label} - ${parts.join(' / ')}`,
              url: collectionLink,
              color,
            }
          : { color: sectionColor }),
        description:
          `**${heading}${chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ''}**\n${desc}`,
        ...(first ? { timestamp: new Date().toISOString() } : {}),
      });
      first = false;
    });
  };

  section(added, `Added (${added.length})`, COLOR.added);
  section(removed, `Removed (${removed.length})`, COLOR.removed);
  return embeds;
}

async function processCollection(config, webhookUrl) {
  const collectionId = String(config.id);
  const label = config.label ?? `Collection ${collectionId}`;

  const currentIds = await fetchCollectionItemIds(collectionId);
  const prev = await readState(collectionId);
  const prevIds = Object.keys(prev.items);

  // Safety valve: Steam occasionally returns an empty collection during a
  // hiccup. Wiping state on that would spam a "removed everything" alert and
  // then a "re-added everything" alert on the next run.
  if (currentIds.length === 0 && prevIds.length > 0) {
    throw new Error(
      `Steam reported 0 items but we previously saw ${prevIds.length} - skipping this run`,
    );
  }

  const addedIds = currentIds.filter((id) => !(id in prev.items));
  const removedIds = prevIds.filter((id) => !currentIds.includes(id));

  // Titles for new items come from Steam; titles for removed items come from
  // our snapshot, since the item may be gone from the Workshop entirely.
  // Also re-resolve anything we previously failed to name.
  const unresolved = currentIds.filter((id) => prev.items[id]?.startsWith('Unknown item '));
  const lookupIds = [...new Set([...addedIds, ...unresolved])];
  const fetchedTitles = lookupIds.length ? await fetchItemTitles(lookupIds) : new Map();

  const nextItems = {};
  for (const id of currentIds) {
    nextItems[id] = fetchedTitles.get(id) ?? prev.items[id] ?? `Unknown item ${id}`;
  }

  const isFirstRun = !prev.initialized;
  await writeState(collectionId, nextItems);

  if (isFirstRun || BASELINE) {
    console.log(
      `${label}: ${BASELINE ? 're-baselined' : 'baseline saved'} with ${currentIds.length} items (no alert)`,
    );
    return {
      label,
      baseline: true,
      count: currentIds.length,
    };
  }

  if (!addedIds.length && !removedIds.length) {
    console.log(`${label}: no change (${currentIds.length} items)`);
    return { label, changed: false, count: currentIds.length };
  }

  const added = addedIds.map((id) => [id, nextItems[id]]);
  const removed = removedIds.map((id) => [id, prev.items[id]]);
  const embeds = buildEmbeds({ label, collectionId, added, removed });
  await postToDiscord(webhookUrl, embeds);

  console.log(`${label}: +${added.length} / -${removed.length} (now ${currentIds.length} items)`);
  return { label, changed: true, added: added.length, removed: removed.length };
}

async function main() {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error('DISCORD_WEBHOOK_URL is not set.');
    process.exit(1);
  }

  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  const collections = config.collections ?? [];
  if (!collections.length) {
    console.error('No collections configured in collections.json.');
    process.exit(1);
  }

  const failures = [];
  const baselines = [];

  for (const entry of collections) {
    const label = entry.label ?? `Collection ${entry.id}`;
    try {
      const result = await processCollection(entry, webhookUrl);
      if (result.baseline) baselines.push(result);
    } catch (err) {
      console.error(`${label}: ${err.message}`);
      failures.push({ label, message: err.message });
    }
  }

  if (baselines.length) {
    await postToDiscord(webhookUrl, [
      {
        title: 'Workshop Watcher is now tracking',
        color: COLOR.info,
        description: baselines
          .map(
            (b) =>
              `- **${escapeLabel(b.label)}** - ${b.count} items snapshotted. You'll get an alert on the next change.`,
          )
          .join('\n'),
        timestamp: new Date().toISOString(),
      },
    ]);
  }

  if (failures.length) {
    // Report the problem to Discord, but don't fail loudly enough to bury it.
    await postToDiscord(webhookUrl, [
      {
        title: 'Workshop Watcher hit a problem',
        color: COLOR.error,
        description: failures
          .map((f) => `- **${escapeLabel(f.label)}**: ${escapeLabel(f.message)}`)
          .join('\n'),
        timestamp: new Date().toISOString(),
      },
    ]).catch((err) => console.error(`Could not report failures: ${err.message}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
