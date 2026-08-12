# Workshop Watcher

Posts a Discord message whenever an item is **added to** or **removed from** a Steam Workshop
collection. Runs on GitHub Actions on a schedule — no server, no bot account, nothing to keep
online.

Currently watching:

| Collection | ID |
| --- | --- |
| [Removals](https://steamcommunity.com/sharedfiles/filedetails/?id=3751557821) | `3751557821` |
| [Additions](https://steamcommunity.com/sharedfiles/filedetails/?id=3751562522) | `3751562522` |

## How it works

Every ~15 minutes a workflow asks Steam for the current contents of each collection, diffs that
against the last snapshot stored in `state/`, and posts anything that changed to a Discord webhook.
The updated snapshot is committed back to the repo, so the diff survives between runs.

This tracks **collection membership**, not mod version updates. If a mod already in the collection
publishes a new version, that is not reported.

## Setup

### 1. Create the Discord webhook

In Discord: **Server Settings → Integrations → Webhooks → New Webhook**. Pick the channel you want
alerts in, then **Copy Webhook URL**.

Anyone with that URL can post to your channel, so treat it like a password — it goes in a GitHub
secret, never in a file.

### 2. Push this repo

```bash
git init && git add . && git commit -m "Workshop watcher" && git branch -M main && git remote add origin https://github.com/DanZinagri/workshop-watcher.git && git push -u origin main
```

### 3. Add the secret

**Repo → Settings → Secrets and variables → Actions → New repository secret**

- Name: `DISCORD_WEBHOOK_URL`
- Value: the webhook URL

### 4. Allow the workflow to commit

**Repo → Settings → Actions → General → Workflow permissions** → select **Read and write
permissions** → Save. The workflow needs this to store snapshots.

### 5. First run

**Actions → Workshop Watcher → Run workflow.** The first run snapshots both collections and posts a
"now tracking" message instead of announcing all 269 items as additions. After that, only real
changes get posted.

## Adding or removing a collection

Edit `collections.json`:

```json
{
  "collections": [
    { "id": "3751557821", "label": "Removals" },
    { "id": "3751562522", "label": "Additions" }
  ]
}
```

The `id` is the number from the collection URL. The collection must be **public** — Steam's API
returns nothing for private or friends-only collections. New entries baseline silently on their
first run.

To stop watching one, delete its entry and its `state/<id>.json` file.

## Notes and limitations

- **Timing.** GitHub's scheduled runs are best-effort and get delayed when the platform is busy;
  15 minutes is closer to 15–25 in practice. Cron below 5 minutes is not honored.
- **Free minutes.** Public repos get unlimited Actions minutes. On a private repo this uses roughly
  900–1000 of the free 2000 minutes/month, so it fits but leaves less room for other workflows.
- **Dormancy.** GitHub disables schedules on repos with no activity for 60 days. Because this
  workflow commits its own snapshots, it keeps itself alive.
- **Renames.** If a mod is renamed, alerts use the name recorded at the time it entered the
  collection.
- **Deleted mods.** An item pulled from the Workshop entirely shows as `Unknown item <id>` if it was
  never successfully named; removals always use the stored name, so they read correctly even after
  the mod is gone.
- **Safety valve.** If Steam reports an empty collection when the snapshot had items, the run is
  skipped rather than announcing a mass removal. You get an error message instead.

## Running it locally

Requires Node 20+ (the workflow runs it on Node 24).

```bash
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..." node watch.mjs
```

Re-snapshot everything without posting a change alert:

```bash
node watch.mjs --baseline
```
