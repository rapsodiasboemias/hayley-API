const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

// Cache simples em memória para evitar requisições repetidas e proteger a conta
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutos

app.get('/', (req, res) => {
    res.json({ status: 'online', message: 'API Proxy do Instagram ativa' });
});

// Rota 1: Busca os dados do último post de qualquer perfil público
app.get('/api/latest-post', async (req, res) => {
    const { username } = req.query;

    if (!username) {
        return res.status(400).json({ error: 'Username é obrigatório.' });
    }

    const cleanUser = username.trim().toLowerCase().replace(/^@/, '');

    // Verifica se já existe uma resposta recente no cache
    const cached = cache.get(cleanUser);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        return res.json(cached.data);
    }

    const sessionId = process.env.IG_SESSION_ID;
    if (!sessionId) {
        return res.status(500).json({ error: 'Variável IG_SESSION_ID não configurada na Render.' });
    }

    try {
        const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(cleanUser)}`;
        
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'x-ig-app-id': '936619743392459',
                'Cookie': `sessionid=${sessionId};`,
                'Accept': '*/*',
                'Referer': `https://www.instagram.com/${cleanUser}/`
            },
            timeout: 8000
        });

        const user = response.data?.data?.user;
        const edges = user?.edge_owner_to_timeline_media?.edges;

        if (!edges || edges.length === 0) {
            return res.status(404).json({ error: 'Nenhuma postagem encontrada ou perfil privado.' });
        }

        const latestPost = edges[0].node;
        const caption = latestPost.edge_media_to_caption?.edges[0]?.node?.text || '';
        
        // Gera a URL passando pelo nosso proxy de imagem para evitar bloqueio de CORS no Tumblr
        const hostUrl = `${req.protocol}://${req.get('host')}`;
        const proxiedImageUrl = `${hostUrl}/api/image-proxy?url=${encodeURIComponent(latestPost.display_url)}`;

        const resultData = {
            username: cleanUser,
            media_url: proxiedImageUrl,
            original_media_url: latestPost.display_url,
            caption: caption,
            permalink: `https://www.instagram.com/p/${latestPost.shortcode}/`
        };

        // Salva no cache
        cache.set(cleanUser, { timestamp: Date.now(), data: resultData });

        return res.json(resultData);

    } catch (error) {
        console.error('Erro na API do Instagram:', error.response?.status, error.message);
        return res.status(500).json({ 
            error: 'Não foi possível carregar o post.',
            status_code: error.response?.status || 500
        });
    }
});

// Rota 2: Proxy de imagem para contornar o bloqueio Cross-Origin do Instagram nos navegadores
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
        res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache no navegador por 24h
        response.data.pipe(res);
    } catch (err) {
        res.status(500).send('Erro ao carregar imagem');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
