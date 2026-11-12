const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

const IG_RAPIDAPI_HOST = 'instagram-looter2.p.rapidapi.com';
const TWITTER_RAPIDAPI_HOST = 'twitter-api45.p.rapidapi.com';
const TIKTOK_RAPIDAPI_HOST = 'tiktok-scraper7.p.rapidapi.com';
const THREADS_RAPIDAPI_HOST = 'threads-api4.p.rapidapi.com';

// Cache de 12 horas para economizar requisições na cota gratuita
const postsCache = new Map();
const userIdCache = new Map();
const tweetsCache = new Map();
const youtubeCache = new Map();
const youtubeIdCache = new Map();
const tiktokCache = new Map();
const threadsCache = new Map();
const CACHE_TTL = 12 * 60 * 60 * 1000;

// Limpeza automática de cache expirado a cada 6 horas
setInterval(() => {
    const now = Date.now();
    [postsCache, tweetsCache, youtubeCache, tiktokCache, threadsCache].forEach(cache => {
        for (const [key, value] of cache.entries()) {
            if (now - value.timestamp >= CACHE_TTL) {
                cache.delete(key);
            }
        }
    });
}, 6 * 60 * 60 * 1000);

app.get('/', (req, res) => {
    res.json({
        status: 'online',
        message: 'API Proxy Source Blogs Ready (IG, X, YT, TikTok, Threads) ativa'
    });
});

// ==========================================
// FUNÇÕES AUXILIARES
// ==========================================

function extractInstagramImageUrl(item) {
    if (!item) return null;

    if (Array.isArray(item.carousel_media) && item.carousel_media.length > 0) {
        const firstSlide = item.carousel_media[0];
        if (firstSlide.image_versions2?.candidates?.[0]?.url) {
            return firstSlide.image_versions2.candidates[0].url;
        }
    }

    if (item.image_versions2?.candidates?.[0]?.url) {
        return item.image_versions2.candidates[0].url;
    }

    if (item.cover_frame_url) return item.cover_frame_url;
    if (item.thumbnail_url) return item.thumbnail_url;

    return null;
}

async function fetchTweetViaSyndication(cleanUser) {
    const url = `https://syndication.twimg.com/srv/timeline-profile/screen-name/${cleanUser}`;
    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml'
        },
        timeout: 15000
    });

    const match = response.data.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match) return null;

    const nextData = JSON.parse(match[1]);
    const entries = nextData?.props?.pageProps?.timeline?.entries || [];

    const tweets = entries
        .filter(entry => entry.type === 'tweet' && entry.content?.tweet)
        .map(entry => entry.content.tweet);

    if (tweets.length === 0) return null;

    let selected = tweets.find(t => !t.retweeted_status && !t.in_reply_to_screen_name && !t.full_text?.startsWith('RT @'));
    if (!selected) selected = tweets[0];

    const rawMedia = selected.entities?.media?.[0]?.media_url_https || null;
    const cleanText = (selected.full_text || selected.text || '').replace(/https:\/\/t\.co\/\w+$/g, '').trim();

    return {
        username: selected.user?.screen_name || cleanUser,
        name: selected.user?.name || cleanUser,
        text: cleanText,
        media_url: rawMedia,
        created_at: selected.created_at || null,
        permalink: `https://x.com/${cleanUser}/status/${selected.id_str}`
    };
}

