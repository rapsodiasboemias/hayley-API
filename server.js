const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

app.get('/api/latest-post', async (req, res) => {
    const { username } = req.query;

    if (!username) {
        return res.status(400).json({ error: 'Username é obrigatório.' });
    }

    // Lista de instâncias públicas de RSS/Bridge para fallback
    const bridges = [
        `https://rss-bridge.org/bridge01/?action=display&bridge=InstagramBridge&context=Username&u=${encodeURIComponent(username)}&format=Atom`,
        `https://rsshub.app/instagram/user/${encodeURIComponent(username)}`
    ];

    for (const bridgeUrl of bridges) {
        try {
            const response = await axios.get(bridgeUrl, {
                timeout: 5000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
                }
            });

            const $ = cheerio.load(response.data, { xmlMode: true });
            
            // Pega o primeiro item/entry da lista (post mais recente)
            const firstEntry = $('entry, item').first();
            
            if (firstEntry.length) {
                const link = firstEntry.find('link').attr('href') || firstEntry.find('link').text();
                const contentHtml = firstEntry.find('content, description').text();
                
                // Extrai a URL da imagem de dentro do HTML da descrição
                const $content = cheerio.load(contentHtml);
                const mediaUrl = $content('img').first().attr('src');
                const caption = $content.text().trim();

                if (mediaUrl) {
                    return res.json({
                        username: username,
                        media_url: mediaUrl,
                        caption: caption || '',
                        permalink: link || `https://instagram.com/${username}`
                    });
                }
            }
        } catch (err) {
            console.log(`Falha ao consultar bridge (${bridgeUrl}):`, err.message);
            // Continua para a próxima bridge se houver erro
        }
    }

    // Se todas as pontes falharem, retorna o fallback estruturado
    return res.status(503).json({ 
        error: 'Serviço temporariamente indisponível.',
        fallback_url: `https://instagram.com/${username}`
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
