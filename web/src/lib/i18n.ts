import { useEffect, useState } from 'react';

const nl: Record<string, string> = {
  Dashboard: 'Dashboard', Files: 'Bestanden', Media: 'Media', Photos: "Foto's", Videos: "Video's", Movies: 'Films',
  'TV Shows': 'TV-series', Music: 'Muziek', Audiobooks: 'Luisterboeken', 'Request Movies': 'Media aanvragen', Downloads: 'Downloads',
  Collections: 'Collecties', History: 'Geschiedenis', Create: 'Maken', Documents: 'Documenten', Spreadsheets: 'Spreadsheets',
  'Image Editor': 'Afbeeldingseditor', 'AI Image Studio': 'AI-afbeeldingen', 'AI Music Studio': 'AI-muziek', 'AI Assistant': 'AI-assistent',
  System: 'Systeem', Jobs: 'Taken', Automations: 'Automatiseringen', Backups: 'Back-ups', 'Folder Sync': 'Map synchronisatie',
  Monitoring: 'Bewaking', 'Library Tools': 'Bibliotheekbeheer', Admin: 'Beheer', Integrations: 'Integraties', Settings: 'Instellingen',
  'Get the Apps': 'Apps downloaden', Home: 'Start', Search: 'Zoeken', 'Search everything…': 'Alles doorzoeken…',
  Devices: 'Apparaten', 'Sign out': 'Uitloggen', 'private cloud': 'privécloud',
};

export function translate(value: string, lang = document.documentElement.lang) { return lang === 'nl' ? nl[value] || value : value; }

export function useLanguage() {
  const [lang, setLang] = useState(() => document.documentElement.lang || 'en');
  useEffect(() => { const on = (e: Event) => setLang((e as CustomEvent).detail || document.documentElement.lang); window.addEventListener('aerie-language', on); return () => window.removeEventListener('aerie-language', on); }, []);
  return { lang, t: (value: string) => translate(value, lang) };
}