async function resolveYoutubeChannelId(input) {
    const clean = input.trim();
    if (/^UC[\w-]{22}$/.test(clean)) return clean;

    const cachedId = youtubeIdCache.get(clean.toLowerCase());
    if (cachedId) return cachedId;

    const handle = clean.startsWith('@') ? clean : `@${clean}`;
    const res = await axios.get(`https://www.youtube.com/${encodeURI(handle)}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
        },
        timeout: 15000
    });

    const match = res.data.match(/"externalId":"(UC[\w-]{22})"/);
    if (match && match[1]) {
        youtubeIdCache.set(clean.toLowerCase(), match[1]);
        return match[1];
    }
    return null;
}

function decodeXmlEntities(str) {
    if (!str) return '';
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

// ==========================================
// ROTA INSTAGRAM (/api/latest-post)
// ==========================================

app.get('/api/latest-post', async (req, res) => {
    const { username } = req.query;

    if (!username) {
        return res.status(400).json({ error: 'Username é obrigatório.' });
    }

    const cleanUser = username.trim().toLowerCase().replace(/^@/, '');

    const cachedPost = postsCache.get(cleanUser);
    if (cachedPost && (Date.now() - cachedPost.timestamp < CACHE_TTL)) {
        return res.json(cachedPost.data);
    }

    const apiKey = process.env.RAPIDAPI_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'Variável RAPIDAPI_KEY não configurada na Render.' });
    }

    const headers = {
        'x-rapidapi-key': apiKey,
        'x-rapidapi-host': IG_RAPIDAPI_HOST
    };

    try {
        let userId = userIdCache.get(cleanUser);

        if (!userId) {
            const profileRes = await axios.get(`https://${IG_RAPIDAPI_HOST}/profile`, {
                params: { username: cleanUser },
                headers,
                timeout: 25000
            });

            userId = profileRes.data?.id || profileRes.data?.user?.id;
            if (!userId) {
                return res.status(404).json({ error: 'Usuário não encontrado.' });
            }
            userIdCache.set(cleanUser, String(userId));
        }

        const feedRes = await axios.get(`https://${IG_RAPIDAPI_HOST}/user-feeds`, {
            params: {
                id: userId,
                count: 6,
                allow_restricted_media: false
            },
            headers,
            timeout: 25000
        });

        const items = feedRes.data?.items;
        if (!items || items.length === 0) {
            return res.status(404).json({ error: 'Nenhuma postagem encontrada ou perfil privado.' });
        }

        let selectedItem = items.find(item => {
            const isPinned = Array.isArray(item.timeline_pinned_user_ids) && item.timeline_pinned_user_ids.length > 0;
            return !isPinned && extractInstagramImageUrl(item) !== null;
        });

        if (!selectedItem) {
            selectedItem = items.find(item => extractInstagramImageUrl(item) !== null);
        }

        if (!selectedItem) {
            return res.status(404).json({ error: 'Não foi possível extrair a imagem das postagens recentes.' });
        }

        const rawImageUrl = extractInstagramImageUrl(selectedItem);
        const caption = selectedItem.caption?.text || `Última publicação de @${cleanUser}`;
        const postCode = selectedItem.code;
        const permalink = postCode
            ? `https://www.instagram.com/p/${postCode}/`
            : `https://www.instagram.com/${cleanUser}/`;

        const hostUrl = `https://${req.get('host')}`;
        const proxiedImageUrl = `${hostUrl}/api/image-proxy?url=${encodeURIComponent(rawImageUrl)}`;

        const resultData = {
            username: cleanUser,
            media_url: proxiedImageUrl,
            caption: caption,
            permalink: permalink
        };

        postsCache.set(cleanUser, { timestamp: Date.now(), data: resultData });
        return res.json(resultData);

    } catch (error) {
        console.error(`Erro ao buscar Instagram @${cleanUser}:`, error.response?.status, error.message);
        return res.status(500).json({
            error: 'Não foi possível carregar o post.',
            status_code: error.response?.status || 500
        });
    }
});

// ==========================================
// ROTA TWITTER / X (/api/latest-tweet)
// ==========================================

app.get('/api/latest-tweet', async (req, res) => {
    const { username } = req.query;

    if (!username) {
        return res.status(400).json({ error: 'Username é obrigatório.' });
    }

    const cleanUser = username.trim().toLowerCase().replace(/^@/, '');

    const cachedTweet = tweetsCache.get(cleanUser);
    if (cachedTweet && (Date.now() - cachedTweet.timestamp < CACHE_TTL)) {
        return res.json(cachedTweet.data);
    }

    const apiKey = process.env.RAPIDAPI_KEY;
    const hostUrl = `https://${req.get('host')}`;

    try {
        let tweetData = null;

        if (apiKey) {
            try {
                const timelineRes = await axios.get(`https://${TWITTER_RAPIDAPI_HOST}/timeline.php`, {
                    params: { screenname: cleanUser },
                    headers: {
                        'x-rapidapi-key': apiKey,
                        'x-rapidapi-host': TWITTER_RAPIDAPI_HOST
                    },
                    timeout: 20000
                });

                const rawData = timelineRes.data || {};
                const timeline = Array.isArray(rawData.timeline) ? rawData.timeline : [];
                const userInfo = rawData.user || {};

                if (timeline.length === 0 && rawData.pinned) {
                    timeline.push(rawData.pinned);
                }

                if (timeline.length > 0) {
                    let selected = timeline.find(t => {
                        if (!t || !t.text) return false;
                        const isRetweet = Boolean(t.retweeted_tweet || t.retweeted) || t.text.startsWith('RT @');
                        const isReply = Boolean(t.in_reply_to_screen_name || t.in_reply_to_status_id_str);
                        return !isRetweet && !isReply;
                    });

                    if (!selected) {
                        selected = timeline.find(t => t && (t.text || t.media));
                    }

                    if (selected) {
                        const rawMedia = selected.media?.photo?.[0]?.media_url_https
                                      || selected.media?.video?.[0]?.media_url_https
                                      || null;

                        const cleanText = (selected.text || '').replace(/https:\/\/t\.co\/\w+$/g, '').trim();
                        const tweetId = selected.tweet_id || selected.id_str;
                        const officialHandle = userInfo.screen_name || selected.user_info?.screen_name || cleanUser;

                        tweetData = {
                            username: officialHandle,
                            name: userInfo.name || selected.user_info?.name || officialHandle,
                            text: cleanText,
                            media_url: rawMedia,
                            created_at: selected.created_at || null,
                            permalink: tweetId
                                ? `https://x.com/${officialHandle}/status/${tweetId}`
                                : `https://x.com/${officialHandle}`
                        };
                    }
                }
            } catch (rapidErr) {
                console.warn(`Twitter API45 falhou para @${cleanUser}:`, rapidErr.response?.status, rapidErr.message);
            }
        }

        if (!tweetData) {
            tweetData = await fetchTweetViaSyndication(cleanUser);
        }

        if (!tweetData) {
            return res.status(404).json({ error: 'Não foi possível encontrar tweets públicos para este perfil.' });
        }

        if (tweetData.media_url) {
            tweetData.media_url = `${hostUrl}/api/image-proxy?url=${encodeURIComponent(tweetData.media_url)}`;
        }

        tweetsCache.set(cleanUser, { timestamp: Date.now(), data: tweetData });
        return res.json(tweetData);

    } catch (error) {
        const status = error.response?.status || 500;
        const detail = error.response?.data || error.message;
        console.error(`Erro geral ao buscar tweet de @${cleanUser}:`, status, detail);
        return res.status(status).json({
            error: 'Erro interno ao carregar o tweet.',
            status_code: status,
            details: detail
        });
    }
});

