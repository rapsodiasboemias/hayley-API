const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

const RAPIDAPI_HOST = 'instagram-looter2.p.rapidapi.com';

// Cache para economizar suas 150 requisições mensais gratuitas
const postsCache = new Map();
const userIdCache = new Map(); // Guarda a relação username -> id numérico
const CACHE_TTL = 60 * 60 * 1000; // 60 minutos

app.get('/', (req, res) => {
    res.json({ status: 'online', message: 'API Proxy Instagram (RapidAPI) ativa' });
});

app.get('/api/latest-post', async (req, res) => {
    const { username } = req.query;

    if (!username) {
        return res.status(400).json({ error: 'Username é obrigatório.' });
    }

    const cleanUser = username.trim().toLowerCase().replace(/^@/, '');

    // 1. Verifica se o post já está no cache recente
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
        // 2. Descobre o ID numérico do usuário (usa cache se já tiver consultado antes)
        let userId = userIdCache.get(cleanUser);

        if (!userId) {
            const profileRes = await axios.get(`https://${RAPIDAPI_HOST}/profile`, {
                params: { username: cleanUser },
                headers,
                timeout: 15000
            });

            userId = profileRes.data?.id;
            if (!userId) {
                return res.status(404).json({ error: 'Usuário não encontrado.' });
            }
            userIdCache.set(cleanUser, userId);
        }

        // 3. Busca os posts usando o ID numérico
        const feedRes = await axios.get(`https://${RAPIDAPI_HOST}/user-feeds`, {
            params: {
                id: userId,
                count: 1,
                allow_restricted_media: false
            },
            headers,
            timeout: 15000
        });

        const items = feedRes.data?.items;
        if (!items || items.length === 0) {
            return res.status(404).json({ error: 'Nenhuma postagem encontrada ou perfil privado.' });
        }

        // 4. Extrai a imagem, legenda e link do post mais recente (items[0])
        const latestItem = items[0];
        
        // Caso o post seja um carrossel (album), pega a imagem do primeiro slide; senão, pega do próprio post
        const mediaSource = latestItem.carousel_media ? latestItem.carousel_media[0] : latestItem;
        const rawImageUrl = mediaSource.image_versions2?.candidates?.[0]?.url;

        if (!rawImageUrl) {
            return res.status(404).json({ error: 'Não foi possível extrair a URL da imagem.' });
        }

        const caption = latestItem.caption?.text || `Última publicação de @${cleanUser}`;
        const postCode = latestItem.code;
        const permalink = postCode 
            ? `https://www.instagram.com/p/${postCode}/` 
            : `https://www.instagram.com/${cleanUser}/`;

        // Roteia a imagem pelo proxy local para evitar bloqueio de CORS/CORP no Tumblr
        const hostUrl = `https://${req.get('host')}`;
        const proxiedImageUrl = `${hostUrl}/api/image-proxy?url=${encodeURIComponent(rawImageUrl)}`;

        const resultData = {
            username: cleanUser,
            media_url: proxiedImageUrl,
            caption: caption,
            permalink: permalink
        };

        // Salva no cache de posts
        postsCache.set(cleanUser, { timestamp: Date.now(), data: resultData });

        return res.json(resultData);

    } catch (error) {
        console.error('Erro na RapidAPI:', error.response?.status, error.message);
        return res.status(500).json({ 
            error: 'Não foi possível carregar o post.',
            status_code: error.response?.status || 500
        });
    }
});

// Rota proxy para carregar a imagem sem bloqueios no navegador
app.get('/api/image-proxy', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('URL obrigatória');

    try {
        const response = await axios.get(url, {
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            }
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
