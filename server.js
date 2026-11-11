const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

app.get('/', (req, res) => {
    res.json({ status: 'online', message: 'Proxy Instagram ativo' });
});

app.get('/api/latest-post', async (req, res) => {
    const { username } = req.query;

    if (!username) {
        return res.status(400).json({ error: 'Username é obrigatório.' });
    }

    try {
        // Acessa a versão de embed do perfil (menos bloqueada pela Meta)
        const embedUrl = `https://www.instagram.com/${encodeURIComponent(username)}/embed/`;
        
        const response = await axios.get(embedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
            },
            timeout: 8000
        });

        const html = response.data;

        // O Instagram embute os dados do perfil dentro de um objeto JSON no script da página
        const match = html.match(/"edge_owner_to_timeline_media":\{"count":\d+,"page_info":\{.*?\},"edges":(\[.*?\])\}/);
        
        if (match && match[1]) {
            const edges = JSON.parse(match[1]);
            if (edges.length > 0) {
                const latestNode = edges[0].node;
                const caption = latestNode.edge_media_to_caption?.edges[0]?.node?.text || '';

                return res.json({
                    username: username,
                    media_url: latestNode.display_url,
                    caption: caption,
                    permalink: `https://www.instagram.com/p/${latestNode.shortcode}/`
                });
            }
        }

        // Fallback: tenta capturar a primeira imagem de postagem direto do HTML do embed
        const imgMatch = html.match(/class="EmbeddedMediaImage"[^>]+src="([^"]+)"/);
        const linkMatch = html.match(/href="(https:\/\/www\.instagram\.com\/p\/[^"\/]+\/)/);

        if (imgMatch && imgMatch[1]) {
            // Decodifica entidades HTML (&amp;) na URL da imagem
            const cleanImgUrl = imgMatch[1].replace(/&amp;/g, '&');
            return res.json({
                username: username,
                media_url: cleanImgUrl,
                caption: `Última publicação de @${username}`,
                permalink: linkMatch ? linkMatch[1] : `https://www.instagram.com/${username}/`
            });
        }

        return res.status(404).json({ error: 'Não foi possível extrair o post (perfil privado ou estrutura alterada).' });

    } catch (error) {
        console.error('Erro ao buscar embed:', error.message);
        return res.status(503).json({ 
            error: 'Serviço temporariamente indisponível.',
            fallback_url: `https://instagram.com/${username}`
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
