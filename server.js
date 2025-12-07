require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

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

// Generate a PNG card for the query. Requires puppeteer; if missing, returns 501 with JSON message.
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

    // For open-meteo, render HTML and screenshot it
    const html = buildCardHtml(data, days);

    let puppeteer;
    try{
      puppeteer = require('puppeteer');
    }catch(e){
      return res.status(501).json({ error: 'puppeteer-not-installed', message: 'Server-side PNG generation requires puppeteer. Install it to enable this feature.' });
    }

    const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
    try{
      const page = await browser.newPage();
      await page.setViewport({ width: 900, height: 420, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const clip = await page.$('body');
      const buffer = await clip.screenshot({ type: 'png' });
      res.set('Content-Type', 'image/png');
      return res.send(buffer);
    }finally{
      await browser.close();
    }

  }catch(err){
    return res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

function buildCardHtml(data, days){
  const cur = data.current || {};
  const daily = data.daily || {};
  const times = daily.time || [];
  const codes = daily.weathercode || [];
  const tmax = daily.temperature_2m_max || [];
  const tmin = daily.temperature_2m_min || [];
  const daysToShow = Math.min(times.length, Math.max(1, Number(days) || 5));

  function mapIcon(code){
    if (code === 0) return '01d';
    if (code === 1) return '02d';
    if (code === 2) return '03d';
    if (code === 3) return '04d';
    if (code === 45 || code === 48) return '50d';
    if (code >= 51 && code <= 57) return '09d';
    if (code >= 61 && code <= 67) return '10d';
    if (code >= 71 && code <= 75) return '13d';
    if (code >= 80 && code <= 82) return '09d';
    if (code >= 95 && code <= 99) return '11d';
    return '01d';
  }

  const forecastHtml = Array.from({length: daysToShow}).map((_,i)=>{
    const d = new Date(times[i] || Date.now()).toLocaleDateString('id-ID',{weekday:'short',day:'numeric',month:'short'});
    const icon = mapIcon(codes[i] || 0);
    return `<div class="forecast-item"><div class="fw">${d}</div><img src="https://openweathermap.org/img/wn/${icon}@2x.png"/></div>`;
  }).join('');

  const mainIcon = mapIcon(cur.weathercode || 0);
  const iconUrl = `https://openweathermap.org/img/wn/${mainIcon}@4x.png`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cuaca</title>
    <style>
      body{font-family:Segoe UI, Roboto, Arial, sans-serif;margin:0;padding:18px;background:#f6f8fb}
      .card{display:flex;gap:18px;align-items:center;background:white;padding:14px;border-radius:10px;box-shadow:0 8px 30px rgba(20,30,60,0.08);width:860px}
      .card-left img{display:block}
      .loc{font-size:20px;font-weight:700}
      .status{color:#444;margin-top:6px}
      .meta{color:#666;margin-top:8px}
      .forecast{display:flex;gap:10px;margin-top:12px}
      .forecast-item{background:#f4f6fb;padding:8px;border-radius:8px;min-width:92px;text-align:center}
    </style>
  </head><body>
    <div class="card">
      <div class="card-left"><img src="${iconUrl}" width="160" height="160"/></div>
      <div class="card-right">
        <div class="loc">${escapeHtml(data.place || '')}</div>
        <div class="status">Suhu: <strong>${cur.temperature}°C</strong> &nbsp; Angin: <strong>${cur.windspeed} km/h</strong></div>
        <div class="forecast">${forecastHtml}</div>
      </div>
    </div>
  </body></html>`;
}

function escapeHtml(s){ return String(s||'').replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
