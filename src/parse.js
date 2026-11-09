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
        takenAt: ts ? new Date(ts * 1000).toISOString() : null,
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
