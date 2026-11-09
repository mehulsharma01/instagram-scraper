# Instagram Scraper (Glimsera)

Apify actor that collects **public** Instagram data without logging in:

- **Profiles**: followers, following, post count, bio, plus the latest posts and reels (up to 12, which is what Instagram shows logged-out).
- **Post or Reel URLs**: likes, comments, views, caption, hashtags and a preview of top comments.

Each post row has `engagementRate` ((likes + comments) / followers) and `viewsPerFollower`, so the posts that reached well beyond the account's own audience are easy to sort out.

## Input

```json
{
  "usernames": ["glimsera", "https://www.instagram.com/some.creator/"],
  "postUrls": ["https://www.instagram.com/reel/ABC123/"],
  "maxPostsPerProfile": 12,
  "proxyConfiguration": { "useApifyProxy": true }
}
```

## When requests get blocked

Instagram often blocks datacenter IPs. A blocked profile is logged, saved as a row with `type: "error"`, and the run continues with the next one. If every request fails, switch the proxy to **Residential** or scrape fewer profiles per run.

## Output row (post)

`type` (reel, video, image, carousel), `username`, `followers`, `url`, `takenAt`, `caption`, `hashtags`, `likes`, `comments`, `views`, `engagementRate`, `viewsPerFollower`, `durationSec`, `audio`, `thumbnail`.

A `SUMMARY` record in the key-value store lists how many profiles succeeded and which failed.

## Development

```bash
npm install
npm test
```

This repo used to contain the `instatouch` CLI (drawrowfly/instagram-scraper). That code relied on Instagram endpoints that no longer exist and had no Apify entry point, so the actor crashed at start. It is still in the git history.
