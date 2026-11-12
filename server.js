const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

const IG_RAPIDAPI_HOST = 'instagram-looter2.p.rapidapi.com';
const TWITTER_RAPIDAPI_HOST = 'twitter-api45.p.rapidapi.com';

// Cache de 12 horas para economizar requisições na cota gratuita
const postsCache = new Map();
const userIdCache = new Map();
const tweetsCache = new Map();
const CACHE_TTL = 12 * 60 * 60 * 1000;

app.get('/', (req, res) => {
    res.json({
        status: 'online',
        message: 'API Proxy Instagram & Twitter/X (Source Blogs Ready) ativa'
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
// PROXY DE IMAGEM (/api/image-proxy)
// ==========================================

app.get('/api/image-proxy', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('URL obrigatória');

    try {
        const response = await axios.get(url, {
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
