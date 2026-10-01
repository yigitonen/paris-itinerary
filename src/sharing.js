export function recapShareOptions({ title, text, url } = {}) {
  const options = {
    title: String(title || 'Roamly seyahat özeti'),
    text: String(text || '')
  };
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
      options.url = parsed.href;
    }
  } catch { /* A mobile recap needs only its title and text. */ }
  return options;
}
