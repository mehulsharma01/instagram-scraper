// Glimsera Instagram Scraper (Apify actor).
// Public profiles -> latest posts with likes, comments, views and engagement.
// Optional single post/reel URLs -> numbers plus a preview of top comments.
// No login. Every request is wrapped so one blocked profile never crashes the run.

import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { toUsername, toShortcode, parseProfile, parsePost } from './parse.js';

const IG_APP_ID = '936619743392459'; // Instagram web app id, sent by instagram.com itself
const POST_DOC_ID = '8845758582119845'; // public GraphQL query for one post (xdt_shortcode_media)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class BlockedError extends Error {}
class NotFoundError extends Error {}

await Actor.init();

try {
    const input = (await Actor.getInput()) || {};
    const usernames = [...new Set((input.usernames || []).map(toUsername).filter(Boolean))];
    const shortcodes = [...new Set((input.postUrls || []).map(toShortcode).filter(Boolean))];
    const maxPosts = Math.min(Math.max(Number(input.maxPostsPerProfile) || 12, 1), 12);
    const maxRetries = Number.isInteger(input.maxRetries) ? input.maxRetries : 4;
    const includeProfileRow = input.includeProfileRow !== false;

    if (!usernames.length && !shortcodes.length) {
        const msg = 'Nothing to scrape. Add at least one username in "Profiles" or a link in "Post or Reel URLs".';
        log.error(msg, { receivedInput: input });
        await Actor.fail(msg);
    }

    let proxy = null;
    try {
        proxy = await Actor.createProxyConfiguration(input.proxyConfiguration ?? { useApifyProxy: true });
    } catch (err) {
        log.warning(`Proxy not available (${err.message}). Continuing without a proxy; Instagram may block some requests.`);
    }

    async function request(url, { method = 'GET', form, referer } = {}) {
        let lastErr;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const session = `ig_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
            const proxyUrl = proxy ? await proxy.newUrl(session) : undefined;
            try {
                const res = await gotScraping({
                    url,
                    method,
                    form,
                    proxyUrl,
                    timeout: { request: 30000 },
                    followRedirect: false,
                    throwHttpErrors: false,
                    headerGeneratorOptions: { browsers: ['chrome'], devices: ['desktop'], locales: ['en-US'] },
                    headers: {
                        'x-ig-app-id': IG_APP_ID,
                        'x-requested-with': 'XMLHttpRequest',
                        'x-asbd-id': '129477',
                        accept: '*/*',
                        referer: referer || 'https://www.instagram.com/',
                        ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
                    },
                });
                const { statusCode } = res;
                if (statusCode === 404) throw new NotFoundError('Not found (404)');
                if (statusCode >= 300 && statusCode < 400) throw new BlockedError(`Redirected to login (${statusCode})`);
                if (statusCode === 401 || statusCode === 403 || statusCode === 429 || statusCode >= 500) {
                    throw new BlockedError(`HTTP ${statusCode}`);
                }
                let json;
                try {
                    json = JSON.parse(res.body);
                } catch {
                    throw new BlockedError(`Got HTML instead of JSON (HTTP ${statusCode}); likely a login wall`);
                }
                if (json?.require_login || json?.status === 'fail') {
                    throw new BlockedError(json.message || 'Instagram asked for login');
                }
                return json;
            } catch (err) {
                if (err instanceof NotFoundError) throw err;
                lastErr = err;
                const wait = Math.min(2000 * 2 ** attempt, 20000) + Math.floor(Math.random() * 1000);
                log.warning(`Attempt ${attempt + 1}/${maxRetries + 1} failed for ${url}: ${err.message}. Retrying in ${Math.round(wait / 1000)}s with a new IP.`);
                await sleep(wait);
            }
        }
        throw lastErr || new BlockedError('Unknown error');
    }

    const stats = { profilesOk: 0, postsSaved: 0, failed: [] };

    for (const [i, username] of usernames.entries()) {
        await Actor.setStatusMessage(`Profile ${i + 1}/${usernames.length}: @${username}`);
        try {
            const json = await request(
                `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
                { referer: `https://www.instagram.com/${username}/` },
            );
            const parsed = parseProfile(json, maxPosts);
            if (!parsed) throw new NotFoundError('Profile data missing from response');
            if (parsed.profile.isPrivate) log.info(`@${username} is private; only the profile row is available.`);
            if (includeProfileRow) await Actor.pushData(parsed.profile);
            if (parsed.posts.length) await Actor.pushData(parsed.posts);
            stats.profilesOk += 1;
            stats.postsSaved += parsed.posts.length;
            log.info(`@${username}: ${parsed.profile.followers ?? '?'} followers, ${parsed.posts.length} posts saved.`);
        } catch (err) {
            log.error(`@${username} failed: ${err.message}`);
            stats.failed.push({ target: `@${username}`, error: err.message });
            await Actor.pushData({ type: 'error', target: username, error: err.message, scrapedAt: new Date().toISOString() });
        }
        await sleep(1500 + Math.floor(Math.random() * 1500));
    }

    for (const [i, shortcode] of shortcodes.entries()) {
        await Actor.setStatusMessage(`Post ${i + 1}/${shortcodes.length}: ${shortcode}`);
        try {
            const json = await request('https://www.instagram.com/graphql/query', {
                method: 'POST',
                referer: `https://www.instagram.com/p/${shortcode}/`,
                form: {
                    doc_id: POST_DOC_ID,
                    variables: JSON.stringify({ shortcode, fetch_tagged_user_count: null, hoisted_comment_id: null, hoisted_reply_id: null }),
                },
            });
            const row = parsePost(json);
            if (!row) throw new NotFoundError('Post data missing from response (deleted, private, or the query changed)');
            await Actor.pushData(row);
            stats.postsSaved += 1;
        } catch (err) {
            log.error(`Post ${shortcode} failed: ${err.message}`);
            stats.failed.push({ target: shortcode, error: err.message });
            await Actor.pushData({ type: 'error', target: shortcode, error: err.message, scrapedAt: new Date().toISOString() });
        }
        await sleep(1000 + Math.floor(Math.random() * 1000));
    }

    await Actor.setValue('SUMMARY', stats);
    const summary = `Done: ${stats.profilesOk}/${usernames.length} profiles, ${stats.postsSaved} posts saved, ${stats.failed.length} failed.`;
    log.info(summary);

    const total = usernames.length + shortcodes.length;
    if (stats.failed.length === total) {
        await Actor.fail(`${summary} Every request was blocked. Try "Proxy" set to Residential, or fewer profiles per run.`);
    } else {
        await Actor.exit(summary);
    }
} catch (err) {
    // Last-resort guard: report the problem instead of an "uncaught exception".
    log.exception(err, 'Run stopped by an unexpected error');
    await Actor.fail(`Unexpected error: ${err.message}`);
}
