// Glimsera Instagram Scraper (Apify actor).
// Public profiles -> latest posts with likes, comments, views and engagement.
// Optional single post/reel URLs -> numbers plus a preview of top comments.
// No login. Every request is wrapped so one blocked profile never crashes the run.

import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { toUsername, toShortcode, parseProfile, parsePost, parseProfileHtml } from './parse.js';

const IG_APP_ID = '936619743392459'; // Instagram web app id, sent by instagram.com itself
const POST_DOC_ID = '8845758582119845'; // public GraphQL query for one post (xdt_shortcode_media)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class BlockedError extends Error {}
class NotFoundError extends Error {}

if (process.env.DEBUG_IG === '1') log.setLevel(log.LEVELS.DEBUG);

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

    const MOBILE_UA = 'Instagram 309.1.0.41.113 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 541635890)';

    // style: 'web' (browser-like XHR), 'mobile' (Android app UA), 'html' (plain page load)
    async function request(url, { method = 'GET', form, referer, style = 'web', expect = 'json' } = {}) {
        let lastErr;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const session = `ig_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
            const proxyUrl = proxy ? await proxy.newUrl(session) : undefined;
            try {
                const headers = style === 'mobile'
                    ? { 'user-agent': MOBILE_UA, 'x-ig-app-id': '567067343352427', accept: '*/*', 'accept-language': 'en-US' }
                    : style === 'html'
                        ? { accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' }
                        : {
                            'x-ig-app-id': IG_APP_ID,
                            'x-requested-with': 'XMLHttpRequest',
                            'x-asbd-id': '129477',
                            accept: '*/*',
                            referer: referer || 'https://www.instagram.com/',
                            ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
                        };
                const res = await gotScraping({
                    url,
                    method,
                    form,
                    proxyUrl,
                    timeout: { request: 30000 },
                    followRedirect: false,
                    throwHttpErrors: false,
                    useHeaderGenerator: style !== 'mobile',
                    headerGeneratorOptions: { browsers: ['chrome'], devices: ['desktop'], locales: ['en-US'] },
                    headers,
                });
                const { statusCode } = res;
                const body = String(res.body || '');
                const snippet = body.slice(0, 200).replace(/\s+/g, ' ');
                if (statusCode !== 200) {
                    log.debug(`HTTP ${statusCode} from ${url} (${style}): ${snippet}`);
                }
                // Instagram answers blocked IPs with 404, 401, 429 or a redirect to the login page.
                if (statusCode >= 300 && statusCode < 400) {
                    throw new BlockedError(`Redirected to ${res.headers.location || 'login'} (${statusCode})`);
                }
                if (statusCode !== 200) throw new BlockedError(`HTTP ${statusCode}: ${snippet || 'empty body'}`);
                if (expect === 'html') return body;
                let json;
                try {
                    json = JSON.parse(body);
                } catch {
                    throw new BlockedError(`Got HTML instead of JSON; likely a login wall: ${snippet}`);
                }
                if (json?.require_login || json?.status === 'fail') {
                    throw new BlockedError(json.message || 'Instagram asked for login');
                }
                return json;
            } catch (err) {
                lastErr = err;
                if (attempt === maxRetries) break;
                const wait = Math.min(2000 * 2 ** attempt, 20000) + Math.floor(Math.random() * 1000);
                log.warning(`Attempt ${attempt + 1}/${maxRetries + 1} (${style}) failed: ${err.message}. Retrying in ${Math.round(wait / 1000)}s with a new IP.`);
                await sleep(wait);
            }
        }
        throw lastErr || new BlockedError('Unknown error');
    }

    // Try each way of reading a profile until one works.
    async function fetchProfile(username) {
        const errors = [];
        const enc = encodeURIComponent(username);
        const attempts = [
            ['web', () => request(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${enc}`,
                { referer: `https://www.instagram.com/${username}/` })],
            ['mobile', () => request(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${enc}`, { style: 'mobile' })],
        ];
        for (const [name, run] of attempts) {
            try {
                const parsed = parseProfile(await run(), maxPosts);
                if (parsed) return { ...parsed, method: name };
                errors.push(`${name}: no profile data in response`);
            } catch (err) {
                errors.push(`${name}: ${err.message}`);
                log.warning(`@${username}: ${name} method failed (${err.message}). Trying the next method.`);
            }
        }
        // Last resort: the public profile page. Gives counts only, no posts.
        try {
            const html = await request(`https://www.instagram.com/${enc}/`, { style: 'html', expect: 'html' });
            if (input.debugSaveHtml) await Actor.setValue(`HTML_${username.replace(/[^a-z0-9]/gi, '_')}`, html, { contentType: 'text/html' });
            const profile = parseProfileHtml(html, username);
            if (profile) return { profile, posts: [], method: 'html' };
            errors.push('html: page had no profile counts');
        } catch (err) {
            errors.push(`html: ${err.message}`);
        }
        throw new BlockedError(errors.join(' | '));
    }

    const stats = { profilesOk: 0, postsSaved: 0, failed: [] };

    // Debug probe: fetch candidate logged-out pages and save a compact report of what each contains.
    if (input.debugProbe) {
        const user = usernames[0] || 'instagram';
        const markers = ['shortcode', '"code":', 'edge_liked_by', 'like_count', 'video_view_count', 'play_count', 'edge_media_to_comment',
            'comment_count', 'contextJSON', 'gql_data', 'shortcode_media', 'taken_at', 'EmbedSidecar', 'Embed', 'xdt_', 'LSD', 'profile_id', 'Likes', 'likes', 'views', 'Follow'];
        const report = {};
        const probe = async (key, url) => {
            try {
                const html = await request(url, { style: 'html', expect: 'html' });
                const found = {};
                for (const m of markers) {
                    const idx = html.indexOf(m);
                    if (idx >= 0) found[m] = { count: html.split(m).length - 1, sample: html.slice(Math.max(0, idx - 120), idx + 220) };
                }
                const codes = [...new Set((html.match(/\/(?:p|reel)\/([A-Za-z0-9_-]{8,})/g) || []))].slice(0, 15);
                report[key] = { url, length: html.length, codes, found };
                return codes;
            } catch (err) {
                report[key] = { url, error: err.message };
                return [];
            }
        };
        await probe('profile', `https://www.instagram.com/${user}/`);
        const codes = await probe('profileEmbed', `https://www.instagram.com/${user}/embed/`);
        const first = (codes[0] || '').split('/').pop() || shortcodes[0];
        if (first) {
            await probe('postEmbedCaptioned', `https://www.instagram.com/p/${first}/embed/captioned/`);
            await probe('postPage', `https://www.instagram.com/p/${first}/`);
        }
        await Actor.setValue('PROBE', report);
        await Actor.exit('Probe saved to key-value store record PROBE.');
    }

    for (const [i, username] of usernames.entries()) {
        await Actor.setStatusMessage(`Profile ${i + 1}/${usernames.length}: @${username}`);
        try {
            const parsed = await fetchProfile(username);
            if (parsed.profile.isPrivate) log.info(`@${username} is private; only the profile row is available.`);
            parsed.profile.method = parsed.method;
            if (includeProfileRow || !parsed.posts.length) await Actor.pushData(parsed.profile);
            if (parsed.posts.length) await Actor.pushData(parsed.posts);
            stats.profilesOk += 1;
            stats.postsSaved += parsed.posts.length;
            log.info(`@${username}: ${parsed.profile.followers ?? '?'} followers, ${parsed.posts.length} posts saved (method: ${parsed.method}).`);
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
