require('dotenv').config();
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const cheerio = require('cheerio');
const fs = require('fs');
const os = require('os');
const path = require('path');
let puppeteer;
let puppeteerAvailable = false;
try {
	puppeteer = require('puppeteer');
	puppeteerAvailable = true;
} catch (e) {
	console.warn('puppeteer not installed — screenshot fallback disabled');
}

const token = process.env.TELEGRAM_TOKEN;
if (!token) {
	console.error('ERROR: TELEGRAM_TOKEN is not set. See .env.example');
	process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

function mapWeatherCode(code) {
	// Simple mapping for Open-Meteo weather codes
	const map = {
		0: 'Cerah',
		1: 'Cerah Berawan',
		2: 'Berawan',
		3: 'Teredu/berawan tebal',
		45: 'Kabut',
		48: 'Kabut berdebu',
		51: 'Gerimis ringan',
		53: 'Gerimis sedang',
		55: 'Gerimis lebat',
		56: 'Hujan beku ringan',
		57: 'Hujan beku lebat',
		61: 'Hujan ringan',
		63: 'Hujan sedang',
		65: 'Hujan lebat',
		66: 'Hujan es ringan',
		67: 'Hujan es lebat',
		71: 'Salju ringan',
		73: 'Salju sedang',
		75: 'Salju lebat',
		80: 'Hujan lokal ringan',
		81: 'Hujan lokal sedang',
		82: 'Hujan lokal lebat',
		95: 'Badai Petir',
		96: 'Badai Petir dengan hujan ringan',
		99: 'Badai Petir dengan hujan lebat'
	};
	return map[code] || 'Tidak diketahui';
}

function mapWeatherCodeToIcon(code) {
	// Map Open-Meteo weather codes to OpenWeatherMap icon ids (day icons)
	// Reference: Open-Meteo codes -> approximate icon
	if (code === 0) return '01d'; // clear
	if (code === 1) return '02d'; // mainly clear
	if (code === 2) return '03d'; // partly cloudy
	if (code === 3) return '04d'; // overcast
	if (code === 45 || code === 48) return '50d'; // fog
	if (code >= 51 && code <= 57) return '09d'; // drizzle
	if (code >= 61 && code <= 67) return '10d'; // rain
	if (code >= 71 && code <= 75) return '13d'; // snow
	if (code >= 80 && code <= 82) return '09d'; // rain showers
	if (code >= 95 && code <= 99) return '11d'; // thunderstorm
	return '01d';
}

function escapeHtml(str) {
	if (!str) return '';
	return String(str).replace(/[&<>"]/g, function(s) {
		return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[s];
	});
}

function weatherColor(code) {
	// return a CSS color appropriate for weather
	// rain/drizzle -> blue, clear -> orange/yellow, snow/fog -> gray/teal, thunder -> purple
	if (!code && code !== 0) return '#0f172a';
	if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return '#0ea5e9'; // rain-ish blue
	if (code === 61 || code === 63 || code === 65) return '#0ea5e9';
	if (code === 0 || code === 1) return '#fb923c'; // clear/orange
	if (code === 2 || code === 3) return '#94a3b8'; // cloudy gray
	if (code >= 95 && code <= 99) return '#7c3aed'; // thunder purple
	if (code === 45 || code === 48) return '#64748b'; // fog
	return '#0f172a';
}

bot.onText(/\/start/, (msg) => {
	const chatId = msg.chat.id;
	const text = 'Halo! Saya bot cuaca sederhana. Gunakan /cuaca <lokasi> untuk melihat cuaca. Contoh: /cuaca Jakarta';
	bot.sendMessage(chatId, text);
});

bot.onText(/\/help/, (msg) => {
	const chatId = msg.chat.id;
	const text = '/cuaca <lokasi> — tampilkan cuaca saat ini untuk lokasi yang diberikan.\n/start — mulai percakapan.';
	bot.sendMessage(chatId, text);
});

bot.onText(/\/cuaca(?:\s+(.+))?/, async (msg, match) => {
	const chatId = msg.chat.id;
	const query = match[1];
	if (!query) {
		return bot.sendMessage(chatId, 'Gunakan: /cuaca <kota atau alamat>. Contoh: /cuaca Bandung');
	}

	const searching = await bot.sendMessage(chatId, `Mencari lokasi "${query}"...`);

	try {
		// Jika user memberi URL BMKG langsung, coba ambil gambar cuaca dari halaman tersebut.
		if (/^https?:\/\//i.test(query) && query.includes('bmkg.go.id')) {
			try {
				const page = await axios.get(query, { headers: { 'User-Agent': 'BOTPADIL/1.0 (+https://github.com/)' } });
				const $ = cheerio.load(page.data);

				// 1) Cek meta tags populer (og:image, twitter:image)
				let imageUrl = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');
				// 2) Cek link rel=image_src
				if (!imageUrl) imageUrl = $('link[rel="image_src"]').attr('href');

				// 3) Jika belum ada, cari atribut gambar umum (data-src, data-original, srcset, src)
				if (!imageUrl) {
					// cari gambar yang nama atau alt mengandung kata kunci
					const candidates = [];
					$('img').each((i, el) => {
						const $el = $(el);
						const attrs = [$el.attr('src'), $el.attr('data-src'), $el.attr('data-original'), $el.attr('data-srcset'), $el.attr('srcset')].filter(Boolean);
						const alt = $el.attr('alt') || '';
						const joined = attrs.join(' ')+ ' ' + alt;
						if (/cuaca|prakiraan|prakiraan-cuaca|forecast|ramalan|peta|map|kondisi|sis/i.test(joined)) {
							candidates.push(attrs[0] || attrs[1] || attrs[2]);
						}
					});

					if (candidates.length) imageUrl = candidates[0];
					// fallback: first useful image with .png/.jpg
					if (!imageUrl) {
						const fallback = $('img').toArray().map(el => $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-original')).filter(Boolean).find(u => /\.(png|jpe?g|gif)$/i.test(u));
						if (fallback) imageUrl = fallback;
					}
				}

				if (!imageUrl) {
					// fallback: ambil screenshot halaman menggunakan puppeteer
					if (!puppeteerAvailable) {
						await bot.editMessageText('Fitur screenshot tidak tersedia — `puppeteer` belum terinstal. Jalankan `npm install puppeteer` dan coba lagi.', { chat_id: chatId, message_id: searching.message_id });
						return;
					}
					try {
						const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
						const pageP = await browser.newPage();
						await pageP.setViewport({ width: 1200, height: 800 });
						await pageP.goto(query, { waitUntil: 'networkidle2', timeout: 30000 });

						// Coba screenshot elemen utama jika ada
						let screenshotPath = path.join(os.tmpdir(), `bmkg_${Date.now()}.png`);
						try {
							const mainEl = await pageP.$('main') || await pageP.$('#content') || await pageP.$('.container') || await pageP.$('article');
							if (mainEl) {
								await mainEl.screenshot({ path: screenshotPath });
							} else {
								await pageP.screenshot({ path: screenshotPath, fullPage: true });
							}
						} catch (se) {
							// fallback to full page screenshot
							await pageP.screenshot({ path: screenshotPath, fullPage: true });
						}

						await browser.close();

						// Kirim foto dari file sementara
						const stream = fs.createReadStream(screenshotPath);
						await bot.sendPhoto(chatId, stream, { caption: `Screenshot halaman BMKG: ${query}` });
						stream.close();
						try { fs.unlinkSync(screenshotPath); } catch(e){}
						await bot.deleteMessage(chatId, searching.message_id.toString()).catch(()=>{});
						return;
					} catch (puppErr) {
						console.error('puppeteer error:', puppErr && puppErr.message ? puppErr.message : puppErr);
						await bot.editMessageText('Gagal mengambil gambar atau screenshot dari halaman BMKG.', { chat_id: chatId, message_id: searching.message_id });
						return;
					}
				}

				if (imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;
				if (imageUrl.startsWith('/')) imageUrl = 'https://www.bmkg.go.id' + imageUrl;

				// Kirim gambar BMKG dengan caption, lalu hapus pesan pencarian
				await bot.sendPhoto(chatId, imageUrl, { caption: `Gambar dari BMKG: ${query}` });
				await bot.deleteMessage(chatId, searching.message_id.toString()).catch(()=>{});
				return;
			} catch (e) {
				console.error('BMKG scrape error:', e && e.message ? e.message : e);
				// lanjut ke flow normal jika scraping gagal
			}
		}

		// 1) Geocoding via Nominatim (OpenStreetMap)
		const nominatimUrl = 'https://nominatim.openstreetmap.org/search';
		const geores = await axios.get(nominatimUrl, {
			params: { format: 'json', q: query, limit: 1, addressdetails: 1 },
			headers: { 'User-Agent': 'BOTPADIL/1.0 (+https://github.com/)' }
		});

		if (!geores.data || geores.data.length === 0) {
			return bot.sendMessage(chatId, 'Lokasi tidak ditemukan. Coba kata kunci lain.');
		}

		const place = geores.data[0];
		const lat = place.lat;
		const lon = place.lon;

		// 2) Coba ambil data dari BMKG (placeholder) -- BMKG tidak punya API publik JSON konsisten.
		// Jika Anda punya endpoint BMKG spesifik, kita bisa langsung pakai itu. Saat ini pakai Open-Meteo sebagai fallback.

		const omUrl = 'https://api.open-meteo.com/v1/forecast';
		const omRes = await axios.get(omUrl, {
			params: {
				latitude: lat,
				longitude: lon,
				current_weather: true,
				daily: 'weathercode,temperature_2m_max,temperature_2m_min',
				timezone: 'auto'
			}
		});

		if (!omRes.data || !omRes.data.current_weather) {
			return bot.sendMessage(chatId, 'Gagal mendapatkan data cuaca untuk lokasi tersebut.');
		}

		const w = omRes.data.current_weather;
		const desc = mapWeatherCode(w.weathercode);
		const temp = w.temperature;
		const wind = w.windspeed;
		const direction = w.winddirection;

		const reply = `Cuaca untuk: ${place.display_name}\nStatus: ${desc}\nSuhu: ${temp}°C\nKecepatan angin: ${wind} km/h (arah ${direction}°)\nSumber: Open-Meteo (fallback).`;

		// Prepare 3-day forecast HTML snippet from Open-Meteo daily data
		let forecastHtml = '';
		try {
			const daily = omRes.data.daily || {};
			const times = daily.time || [];
			const codes = daily.weathercode || [];
			const tmax = daily.temperature_2m_max || [];
			const tmin = daily.temperature_2m_min || [];
			const daysToShow = 5; // show 5 days
			for (let i = 0; i < Math.min(daysToShow, times.length); i++) {
				const d = new Date(times[i]);
				const weekday = d.toLocaleDateString('id-ID', { weekday: 'short' }); // e.g., Sen
				const dateShort = d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }); // e.g., 13 Nov
				const icon = mapWeatherCodeToIcon(codes[i]);
				const iconSmall = `https://openweathermap.org/img/wn/${icon}@2x.png`;
				// choose color for small forecast box based on code
				const boxColor = weatherColor(codes[i]);
				forecastHtml += `
				  <div style="flex:1; text-align:center; margin:6px; background:rgba(255,255,255,0.03); padding:8px; border-radius:8px;">
				    <div style="font-weight:700; margin-bottom:6px;">${weekday}</div>
				    <div style="font-size:12px; color:#cbd5e1; margin-bottom:6px;">${dateShort}</div>
				    <div style="width:64px;height:64px;margin:0 auto;background:${boxColor};border-radius:8px;display:flex;align-items:center;justify-content:center;">
				      <img src=\"${iconSmall}\" style=\"width:48px;height:48px;\"/>
				    </div>
				    <div style=\"margin-top:6px; font-weight:600;\">${Math.round(tmax[i])}°/${Math.round(tmin[i])}°</div>
				  </div>`;
			}
		} catch (e) {
			forecastHtml = '';
		}

		// Try to send a representative card image (icon + text). Use puppeteer if available to render HTML->image.
		try {
			const iconId = mapWeatherCodeToIcon(w.weathercode);
			const iconUrl = `https://openweathermap.org/img/wn/${iconId}@4x.png`;

			if (puppeteer && puppeteerAvailable) {
				try {
					const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
					const pageP = await browser.newPage();
					const mainColor = weatherColor(w.weathercode);
					const html = `
						<!doctype html>
						<html>
						<head>
							<meta charset="utf-8"/>
							<style>
								body { font-family: Arial, Helvetica, sans-serif; margin:0; padding:0; }
								.card { width: 700px; padding: 24px; background: linear-gradient(180deg, ${mainColor}, #071024); color: #fff; display:flex; gap:20px; align-items:center; border-radius:12px; }
								.icon { width:200px; height:200px; flex:0 0 200px; }
								.info { flex:1; }
								.loc { font-size:20px; font-weight:700; margin-bottom:8px; }
								.status { font-size:18px; margin-bottom:12px; }
								.meta { font-size:16px; color:#d1d5db; }
								.row { margin-bottom:6px; }
								.forecast { display:flex; margin-top:12px; }
							</style>
						</head>
						<body>
							<div id="card" class="card">
								<div class="icon"><img src="${iconUrl}" width="200" height="200"/></div>
								<div class="info">
									<div class="loc">${escapeHtml(place.display_name)}</div>
									<div class="status">${escapeHtml(desc)}</div>
									<div class="meta">
										<div class="row">Suhu: <strong>${temp}°C</strong></div>
										<div class="row">Kecepatan angin: <strong>${wind} km/h</strong> (arah ${direction}°)</div>
										<div class="row">Sumber: Open-Meteo (fallback)</div>
									</div>
									<div class="forecast">
										${forecastHtml}
									</div>
								</div>
							</div>
						</body>
						</html>`;

					await pageP.setContent(html, { waitUntil: 'networkidle0' });
					const el = await pageP.$('#card') || await pageP.$('body');
					const screenshotPath = path.join(os.tmpdir(), `weather_${Date.now()}.png`);
					await el.screenshot({ path: screenshotPath });
					await browser.close();

					const stream = fs.createReadStream(screenshotPath);
					await bot.sendPhoto(chatId, stream, { caption: reply });
					stream.close();
					try { fs.unlinkSync(screenshotPath); } catch(e){}
					await bot.deleteMessage(chatId, searching.message_id.toString()).catch(()=>{});
				} catch (errCard) {
					console.error('card render error', errCard && errCard.message ? errCard.message : errCard);
					// fallback to sending icon image only
					await bot.sendPhoto(chatId, iconUrl, { caption: reply });
					await bot.deleteMessage(chatId, searching.message_id.toString()).catch(()=>{});
				}
			} else {
				// puppeteer not available: send icon only with caption
				await bot.sendPhoto(chatId, iconUrl, { caption: reply });
				await bot.deleteMessage(chatId, searching.message_id.toString()).catch(()=>{});
			}
		} catch (e) {
			console.error('send icon/card error', e && e.message ? e.message : e);
			await bot.editMessageText(reply, { chat_id: chatId, message_id: searching.message_id });
		}
	} catch (err) {
		console.error(err && err.message ? err.message : err);
		try { await bot.sendMessage(chatId, 'Terjadi kesalahan saat mengambil data cuaca. Coba lagi nanti.'); } catch (e) {}
	}
});

console.log('Bot berjalan. Menunggu perintah...');

