const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

// Cache em memória de 60 minutos para economizar seus créditos gratuitos do ScraperAPI
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; 

app.get('/', (req, res) => {
    res.json({ status: 'online', message: 'Proxy Instagram via ScraperAPI ativo' });
});

app.get('/api/latest-post', async (req, res) => {
    const { username } = req.query;

    if (!username) {
        return res.status(400).json({ error: 'Username é obrigatório.' });
    }

    const cleanUser = username.trim().toLowerCase().replace(/^@/, '');

    // 1. Verifica se já está salvo no cache antes de gastar crédito da API
    const cached = cache.get(cleanUser);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        return res.json(cached.data);
    }

    const apiKey = process.env.SCRAPER_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'Variável SCRAPER_API_KEY não configurada na Render.' });
    }

    try {
        // Endpoint interno do perfil público
        const targetUrl = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(cleanUser)}`;
        
        // Roteia a requisição através do ScraperAPI para mascarar o IP
        const proxyUrl = `http://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}`;

        const response = await axios.get(proxyUrl, {
            headers: {
                'x-ig-app-id': '936619743392459',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            },
            timeout: 25000 // Proxies residenciais podem levar alguns segundos extras
        });

        const user = response.data?.data?.user;
        const edges = user?.edge_owner_to_timeline_media?.edges;

        if (!edges || edges.length === 0) {
            return res.status(404).json({ error: 'Nenhuma postagem encontrada ou perfil privado.' });
        }

        const latestPost = edges[0].node;
        const caption = latestPost.edge_media_to_caption?.edges[0]?.node?.text || '';

        // Usa a rota local de imagem para evitar bloqueio de CORS no navegador
        const hostUrl = `https://${req.get('host')}`;
        const proxiedImageUrl = `${hostUrl}/api/image-proxy?url=${encodeURIComponent(latestPost.display_url)}`;

        const resultData = {
            username: cleanUser,
            media_url: proxiedImageUrl,
            caption: caption,
            permalink: `https://www.instagram.com/p/${latestPost.shortcode}/`
        };

        // Salva no cache
        cache.set(cleanUser, { timestamp: Date.now(), data: resultData });

        return res.json(resultData);

    } catch (error) {
        console.error('Erro via ScraperAPI:', error.response?.status, error.message);
        return res.status(500).json({ 
            error: 'Não foi possível carregar o post.',
            status_code: error.response?.status || 500
        });
    }
});

// Rota proxy para carregar a imagem sem bloqueios no Tumblr
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
