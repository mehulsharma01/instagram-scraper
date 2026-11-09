// Pure helpers: turn user input and Instagram JSON into clean rows.
// Kept free of network code so they can be tested offline.

const RESERVED = new Set(['p', 'reel', 'reels', 'tv', 'explore', 'stories', 'accounts', 'direct']);

/** "glimsera", "@glimsera", "https://www.instagram.com/glimsera/?hl=en" -> "glimsera" */
export function toUsername(value) {
    if (typeof value !== 'string') return null;
    let s = value.trim();
    if (!s) return null;
    if (/instagram\.com/i.test(s)) {
        const path = s.replace(/^https?:\/\//i, '').replace(/^[^/]*instagram\.com/i, '');
        s = path.split(/[/?#]/).filter(Boolean)[0] || '';
        if (RESERVED.has(s.toLowerCase())) return null;
    }
    s = s.replace(/^@/, '');
    return /^[A-Za-z0-9._]{1,30}$/.test(s) ? s.toLowerCase() : null;
}

/** "https://www.instagram.com/reel/ABC123/?igsh=x" -> "ABC123" */
export function toShortcode(value) {
    if (typeof value !== 'string') return null;
    const m = value.match(/instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
    if (m) return m[1];
    return /^[A-Za-z0-9_-]{5,40}$/.test(value.trim()) ? value.trim() : null;
}

/** Old (edge-style) and new (xdt_) Instagram objects store counts in different places. */
const count = (...vals) => {
    for (const v of vals) {
        if (typeof v === 'number') return v;
        if (v && typeof v.count === 'number') return v.count;
    }
    return null;
};

export function hashtagsOf(caption) {
    if (!caption) return [];
    return [...new Set((caption.match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.toLowerCase()))];
}

export function postType(node) {
    if (node.product_type === 'clips') return 'reel';
    const t = node.__typename || '';
    if (/Sidecar/i.test(t) || node.edge_sidecar_to_children) return 'carousel';
    if (node.is_video || /Video/i.test(t)) return 'video';
    return 'image';
}

const round = (n, d = 4) => (n === null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const IG_EPOCH_MS = 1314220021721;

/**
 * Instagram media ids carry their creation time: (id >> 23) is milliseconds since IG's epoch.
 * The shortcode is the id in base64, so the post date can be read from the link alone.
 */
export function dateFromShortcode(shortcode) {
    if (typeof shortcode !== 'string' || shortcode.length < 6) return null;
    let n = 0n;
    for (const c of shortcode.slice(0, 11)) {
        const v = B64.indexOf(c);
        if (v < 0) return null;
        n = n * 64n + BigInt(v);
    }
    const ms = Number(n >> 23n) + IG_EPOCH_MS;
    return ms > IG_EPOCH_MS && ms < Date.now() + 86400000 ? new Date(ms).toISOString() : null;
}

/** One Instagram post/reel node -> one dataset row. */
export function normalizePost(node, owner = {}) {
    const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text
        ?? node.caption?.text
        ?? (typeof node.caption === 'string' ? node.caption : null)
        ?? null;
    const likes = count(node.edge_liked_by, node.edge_media_preview_like, node.like_count);
    const comments = count(node.edge_media_to_comment, node.edge_media_to_parent_comment, node.comment_count);
    const views = count(node.video_play_count, node.play_count, node.video_view_count, node.view_count);
    const followers = owner.followers ?? count(node.owner?.edge_followed_by) ?? null;
    const ts = node.taken_at_timestamp ?? node.taken_at ?? null;
    const shortcode = node.shortcode || node.code;
    const type = postType(node);
    const engagement = likes !== null && followers ? (likes + (comments || 0)) / followers : null;
    return {
        type,
        username: owner.username ?? node.owner?.username ?? null,
        followers,
        shortcode,
        url: shortcode ? `https://www.instagram.com/${type === 'reel' ? 'reel' : 'p'}/${shortcode}/` : null,
        takenAt: ts ? new Date(ts * 1000).toISOString() : dateFromShortcode(shortcode),
        caption,
        hashtags: hashtagsOf(caption),
        likes,
        comments,
        views,
        engagementRate: round(engagement),
        viewsPerFollower: views !== null && followers ? round(views / followers, 2) : null,
        durationSec: node.video_duration ?? null,
        isPinned: Boolean(node.pinned_for_users?.length || node.is_pinned),
        audio: node.clips_music_attribution_info
            ? `${node.clips_music_attribution_info.artist_name || ''} - ${node.clips_music_attribution_info.song_name || ''}`.trim()
            : null,
        thumbnail: node.display_url || node.thumbnail_src || null,
        accessibilityCaption: node.accessibility_caption ?? null,
        scrapedAt: new Date().toISOString(),
    };
}

/** web_profile_info response -> { profile, posts } */
export function parseProfile(json, maxPosts = 12) {
    const u = json?.data?.user;
    if (!u) return null;
    const profile = {
        type: 'profile',
        username: u.username?.toLowerCase(),
        fullName: u.full_name || null,
        followers: count(u.edge_followed_by, u.follower_count),
        following: count(u.edge_follow, u.following_count),
        postsCount: count(u.edge_owner_to_timeline_media, u.media_count),
        biography: u.biography || null,
        isVerified: Boolean(u.is_verified),
        isPrivate: Boolean(u.is_private),
        category: u.category_name || null,
        externalUrl: u.external_url || null,
        url: `https://www.instagram.com/${u.username}/`,
        scrapedAt: new Date().toISOString(),
    };
    const edges = u.edge_owner_to_timeline_media?.edges || [];
    const posts = edges.slice(0, maxPosts).map((e) => normalizePost(e.node, profile));
    return { profile, posts };
}

/**
 * Embed pages carry their data as a JSON string in "contextJSON":"...".
 * Returns the parsed object, or null.
 */
export function extractContextJSON(html) {
    if (typeof html !== 'string') return null;
    // The key can appear plain ("contextJSON":") or JSON-escaped once more (\"contextJSON\":\").
    for (const key of ['"contextJSON":"', '\\"contextJSON\\":\\"']) {
        const start = html.indexOf(key);
        if (start < 0) continue;
        const escaped = key.startsWith('\\');
        let i = start + key.length;
        let out = '';
        // Read up to the closing quote of this string literal.
        while (i < html.length) {
            const ch = html[i];
            if (!escaped) {
                if (ch === '\\') { out += ch + html[i + 1]; i += 2; continue; }
                if (ch === '"') break;
            } else if (html.startsWith('\\"', i) && !html.startsWith('\\\\"', i - 1)) {
                break;
            }
            out += ch;
            i += 1;
        }
        try {
            let s = JSON.parse(`"${out}"`);
            if (escaped) s = JSON.parse(`"${s}"`);
            return JSON.parse(s);
        } catch {
            // try the next key form
        }
    }
    return null;
}

/** Profile page or any page: unique post/reel shortcodes in page order. */
export function extractShortcodes(html, limit = 12) {
    if (typeof html !== 'string') return [];
    const seen = new Set();
    const out = [];
    const re = /(?:\\?\/)(p|reel)(?:\\?\/)([A-Za-z0-9_-]{8,})/g;
    let m;
    while ((m = re.exec(html)) && out.length < limit) {
        if (!seen.has(m[2])) {
            seen.add(m[2]);
            out.push({ shortcode: m[2], kind: m[1] });
        }
    }
    return out;
}

/** Post embed page -> row with views, likes, comments, caption. */
export function parseEmbedPost(html, owner = {}) {
    const ctx = extractContextJSON(html);
    const node = ctx?.gql_data?.shortcode_media;
    if (!node) return null;
    const row = normalizePost(node, {
        username: owner.username ?? node.owner?.username?.toLowerCase() ?? null,
        followers: owner.followers ?? count(node.owner?.edge_followed_by),
    });
    const shownLikes = parseCount(html.match(/>([\d.,]+[KkMm]?) likes?</)?.[1]);
    if (!row.likes && shownLikes) row.likes = shownLikes;
    // Instagram sends 0 likes and no views when it withholds counts (hidden by the owner,
    // or not shown to logged-out visitors). Report that as unknown, not as zero.
    const withheld = node.like_and_view_counts_disabled
        || (row.likes === 0 && !shownLikes && (row.views === null || row.views === 0));
    row.countsHidden = Boolean(withheld);
    if (withheld) {
        row.likes = null;
        row.views = null;
        row.engagementRate = null;
        row.viewsPerFollower = null;
    }
    row.videoUrl = node.video_url || null;
    const kids = node.edge_sidecar_to_children?.edges || [];
    if (kids.length) {
        row.children = kids.map((e) => ({
            imageUrl: e.node?.display_url || null,
            isVideo: Boolean(e.node?.is_video),
            videoUrl: e.node?.video_url || null,
        }));
    }
    const preview = node.edge_media_to_parent_comment?.edges || node.edge_media_preview_comment?.edges || [];
    if (preview.length) {
        row.topComments = preview.slice(0, 20).map((e) => ({
            text: e.node?.text ?? null,
            likes: count(e.node?.edge_liked_by),
            owner: e.node?.owner?.username ?? null,
        }));
    }
    return row;
}

/** Profile embed page -> profile row (exact follower count) or null. */
export function parseEmbedProfile(html) {
    const ctx = extractContextJSON(html)?.context;
    if (!ctx?.username) return null;
    return {
        type: 'profile',
        username: ctx.username.toLowerCase(),
        fullName: ctx.full_name || null,
        followers: ctx.followers_count ?? null,
        following: null,
        postsCount: ctx.posts_count ?? null,
        biography: null,
        isVerified: Boolean(ctx.is_verified || ctx.verified),
        isPrivate: null,
        category: null,
        externalUrl: null,
        url: `https://www.instagram.com/${ctx.username}/`,
        scrapedAt: new Date().toISOString(),
    };
}

/** "12.3K" / "1,234" / "1.2M" -> number */
export function parseCount(s) {
    if (!s) return null;
    const m = String(s).trim().replace(/,/g, '').match(/^([\d.]+)\s*([KkMmBb])?$/);
    if (!m) return null;
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
    return Math.round(parseFloat(m[1]) * mult);
}

/** Public profile page HTML -> profile row from its meta description, or null. */
export function parseProfileHtml(html, username) {
    if (typeof html !== 'string') return null;
    const desc = html.match(/<meta[^>]+(?:name|property)="(?:og:)?description"[^>]+content="([^"]+)"/i)?.[1]
        || html.match(/<meta[^>]+content="([^"]+)"[^>]+(?:name|property)="(?:og:)?description"/i)?.[1];
    if (!desc) return null;
    const text = desc.replace(/&#x2c;|&#44;/gi, ',').replace(/&amp;/g, '&');
    const m = text.match(/([\d.,]+[KkMmBb]?)\s+Followers?,\s*([\d.,]+[KkMmBb]?)\s+Following,\s*([\d.,]+[KkMmBb]?)\s+Posts?/i);
    if (!m) return null;
    return {
        type: 'profile',
        username: username.toLowerCase(),
        fullName: null,
        followers: parseCount(m[1]),
        following: parseCount(m[2]),
        postsCount: parseCount(m[3]),
        biography: null,
        isVerified: null,
        isPrivate: null,
        category: null,
        externalUrl: null,
        url: `https://www.instagram.com/${username}/`,
        scrapedAt: new Date().toISOString(),
    };
}

/** Single post GraphQL response (old or new shape) -> row, or null. */
export function parsePost(json) {
    const node = json?.data?.xdt_shortcode_media || json?.data?.shortcode_media || json?.graphql?.shortcode_media;
    if (!node) return null;
    const owner = {
        username: node.owner?.username?.toLowerCase() ?? null,
        followers: count(node.owner?.edge_followed_by),
    };
    const row = normalizePost(node, owner);
    const preview = node.edge_media_to_parent_comment?.edges || node.edge_media_preview_comment?.edges || [];
    row.topComments = preview.slice(0, 20).map((e) => ({
        text: e.node?.text ?? null,
        likes: count(e.node?.edge_liked_by),
        owner: e.node?.owner?.username ?? null,
    }));
    return row;
}
