# Instagram Scraper (Glimsera)

Apify actor that collects **public** Instagram data without logging in:

- **Profiles**: exact followers, following and post count, plus the latest 12 posts and reels.
- **Post or Reel URLs**: views, likes, comments, caption, hashtags, audio and date.

## How it works

Instagram's JSON APIs answer logged-out visitors with 404 (Nov 2026). This actor reads the pages Instagram serves to everyone:

1. The profile page: follower and post counts, and the 12 latest post links.
2. The profile embed page: the exact follower count.
3. Each post's embed page: views, likes, comments, caption, audio and date.

Use the **Residential** proxy (the default). Shared datacenter IPs are blocked. Cost is roughly $0.03 of proxy traffic per profile with 12 posts.

Each post row has `engagementRate` ((likes + comments) / followers) and `viewsPerFollower`, so the posts that reached well beyond the account's own audience are easy to sort out.

## Input

```json
{
  "usernames": ["glimsera", "https://www.instagram.com/some.creator/"],
  "postUrls": ["https://www.instagram.com/reel/ABC123/"],
  "maxPostsPerProfile": 12,
  "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
}
```

## When requests get blocked

A blocked page is retried with a new IP. A profile that still fails is saved as a row with `type: "error"` and the run continues. Like and view counts are missing on posts where the owner hid them (`countsHidden: true`).

Set **Probe page formats (debug)** to save a short report of what Instagram's pages contain, if Instagram changes its pages and parsing stops working.

## Output row (post)

`type` (reel, video, image, carousel), `username`, `followers`, `url`, `takenAt`, `caption`, `hashtags`, `likes`, `comments`, `views`, `engagementRate`, `viewsPerFollower`, `durationSec`, `audio`, `thumbnail`.

A `SUMMARY` record in the key-value store lists how many profiles succeeded and which failed.

## Development

```bash
npm install
npm test
```

This repo used to contain the `instatouch` CLI (drawrowfly/instagram-scraper). That code relied on Instagram endpoints that no longer exist and had no Apify entry point, so the actor crashed at start. It is still in the git history.
