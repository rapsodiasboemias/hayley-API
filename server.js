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
