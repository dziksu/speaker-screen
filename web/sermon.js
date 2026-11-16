export const DEFAULT_SERMON = Object.freeze({ enabled: true, polishEdition: 'bw', englishEdition: 'kjv', names: '', glossary: '' });

export function sermonSettings(value) {
  const saved = value && typeof value === 'object' ? value : {};
  return {
    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : true,
    polishEdition: ['bw', 'ubg'].includes(saved.polishEdition) ? saved.polishEdition : 'bw',
    englishEdition: ['kjv', 'mkjv'].includes(saved.englishEdition) ? saved.englishEdition : 'kjv',
    names: typeof saved.names === 'string' ? saved.names.slice(0, 240) : '',
    glossary: typeof saved.glossary === 'string' ? saved.glossary.slice(0, 1000) : ''
  };
}

export function sermonConfig(value) {
  const profile = sermonSettings(value);
  if (!profile.enabled) return { enabled: false };
  const lines = profile.glossary.split('\n').filter(line => line.trim());
  if (lines.length > 12) throw new Error('Słownik kazania może zawierać maksymalnie 12 wpisów.');
  for (const line of lines) {
    const separator = line.indexOf('=');
    const parts = separator < 0 ? [] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    if (parts.length !== 2 || parts.some(part => !part || part.length > 60)) throw new Error('Popraw słownik kazania: jeden wpis w wierszu, polski termin = English term (do 60 znaków na termin).');
  }
  return { enabled: true, polish_edition: profile.polishEdition, english_edition: profile.englishEdition, names: profile.names, glossary: profile.glossary };
}
