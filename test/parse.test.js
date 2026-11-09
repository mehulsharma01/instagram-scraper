import test from 'node:test';
import assert from 'node:assert/strict';
import { toUsername, toShortcode, parseProfile, parsePost, hashtagsOf } from '../src/parse.js';

test('toUsername accepts handles and profile URLs', () => {
    assert.equal(toUsername('glimsera'), 'glimsera');
    assert.equal(toUsername('@Glimsera'), 'glimsera');
    assert.equal(toUsername('https://www.instagram.com/glimsera/?hl=en'), 'glimsera');
    assert.equal(toUsername('instagram.com/some.user_1'), 'some.user_1');
    assert.equal(toUsername('https://www.instagram.com/reel/ABC123/'), null);
    assert.equal(toUsername('not a handle!'), null);
    assert.equal(toUsername(123), null);
});

test('toShortcode reads post and reel links', () => {
    assert.equal(toShortcode('https://www.instagram.com/reel/DAbc_12-x/?igsh=1'), 'DAbc_12-x');
    assert.equal(toShortcode('https://instagram.com/p/C9xyz/'), 'C9xyz');
    assert.equal(toShortcode('https://www.instagram.com/glimsera/reel/C9xyz/'), 'C9xyz');
    assert.equal(toShortcode('https://www.instagram.com/glimsera/'), null);
});

test('hashtags are unique and lowercased', () => {
    assert.deepEqual(hashtagsOf('Nails #ChristmasNails #nails #christmasnails #unhasDecoradas'), ['#christmasnails', '#nails', '#unhasdecoradas']);
});

const profileJson = {
    data: {
        user: {
            username: 'Glimsera',
            full_name: 'Glimsera',
            edge_followed_by: { count: 100000 },
            edge_follow: { count: 10 },
            biography: 'Beauty',
            is_private: false,
            edge_owner_to_timeline_media: {
                count: 566,
                edges: [
                    {
                        node: {
                            __typename: 'GraphVideo', product_type: 'clips', is_video: true, shortcode: 'R1',
                            video_view_count: 2500000, edge_liked_by: { count: 90000 }, edge_media_to_comment: { count: 1000 },
                            edge_media_to_caption: { edges: [{ node: { text: 'Cherry cola hair #hair' } }] },
                            taken_at_timestamp: 1762646400,
                        },
                    },
                    {
                        node: {
                            __typename: 'GraphSidecar', shortcode: 'C1', edge_media_preview_like: { count: 5000 },
                            edge_media_to_comment: { count: 50 }, taken_at_timestamp: 1762646400,
                        },
                    },
                ],
            },
        },
    },
};

test('parseProfile builds profile and post rows', () => {
    const { profile, posts } = parseProfile(profileJson, 12);
    assert.equal(profile.username, 'glimsera');
    assert.equal(profile.followers, 100000);
    assert.equal(profile.postsCount, 566);
    assert.equal(posts.length, 2);
    assert.equal(posts[0].type, 'reel');
    assert.equal(posts[0].url, 'https://www.instagram.com/reel/R1/');
    assert.equal(posts[0].views, 2500000);
    assert.equal(posts[0].engagementRate, 0.91);
    assert.equal(posts[0].viewsPerFollower, 25);
    assert.deepEqual(posts[0].hashtags, ['#hair']);
    assert.equal(posts[1].type, 'carousel');
    assert.equal(posts[1].likes, 5000);
    assert.equal(posts[1].views, null);
});

test('parseProfile respects maxPosts and handles missing user', () => {
    assert.equal(parseProfile(profileJson, 1).posts.length, 1);
    assert.equal(parseProfile({}), null);
});

test('parsePost reads the new xdt shape with comments', () => {
    const row = parsePost({
        data: {
            xdt_shortcode_media: {
                __typename: 'XDTGraphVideo', product_type: 'clips', is_video: true, shortcode: 'X9',
                video_play_count: 400, edge_media_preview_like: { count: 40 }, edge_media_to_parent_comment: {
                    count: 2, edges: [{ node: { text: 'what shade is this?', owner: { username: 'a' }, edge_liked_by: { count: 3 } } }],
                },
                owner: { username: 'Creator', edge_followed_by: { count: 1000 } },
            },
        },
    });
    assert.equal(row.username, 'creator');
    assert.equal(row.views, 400);
    assert.equal(row.comments, 2);
    assert.equal(row.topComments[0].text, 'what shade is this?');
    assert.equal(parsePost({ data: {} }), null);
});

test('parseProfileHtml reads counts from the meta description', async () => {
    const { parseProfileHtml, parseCount } = await import('../src/parse.js');
    assert.equal(parseCount('12.3K'), 12300);
    assert.equal(parseCount('1,234'), 1234);
    assert.equal(parseCount('2M'), 2000000);
    const html = '<meta property="og:description" content="101K Followers, 52 Following, 566 Posts - See Instagram photos and videos from Glimsera (@glimsera)" />';
    const p = parseProfileHtml(html, 'Glimsera');
    assert.equal(p.followers, 101000);
    assert.equal(p.following, 52);
    assert.equal(p.postsCount, 566);
    assert.equal(parseProfileHtml('<html></html>', 'x'), null);
});

