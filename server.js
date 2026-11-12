const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

const RAPIDAPI_HOST = 'instagram-looter2.p.rapidapi.com';

// Cache de 6 horas para economizar requisições e acelerar blogs de fãs/source blogs
const postsCache = new Map();
const userIdCache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000; 

app.get('/', (req, res) => {
    res.json({ status: 'online', message: 'API Proxy Instagram (Source Blogs Ready) ativa' });
});

// Função auxiliar para extrair imagem de qualquer formato de post (Foto, Carrossel ou Reel)
function extractImageUrl(item) {
    if (!item) return null;

    // 1. Se for Carrossel (álbum), olha o primeiro slide
    if (Array.isArray(item.carousel_media) && item.carousel_media.length > 0) {
        const firstSlide = item.carousel_media[0];
        if (firstSlide.image_versions2?.candidates?.[0]?.url) {
            return firstSlide.image_versions2.candidates[0].url;
        }
    }

    // 2. Se for Foto única ou capa padrão de Reel/Vídeo
    if (item.image_versions2?.candidates?.[0]?.url) {
        return item.image_versions2.candidates[0].url;
    }

    // 3. Fallback para capas alternativas de vídeos/clips
    if (item.cover_frame_url) return item.cover_frame_url;
    if (item.thumbnail_url) return item.thumbnail_url;

    return null;
}

