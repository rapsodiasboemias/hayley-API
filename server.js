const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors()); // Permite chamadas do Tumblr sem erro de CORS

app.get('/api/latest-post', async (req, res) => {
    const { username } = req.query;

    if (!username) {
        return res.status(400).json({ error: 'Username é obrigatório.' });
    }

    try {
        // Tenta obter o HTML da página pública
        const url = `https://www.instagram.com/${username}/`;
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });

        const $ = cheerio.load(response.data);
        
        // Extrai metatags abertas
        const ogImage = $('meta[property="og:image"]').attr('content');
        const ogDescription = $('meta[property="og:description"]').attr('content');
        const ogUrl = $('meta[property="og:url"]').attr('content');

        if (!ogImage) {
            return res.status(404).json({ error: 'Post não encontrado ou perfil privado.' });
        }

        return res.json({
            username: username,
            media_url: ogImage,
            caption: ogDescription || '',
            permalink: ogUrl || `https://instagram.com/${username}`
        });

    } catch (error) {
        console.error('Erro ao buscar post:', error.message);
        return res.status(500).json({ error: 'Não foi possível carregar a imagem.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