// ==========================================
// ROTA YOUTUBE (/api/latest-youtube) - 100% GRATUITA VIA RSS OFICIAL
// ==========================================

app.get('/api/latest-youtube', async (req, res) => {
    const { channel } = req.query;
    if (!channel) {
        return res.status(400).json({ error: 'Parâmetro channel (ID UC... ou @handle) é obrigatório.' });
    }

    const cacheKey = channel.trim().toLowerCase();
    const cached = youtubeCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        return res.json(cached.data);
    }

    try {
        const channelId = await resolveYoutubeChannelId(channel);
        if (!channelId) {
            return res.status(404).json({ error: 'Canal do YouTube não encontrado.' });
        }

        const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
        const feedRes = await axios.get(feedUrl, { timeout: 15000 });
        const xml = feedRes.data;

        const authorMatch = xml.match(/<author>\s*<name>([\s\S]*?)<\/name>/);
        const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);

        if (!entryMatch) {
            return res.status(404).json({ error: 'Nenhum vídeo encontrado neste canal.' });
        }

        const entry = entryMatch[1];
        const videoIdMatch = entry.match(/<yt:videoId>([\s\S]*?)<\/yt:videoId>/);
        const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
        const publishedMatch = entry.match(/<published>([\s\S]*?)<\/published>/);

        if (!videoIdMatch) {
            return res.status(404).json({ error: 'Não foi possível extrair o ID do vídeo.' });
        }

        const videoId = videoIdMatch[1].trim();
        const hostUrl = `https://${req.get('host')}`;
        const rawThumb = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

        const resultData = {
            channel_id: channelId,
            channel_name: authorMatch ? decodeXmlEntities(authorMatch[1].trim()) : channel,
            video_id: videoId,
            title: titleMatch ? decodeXmlEntities(titleMatch[1].trim()) : 'Último vídeo',
            thumbnail_url: `${hostUrl}/api/image-proxy?url=${encodeURIComponent(rawThumb)}`,
            published_at: publishedMatch ? publishedMatch[1].trim() : null,
            permalink: `https://www.youtube.com/watch?v=${videoId}`
        };

        youtubeCache.set(cacheKey, { timestamp: Date.now(), data: resultData });
        return res.json(resultData);

    } catch (error) {
        console.error(`Erro YouTube (${channel}):`, error.message);
        return res.status(500).json({ error: 'Falha ao carregar feed do YouTube.' });
    }
});

// ==========================================
// ROTA TIKTOK (/api/latest-tiktok) - VIA RAPIDAPI (tiktok-scraper7)
// ==========================================

