const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

// Cache em memória de 60 minutos para economizar seus créditos gratuitos
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

    // Verifica cache
    const cached = cache.get(cleanUser);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        return res.json(cached.data);
    }

    const apiKey = process.env.SCRAPER_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'Variável SCRAPER_API_KEY não configurada na Render.' });
    }

    try {
        // Acessa a página pública padrão com render=true para carregar o feed via navegador real
        const targetUrl = `https://www.instagram.com/${encodeURIComponent(cleanUser)}/`;
        const proxyUrl = `http://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}&render=true`;

        const response = await axios.get(proxyUrl, {
            timeout: 45000 // Renderização de página leva cerca de 10-20s
        });

        const html = response.data;
        const $ = cheerio.load(html);

        // Procura o link do primeiro post (/p/ ou /reel/) e a imagem dentro dele
        let mediaUrl = null;
        let permalink = null;
        let caption = '';

        $('a[href*="/p/"], a[href*="/reel/"]').each((i, el) => {
            if (mediaUrl) return; // Já encontrou o primeiro post
            
            const href = $(el).attr('href');
            const img = $(el).find('img').first();
            const src = img.attr('src');

            if (href && src) {
                permalink = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
                mediaUrl = src;
                caption = img.attr('alt') || `Última publicação de @${cleanUser}`;
            }
        });

        if (!mediaUrl) {
            return res.status(404).json({ 
                error: 'Não foi possível localizar postagens na página (perfil privado ou bloqueio de login).' 
            });
        }

        // Roteia a imagem pelo proxy local para evitar bloqueio CORS/CORP no Tumblr
        const hostUrl = `https://${req.get('host')}`;
        const proxiedImageUrl = `${hostUrl}/api/image-proxy?url=${encodeURIComponent(mediaUrl)}`;

        const resultData = {
            username: cleanUser,
            media_url: proxiedImageUrl,
            caption: caption,
            permalink: permalink
        };

        cache.set(cleanUser, { timestamp: Date.now(), data: resultData });

        return res.json(resultData);

    } catch (error) {
        console.error('Erro via ScraperAPI:', error.response?.status, error.message);
        return res.status(500).json({ 
            error: 'Não foi possível carregar o post.',
            status_code: error.response?.status || 500,
            details: error.response?.data || error.message
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