app.get('/api/latest-post', async (req, res) => {
    const { username } = req.query;

    if (!username) {
        return res.status(400).json({ error: 'Username é obrigatório.' });
    }

    const cleanUser = username.trim().toLowerCase().replace(/^@/, '');

    // Verifica cache
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
        'x-rapidapi-host': RAPIDAPI_HOST
    };

    try {
        // 1. Obtém o ID numérico do usuário (com timeout maior para contas grandes)
        let userId = userIdCache.get(cleanUser);

        if (!userId) {
            const profileRes = await axios.get(`https://${RAPIDAPI_HOST}/profile`, {
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

        // 2. Busca os 6 primeiros itens (ignora posts fixados antigos se houver um novo logo abaixo)
        const feedRes = await axios.get(`https://${RAPIDAPI_HOST}/user-feeds`, {
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

        // 3. Tenta encontrar o post mais recente que NÃO seja fixado (pinned)
        // Se todos forem fixados ou não houver flag, pega o primeiro com imagem válida
        let selectedItem = items.find(item => {
            const isPinned = Array.isArray(item.timeline_pinned_user_ids) && item.timeline_pinned_user_ids.length > 0;
            return !isPinned && extractImageUrl(item) !== null;
        });

        // Fallback: se não achou nenhum não-fixado, pega o primeiro item absoluto que tenha imagem
        if (!selectedItem) {
            selectedItem = items.find(item => extractImageUrl(item) !== null);
        }

        if (!selectedItem) {
            return res.status(404).json({ error: 'Não foi possível extrair a imagem das postagens recentes.' });
        }

        const rawImageUrl = extractImageUrl(selectedItem);
        const caption = selectedItem.caption?.text || `Última publicação de @${cleanUser}`;
        const postCode = selectedItem.code;
        const permalink = postCode 
            ? `https://www.instagram.com/p/${postCode}/` 
            : `https://www.instagram.com/${cleanUser}/`;

        // Proxy de imagem para evitar bloqueio CORS/CORP no Tumblr
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
        console.error(`Erro ao buscar @${cleanUser}:`, error.response?.status, error.message);
        return res.status(500).json({ 
            error: 'Não foi possível carregar o post.',
            status_code: error.response?.status || 500
        });
    }
});

// Rota proxy de imagem
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

// ==========================================
// ROTA TWITTER / X (/api/latest-tweet)
// ==========================================

const TWITTER_RAPIDAPI_HOST = 'twitter241.p.rapidapi.com'; // Assine o plano gratuito (Basic) no RapidAPI
const tweetsCache = new Map();

// Função auxiliar para buscar via endpoint público de Syndication (Fallback sem API Key)
async function fetchTweetViaSyndication(cleanUser) {
    const url = `https://syndication.twimg.com/srv/timeline-profile/screen-name/${cleanUser}`;
    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml'
        },
        timeout: 15000
    });

    const html = response.data;
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match) return null;

    const nextData = JSON.parse(match[1]);
    const entries = nextData?.props?.pageProps?.timeline?.entries || [];

    const tweets = entries
        .filter(entry => entry.type === 'tweet' && entry.content?.tweet)
        .map(entry => entry.content.tweet);

    if (tweets.length === 0) return null;

    // Prioriza post original (não retweet e não resposta)
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

app.get('/api/latest-tweet', async (req, res) => {
    const { username } = req.query;

    if (!username) {
        return res.status(400).json({ error: 'Username é obrigatório.' });
    }

    const cleanUser = username.trim().toLowerCase().replace(/^@/, '');

    // 1. Verifica cache em memória
    const cachedTweet = tweetsCache.get(cleanUser);
    if (cachedTweet && (Date.now() - cachedTweet.timestamp < CACHE_TTL)) {
        return res.json(cachedTweet.data);
    }

    const apiKey = process.env.RAPIDAPI_KEY;
    const hostUrl = `https://${req.get('host')}`;

    try {
        let tweetData = null;

        // 2. Tenta primeiro via RapidAPI (mais estável contra bloqueios de IP da Render)
        if (apiKey) {
            try {
                // Passo A: Busca dados do usuário para obter o rest_id
                const userRes = await axios.get(`https://${TWITTER_RAPIDAPI_HOST}/user`, {
                    params: { username: cleanUser },
                    headers: {
                        'x-rapidapi-key': apiKey,
                        'x-rapidapi-host': TWITTER_RAPIDAPI_HOST
                    },
                    timeout: 15000
                });

                const userResult = userRes.data?.result?.data?.user?.result;
                const restId = userResult?.rest_id;
                const displayName = userResult?.legacy?.name || cleanUser;

                if (restId) {
                    // Passo B: Busca os tweets recentes do usuário
                    const tweetsRes = await axios.get(`https://${TWITTER_RAPIDAPI_HOST}/user-tweets`, {
                        params: { user: restId, count: 10 },
                        headers: {
                            'x-rapidapi-key': apiKey,
                            'x-rapidapi-host': TWITTER_RAPIDAPI_HOST
                        },
                        timeout: 15000
                    });

                    // Extrai instruções da timeline (padrão GraphQL do X)
                    const instructions = tweetsRes.data?.result?.timeline?.instructions || [];
                    const addEntries = instructions.find(i => i.type === 'TimelineAddEntries')?.entries || [];

                    const parsedTweets = addEntries
                        .map(entry => entry.content?.itemContent?.tweet_results?.result)
                        .filter(t => t && (t.legacy || t.tweet?.legacy))
                        .map(t => t.legacy ? t : t.tweet);

                    // Filtra para ignorar retweets e respostas diretas
                    let selected = parsedTweets.find(t => {
                        const leg = t.legacy;
                        const isRetweet = Boolean(leg.retweeted_status_result) || leg.full_text?.startsWith('RT @');
                        const isReply = Boolean(leg.in_reply_to_screen_name);
                        return !isRetweet && !isReply;
                    });

                    // Fallback: se só houver retweets/respostas, pega o mais recente
                    if (!selected && parsedTweets.length > 0) {
                        selected = parsedTweets[0];
                    }

                    if (selected) {
                        const leg = selected.legacy;
                        const rawMedia = leg.extended_entities?.media?.[0]?.media_url_https 
                                      || leg.entities?.media?.[0]?.media_url_https 
                                      || null;

                        // Remove o link t.co final que o X anexa quando há mídia/quote
                        const cleanText = (leg.full_text || '').replace(/https:\/\/t\.co\/\w+$/g, '').trim();

                        tweetData = {
                            username: cleanUser,
                            name: displayName,
                            text: cleanText,
                            media_url: rawMedia,
                            created_at: leg.created_at || null,
                            permalink: `https://x.com/${cleanUser}/status/${leg.id_str}`
                        };
                    }
                }
            } catch (rapidErr) {
                console.warn(`RapidAPI Twitter falhou para @${cleanUser}, tentando fallback...`, rapidErr.message);
            }
        }

        // 3. Fallback: Endpoint de Syndication caso RapidAPI falhe ou atinja limite
        if (!tweetData) {
            tweetData = await fetchTweetViaSyndication(cleanUser);
        }

        if (!tweetData) {
            return res.status(404).json({ error: 'Não foi possível encontrar tweets públicos para este perfil.' });
        }

        // Passa a imagem pelo proxy existente para evitar bloqueios de carregamento no Tumblr
        if (tweetData.media_url) {
            tweetData.media_url = `${hostUrl}/api/image-proxy?url=${encodeURIComponent(tweetData.media_url)}`;
        }

        tweetsCache.set(cleanUser, { timestamp: Date.now(), data: tweetData });
        return res.json(tweetData);

    } catch (error) {
        console.error(`Erro geral ao buscar tweet de @${cleanUser}:`, error.message);
        return res.status(500).json({ error: 'Erro interno ao carregar o tweet.' });
    }
});
