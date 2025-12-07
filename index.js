const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();

// Serve static files
app.use(express.static('public'));

async function fetchWeatherData(q, days = 5){
  if (!q) throw new Error('q required');
  // If BMKG URL, try scraping image
  if (/^https?:\/\//i.test(q) && q.includes('bmkg.go.id')){
    const page = await axios.get(q, { headers: { 'User-Agent': 'BOTPADIL/1.0 (+https://github.com/)' } });
    const $ = cheerio.load(page.data);
    let imageUrl = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');
    if (!imageUrl) imageUrl = $('link[rel="image_src"]').attr('href');
    if (!imageUrl) {
      const candidates = [];
      $('img').each((i, el) => {
        const $el = $(el);
        const attrs = [$el.attr('src'), $el.attr('data-src'), $el.attr('data-original')].filter(Boolean).join(' ');
        const alt = $el.attr('alt') || '';
        if (/cuaca|prakiraan|forecast|peta|map|kondisi/i.test(attrs + ' ' + alt)) candidates.push($el.attr('src') || $el.attr('data-src') || $el.attr('data-original'));
      });
      if (candidates.length) imageUrl = candidates[0];
    }
    if (imageUrl) {
      if (imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;
      if (imageUrl.startsWith('/')) imageUrl = 'https://www.bmkg.go.id' + imageUrl;
      return { source: 'bmkg', imageUrl };
    }
    return { source: 'bmkg', imageUrl: null, message: 'no-image-found' };
  }

  // Treat as location string: geocode via Nominatim
  const nominatimUrl = 'https://nominatim.openstreetmap.org/search';
  const geores = await axios.get(nominatimUrl, {
    params: { format: 'json', q: q, limit: 1, addressdetails: 1 },
    headers: { 'User-Agent': 'BOTPADIL/1.0 (+https://github.com/)' }
  });

  if (!geores.data || geores.data.length === 0) return { error: 'location not found' };

  const place = geores.data[0];
  const lat = place.lat;
  const lon = place.lon;

  const omUrl = 'https://api.open-meteo.com/v1/forecast';
  const omRes = await axios.get(omUrl, {
    params: { latitude: lat, longitude: lon, current_weather: true, daily: 'weathercode,temperature_2m_max,temperature_2m_min', timezone: 'auto' }
  });

  if (!omRes.data || !omRes.data.current_weather) return { error: 'failed to get weather' };

  // trim daily arrays to requested days
  const daily = omRes.data.daily || {};
  const limit = Math.max(1, Math.min(14, Number(days) || 5));
  const sliceDaily = {};
  Object.keys(daily).forEach(k => {
    if (Array.isArray(daily[k])) sliceDaily[k] = daily[k].slice(0, limit);
    else sliceDaily[k] = daily[k];
  });

  return {
    source: 'open-meteo',
    place: place.display_name,
    lat, lon,
    current: omRes.data.current_weather,
    daily: sliceDaily
  };
}

app.get('/api/cuaca', async (req, res) => {
  const q = req.query.q;
  const days = req.query.days || 5;
  if (!q) return res.status(400).json({ error: 'q parameter required' });
  try{
    const data = await fetchWeatherData(q, days);
    if (data.error) return res.status(500).json({ error: data.error });
    return res.json(data);
  }catch(err){
    return res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// Generate a PNG card for the query
app.get('/api/card', async (req, res) => {
  const q = req.query.q;
  const days = req.query.days || 5;
  if (!q) return res.status(400).json({ error: 'q parameter required' });

  try{
    const data = await fetchWeatherData(q, days);
    if (data.source === 'bmkg'){
      if (data.imageUrl){
        // fetch and proxy image bytes
        const imgRes = await axios.get(data.imageUrl, { responseType: 'arraybuffer' });
        const contentType = imgRes.headers['content-type'] || 'image/jpeg';
        res.set('Content-Type', contentType);
        return res.send(Buffer.from(imgRes.data));
      }
      return res.status(404).json({ error: 'no-bmkg-image' });
    }

    // For open-meteo, return JSON instead of PNG (puppeteer not available on Vercel)
    return res.status(501).json({ 
      error: 'puppeteer-not-available', 
      message: 'Server-side PNG generation not available on serverless. Use /api/cuaca instead.',
      data: data 
    });

  }catch(err){
    return res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// For local development
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
}

// Export for Vercel serverless
module.exports = app;
