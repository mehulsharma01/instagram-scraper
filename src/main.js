// Glimsera Instagram Scraper (Apify actor).
//
// Instagram's JSON APIs now answer logged-out visitors with 404, so this actor reads
// the public pages Instagram serves to everyone:
//   - profile page            -> follower/post counts + the 12 latest post links
//   - profile embed page      -> exact follower count
//   - post embed page (each)  -> views, likes, comments, caption, audio, date
// No login. Every request is wrapped so one blocked page never crashes the run.

import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import {
    toUsername, toShortcode, extractShortcodes, parseEmbedPost, parseEmbedProfile, parseProfileHtml,
} from './parse.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base) => base + Math.floor(Math.random() * base);

class BlockedError extends Error {}

await Actor.init();

try {
    const input = (await Actor.getInput()) || {};
    const usernames = [...new Set((input.usernames || []).map(toUsername).filter(Boolean))];
    const shortcodes = [...new Set((input.postUrls || []).map(toShortcode).filter(Boolean))];
    const maxPosts = Math.min(Math.max(Number(input.maxPostsPerProfile) || 12, 0), 12);
    const maxRetries = Number.isInteger(input.maxRetries) ? input.maxRetries : 3;
    const includeProfileRow = input.includeProfileRow !== false;

    if (!usernames.length && !shortcodes.length) {
        const msg = 'Nothing to scrape. Add at least one username in "Profiles" or a link in "Post or Reel URLs".';
        log.error(msg, { receivedInput: input });
        await Actor.fail(msg);
    }

    let proxy = null;
    try {
        proxy = await Actor.createProxyConfiguration(
            input.proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
        );
    } catch (err) {
        log.warning(`Proxy not available (${err.message}). Continuing without a proxy; Instagram may block some requests.`);
    }

    /** GET a public Instagram page as HTML, retrying blocked responses with a new IP. */
    async function getPage(url) {
        let lastErr;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const proxyUrl = proxy ? await proxy.newUrl(`ig_${Date.now()}_${Math.floor(Math.random() * 1e6)}`) : undefined;
            try {
                const res = await gotScraping({
                    url,
                    proxyUrl,
                    timeout: { request: 30000 },
                    followRedirect: false,
                    throwHttpErrors: false,
                    headerGeneratorOptions: { browsers: ['chrome'], devices: ['desktop'], locales: ['en-US'] },
                    headers: { accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' },
                });
                const body = String(res.body || '');
                if (res.statusCode >= 300 && res.statusCode < 400) {
                    throw new BlockedError(`Redirected to ${res.headers.location || 'login'} (${res.statusCode})`);
                }
                if (res.statusCode !== 200) {
                    throw new BlockedError(`HTTP ${res.statusCode}: ${body.slice(0, 120).replace(/\s+/g, ' ')}`);
                }
                if (body.length < 2000) throw new BlockedError(`Page too short (${body.length} bytes)`);
                return body;
            } catch (err) {
                lastErr = err;
                if (attempt === maxRetries) break;
                const wait = Math.min(2000 * 2 ** attempt, 20000) + Math.floor(Math.random() * 1000);
                log.warning(`Attempt ${attempt + 1}/${maxRetries + 1} failed for ${url}: ${err.message}. Retrying in ${Math.round(wait / 1000)}s with a new IP.`);
                await sleep(wait);
            }
        }
        throw lastErr || new BlockedError('Unknown error');
    }

    /** One post: embed page first, the captioned variant as a fallback. */
    async function fetchPost(shortcode, owner = {}) {
        const urls = [
            `https://www.instagram.com/p/${shortcode}/embed/captioned/`,
            `https://www.instagram.com/reel/${shortcode}/embed/`,
        ];
        let lastErr;
        for (const url of urls) {
            try {
                const row = parseEmbedPost(await getPage(url), owner);
                if (row) return row;
                lastErr = new Error('Embed page had no post data (post may be deleted, private, or embedding is off)');
            } catch (err) {
                lastErr = err;
            }
        }
        throw lastErr;
    }

    const stats = { profilesOk: 0, postsSaved: 0, failed: [] };

    /** Binary files are stored in 190 KB parts (<KEY>.p0, .p1, ...) so readers with a small inline limit can fetch them. */
    const PART = 190000;
    async function saveBinary(key, url) {
        const proxyUrl = proxy ? await proxy.newUrl(`bin_${Date.now()}_${Math.floor(Math.random() * 1e6)}`) : undefined;
        const res = await gotScraping({ url, proxyUrl, responseType: 'buffer', timeout: { request: 60000 }, throwHttpErrors: false });
        if (res.statusCode !== 200 || !res.body?.length) throw new Error(`HTTP ${res.statusCode}`);
        const buf = res.body; const parts = Math.ceil(buf.length / PART);
        for (let i = 0; i < parts; i++) {
            await Actor.setValue(`${key}.p${i}`, buf.subarray(i * PART, (i + 1) * PART), { contentType: 'application/octet-stream' });
        }
        return { key, parts, bytes: buf.length, contentType: res.headers['content-type'] || null };
    }

    /** Optional: save the post's images (every carousel slide) and videos to the key-value store. */
    async function saveImage(row) {
        if (!row?.shortcode || (!input.saveImages && !input.saveVideos)) return row;
        const base = row.shortcode.replace(/[^A-Za-z0-9_-]/g, '_');
        const jobs = [];
        if (input.saveImages) {
            if (row.children?.length) row.children.forEach((c, i) => c.imageUrl && jobs.push([`IMG_${base}_${i + 1}`, c.imageUrl]));
            else if (row.thumbnail) jobs.push([`IMG_${base}`, row.thumbnail]);
        }
        if (input.saveVideos) {
            if (row.videoUrl) jobs.push([`VID_${base}`, row.videoUrl]);
            row.children?.forEach((c, i) => c.videoUrl && jobs.push([`VID_${base}_${i + 1}`, c.videoUrl]));
        }
        row.files = [];
        for (const [key, url] of jobs) {
            try { row.files.push(await saveBinary(key, url)); } catch (err) { log.warning(`${key} failed: ${err.message}`); }
        }
        return row;
    }

    // Debug probe: save a compact report of what each logged-out page contains.
    if (input.debugProbe) {
        const user = usernames[0] || 'instagram';
        const markers = ['contextJSON', 'gql_data', 'shortcode_media', 'video_view_count', 'edge_liked_by',
            'edge_media_to_comment', 'like_and_view_counts_disabled', 'og:description', 'product_type'];
        const report = {};
        for (const [key, url] of [
            ['profile', `https://www.instagram.com/${user}/`],
            ['profileEmbed', `https://www.instagram.com/${user}/embed/`],
            ...(shortcodes[0] ? [['postEmbed', `https://www.instagram.com/p/${shortcodes[0]}/embed/captioned/`]] : []),
        ]) {
            try {
                const html = await getPage(url);
                const found = {};
                for (const m of markers) {
                    const idx = html.indexOf(m);
                    if (idx >= 0) found[m] = { count: html.split(m).length - 1, sample: html.slice(Math.max(0, idx - 100), idx + 200) };
                }
                report[key] = { url, length: html.length, shortcodes: extractShortcodes(html), found };
            } catch (err) {
                report[key] = { url, error: err.message };
            }
        }
        await Actor.setValue('PROBE', report);
        await Actor.exit('Probe saved to key-value store record PROBE.');
    }

    for (const [i, username] of usernames.entries()) {
        await Actor.setStatusMessage(`Profile ${i + 1}/${usernames.length}: @${username}`);
        try {
            const pageHtml = await getPage(`https://www.instagram.com/${encodeURIComponent(username)}/`);
            let profile = parseProfileHtml(pageHtml, username);
            if (input.debugSaveHtml) {
                await Actor.setValue(`HTML_${username.replace(/[^a-z0-9]/gi, '_')}`, pageHtml, { contentType: 'text/html' });
            }

            // The embed page has the exact follower count (the profile page rounds it, e.g. "100K").
            try {
                const embedProfile = parseEmbedProfile(await getPage(`https://www.instagram.com/${encodeURIComponent(username)}/embed/`));
                if (embedProfile) {
                    profile = {
                        ...(profile || {}),
                        ...embedProfile,
                        following: profile?.following ?? null,
                    };
                }
            } catch (err) {
                log.warning(`@${username}: embed profile unavailable (${err.message}); using rounded counts.`);
            }
            if (!profile) throw new BlockedError('Profile page had no counts (private, missing, or a login wall)');

            if (includeProfileRow) await Actor.pushData(profile);
            stats.profilesOk += 1;

            const codes = extractShortcodes(pageHtml, maxPosts);
            if (!codes.length && maxPosts > 0) log.warning(`@${username}: no post links found on the profile page.`);
            let saved = 0;
            for (const { shortcode } of codes) {
                try {
                    const row = await saveImage(await fetchPost(shortcode, { username, followers: profile.followers }));
                    await Actor.pushData(row);
                    saved += 1;
                } catch (err) {
                    log.warning(`@${username} post ${shortcode}: ${err.message}`);
                    stats.failed.push({ target: shortcode, error: err.message });
                }
                await sleep(jitter(700));
            }
            stats.postsSaved += saved;
            log.info(`@${username}: ${profile.followers ?? '?'} followers, ${saved}/${codes.length} posts saved.`);
        } catch (err) {
            log.error(`@${username} failed: ${err.message}`);
            stats.failed.push({ target: `@${username}`, error: err.message });
            await Actor.pushData({ type: 'error', target: username, error: err.message, scrapedAt: new Date().toISOString() });
        }
        await sleep(jitter(1200));
    }

    for (const [i, shortcode] of shortcodes.entries()) {
        await Actor.setStatusMessage(`Post ${i + 1}/${shortcodes.length}: ${shortcode}`);
        try {
            await Actor.pushData(await saveImage(await fetchPost(shortcode)));
            stats.postsSaved += 1;
        } catch (err) {
            log.error(`Post ${shortcode} failed: ${err.message}`);
            stats.failed.push({ target: shortcode, error: err.message });
            await Actor.pushData({ type: 'error', target: shortcode, error: err.message, scrapedAt: new Date().toISOString() });
        }
        await sleep(jitter(700));
    }

    await Actor.setValue('SUMMARY', stats);
    const summary = `Done: ${stats.profilesOk}/${usernames.length} profiles, ${stats.postsSaved} posts saved, ${stats.failed.length} failed.`;
    log.info(summary);

    if (stats.profilesOk === 0 && stats.postsSaved === 0) {
        await Actor.fail(`${summary} Every request was blocked. Use the Residential proxy, or fewer profiles per run.`);
    } else {
        await Actor.exit(summary);
    }
} catch (err) {
    // Last-resort guard: report the problem instead of an "uncaught exception".
    log.exception(err, 'Run stopped by an unexpected error');
    await Actor.fail(`Unexpected error: ${err.message}`);
}