test('embed pages: contextJSON, shortcodes, post and profile rows', async () => {
    const { extractContextJSON, extractShortcodes, parseEmbedPost, parseEmbedProfile } = await import('../src/parse.js');
    const media = {
        __typename: 'GraphVideo', shortcode: 'DOyG4W8kmaO', is_video: true, product_type: 'clips',
        video_view_count: 4966450, video_duration: 15.534,
        edge_media_to_caption: { edges: [{ node: { text: 'You want to try? 😍\n\nBlush hack #blush' } }] },
        edge_media_to_comment: { count: 215 }, edge_liked_by: { count: 91124 },
        clips_music_attribution_info: { artist_name: 'sma$her, MXZI', song_name: 'ACELERADA' },
        taken_at_timestamp: 1789743245, owner: { id: '1', username: 'glimsera' },
    };
    const ctx = { context: { type: 'GraphVideo', shortcode: 'DOyG4W8kmaO' }, gql_data: { shortcode_media: media } };
    // As it appears in the page: a JSON string inside a JSON blob, slashes escaped.
    const literal = JSON.stringify(JSON.stringify(ctx)).slice(1, -1).replace(/\//g, '\\/');
    const html = `<script>s.handle({"isRichEmbed":true,"contextJSON":"${literal}","x":1})</script>`
        + '<a class="Likes" href="#">91,124 likes</a>' + 'x'.repeat(10);
    assert.equal(extractContextJSON(html).gql_data.shortcode_media.video_view_count, 4966450);

    const row = parseEmbedPost(html, { username: 'glimsera', followers: 99995 });
    assert.equal(row.type, 'reel');
    assert.equal(row.views, 4966450);
    assert.equal(row.likes, 91124);
    assert.equal(row.comments, 215);
    assert.equal(row.viewsPerFollower, 49.67);
    assert.equal(row.audio, 'sma$her, MXZI - ACELERADA');
    assert.deepEqual(row.hashtags, ['#blush']);
    assert.equal(parseEmbedPost('<html>nothing</html>'), null);

    const pctx = { context: { username: 'Glimsera', full_name: 'Glimsera', followers_count: 99995, posts_count: 566 } };
    const phtml = `{"contextJSON":"${JSON.stringify(JSON.stringify(pctx)).slice(1, -1)}"}`;
    const p = parseEmbedProfile(phtml);
    assert.equal(p.followers, 99995);
    assert.equal(p.postsCount, 566);

    const codes = extractShortcodes('href="/p/DdbsklMmUiu/" "url":"\\/reel\\/DOyG4W8kmaO\\/" /reel/DOyG4W8kmaO/ /p/DdbsklMmUiu', 12);
    assert.deepEqual(codes.map((c) => c.shortcode), ['DdbsklMmUiu', 'DOyG4W8kmaO']);
});

test('withheld counts are reported as unknown, not zero', async () => {
    const { parseEmbedPost } = await import('../src/parse.js');
    const media = { __typename: 'GraphVideo', shortcode: 'DXzNA1WB3JT', is_video: true, product_type: 'clips',
        edge_liked_by: { count: 0 }, edge_media_to_comment: { count: 3 } };
    const lit = JSON.stringify(JSON.stringify({ gql_data: { shortcode_media: media } })).slice(1, -1);
    const row = parseEmbedPost(`{"contextJSON":"${lit}"}`, { username: 'glimsera', followers: 99995 });
    assert.equal(row.countsHidden, true);
    assert.equal(row.likes, null);
    assert.equal(row.views, null);
    assert.equal(row.comments, 3);
});

test('post date is decoded from the shortcode', async () => {
    const { dateFromShortcode } = await import('../src/parse.js');
    // Instagram reported taken_at_timestamp 1789743245 for this carousel.
    assert.equal(dateFromShortcode('DdbsklMmUiu').slice(0, 19), new Date(1789743245 * 1000).toISOString().slice(0, 19));
    assert.equal(dateFromShortcode('DOyG4W8kmaO').slice(0, 10), '2025-09-19');
    assert.equal(dateFromShortcode('!!'), null);
});

test('carousel children and video url are kept', async () => {
    const { parseEmbedPost } = await import('../src/parse.js');
    const media = { __typename: 'GraphSidecar', shortcode: 'C4r0usel', edge_liked_by: { count: 50 }, edge_media_to_comment: { count: 2 },
        edge_sidecar_to_children: { edges: [{ node: { display_url: 'https://x/1.jpg', is_video: false } }, { node: { display_url: 'https://x/2.jpg', is_video: true, video_url: 'https://x/2.mp4' } }] } };
    const lit = JSON.stringify(JSON.stringify({ gql_data: { shortcode_media: media } })).slice(1, -1);
    const row = parseEmbedPost(`{"contextJSON":"${lit}"}`, { username: 'a', followers: 100 });
    assert.equal(row.type, 'carousel');
    assert.equal(row.children.length, 2);
    assert.equal(row.children[1].videoUrl, 'https://x/2.mp4');
});
