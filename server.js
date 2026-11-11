const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

app.get('/api/latest-post', async (req, res) => {
    const { username } = req.query;

    if (!username) {
        return res.status(400).json({ error: 'Username é obrigatório.' });
    }

    try {
        // Usa o endpoint web_profile_info com o App-ID público da web do Instagram
        const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
        
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
                'x-ig-app-id': '936619743392459', // ID padrão público do Instagram Web
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': 'https://www.instagram.com',
                'Referer': `https://www.instagram.com/${username}/`
            }
        });

        const user = response.data?.data?.user;
        const edges = user?.edge_owner_to_timeline_media?.edges;

        if (!edges || edges.length === 0) {
            return res.status(404).json({ error: 'Nenhuma postagem encontrada ou perfil privado.' });
        }

        // Pega o nó da postagem mais recente
        const latestPost = edges[0].node;
        const caption = latestPost.edge_media_to_caption?.edges[0]?.node?.text || '';

        return res.json({
            username: username,
            media_url: latestPost.display_url,
            caption: caption,
            permalink: `https://www.instagram.com/p/${latestPost.shortcode}/`
        });

    } catch (error) {
        console.error('Erro detalhado:', error.response?.status, error.message);
        return res.status(500).json({ 
            error: 'Não foi possível carregar a imagem.',
            details: error.response?.status === 401 || error.response?.status === 429 
                ? 'O Instagram bloqueou temporariamente o IP do servidor.' 
                : error.message
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