app.get('/api/latest-tiktok', async (req, res) => {
    const { username } = req.query;
    if (!username) {
        return res.status(400).json({ error: 'Username é obrigatório.' });
    }

    const cleanUser = username.trim().toLowerCase().replace(/^@/, '');
    const cached = tiktokCache.get(cleanUser);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        return res.json(cached.data);
    }

    const apiKey = process.env.RAPIDAPI_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'Variável RAPIDAPI_KEY não configurada.' });
    }

    try {
        const response = await axios.get(`https://${TIKTOK_RAPIDAPI_HOST}/user/posts`, {
            params: {
                unique_id: cleanUser,
                count: 5
            },
            headers: {
                'x-rapidapi-key': apiKey,
                'x-rapidapi-host': TIKTOK_RAPIDAPI_HOST
            },
            timeout: 25000
        });

        const videos = response.data?.data?.videos || [];
        if (!Array.isArray(videos) || videos.length === 0) {
            return res.status(404).json({ error: 'Nenhum TikTok público encontrado.' });
        }

        let selected = videos.find(v => !v.is_top) || videos[0];
        const rawCover = selected.cover || selected.origin_cover || selected.ai_dynamic_cover || null;
        const videoId = selected.video_id || selected.id;
        const hostUrl = `https://${req.get('host')}`;

        const resultData = {
            username: selected.author?.unique_id || cleanUser,
            nickname: selected.author?.nickname || cleanUser,
            caption: (selected.title || `Último TikTok de @${cleanUser}`).trim(),
            cover_url: rawCover ? `${hostUrl}/api/image-proxy?url=${encodeURIComponent(rawCover)}` : null,
            play_count: selected.play_count || 0,
            permalink: videoId
                ? `https://www.tiktok.com/@${cleanUser}/video/${videoId}`
                : `https://www.tiktok.com/@${cleanUser}`
        };

        tiktokCache.set(cleanUser, { timestamp: Date.now(), data: resultData });
        return res.json(resultData);

    } catch (error) {
        console.error(`Erro TikTok @${cleanUser}:`, error.response?.status, error.message);
        return res.status(500).json({ error: 'Não foi possível carregar o último TikTok.' });
    }
});

// ==========================================
// ROTA THREADS (/api/latest-threads) - VIA RAPIDAPI (threads-api4)
// ==========================================

app.get('/api/latest-threads', async (req, res) => {
    const { username } = req.query;
    if (!username) {
        return res.status(400).json({ error: 'Username é obrigatório.' });
    }

    const cleanUser = username.trim().toLowerCase().replace(/^@/, '');
    const cached = threadsCache.get(cleanUser);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        return res.json(cached.data);
    }

    const apiKey = process.env.RAPIDAPI_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'Variável RAPIDAPI_KEY não configurada.' });
    }

    try {
        const response = await axios.get(`https://${THREADS_RAPIDAPI_HOST}/api/user/posts`, {
            params: { username: cleanUser },
            headers: {
                'x-rapidapi-key': apiKey,
                'x-rapidapi-host': THREADS_RAPIDAPI_HOST
            },
            timeout: 25000
        });

        const threadsList = response.data?.data?.mediaData?.threads || response.data?.threads || [];
        if (!Array.isArray(threadsList) || threadsList.length === 0) {
            return res.status(404).json({ error: 'Nenhuma publicação encontrada no Threads.' });
        }

        const firstThread = threadsList[0];
        const post = firstThread?.thread_items?.[0]?.post || firstThread;

        const captionText = post?.caption?.text || '';
        const postCode = post?.code;

        let rawMedia = null;
        if (Array.isArray(post?.carousel_media) && post.carousel_media.length > 0) {
            rawMedia = post.carousel_media[0]?.image_versions2?.candidates?.[0]?.url || null;
        } else if (post?.image_versions2?.candidates?.[0]?.url) {
            rawMedia = post.image_versions2.candidates[0].url;
        }

        const hostUrl = `https://${req.get('host')}`;

        const resultData = {
            username: post?.user?.username || cleanUser,
            text: captionText || `Nova atualização de @${cleanUser} no Threads`,
            media_url: rawMedia ? `${hostUrl}/api/image-proxy?url=${encodeURIComponent(rawMedia)}` : null,
            permalink: postCode
                ? `https://www.threads.net/@${cleanUser}/post/${postCode}`
                : `https://www.threads.net/@${cleanUser}`
        };

        threadsCache.set(cleanUser, { timestamp: Date.now(), data: resultData });
        return res.json(resultData);

    } catch (error) {
        console.error(`Erro Threads @${cleanUser}:`, error.response?.status, error.message);
        return res.status(500).json({ error: 'Não foi possível carregar o último post do Threads.' });
    }
});

// ==========================================
// PROXY DE IMAGEM (/api/image-proxy)
// ==========================================

app.get('/api/image-proxy', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('URL obrigatória');

    try {
        const parsed = new URL(url);
        const referer = parsed.hostname.includes('tiktok')
            ? 'https://www.tiktok.com/'
            : 'https://www.instagram.com/';

        const response = await axios.get(url, {
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
                'Referer': referer
            },
            timeout: 15000
        });

        res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        response.data.pipe(res);
    } catch (err) {
        res.status(500).send('Erro ao carregar imagem');
    }
});

// ==========================================
// INICIALIZAÇÃO DO SERVIDOR
// ==========================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
