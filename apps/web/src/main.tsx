// Fonts are bundled with the app (UI_UX.md §3: no internet). Latin and Latin-ext only.
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-ext-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-ext-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-ext-600.css';
import '@fontsource/fraunces/latin-600.css';
import '@fontsource/fraunces/latin-ext-600.css';
import './styles/tokens.css';
import './styles/base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { trackUserActivity } from './api/activity.ts';
import { App, createQueryClient } from './app/App.tsx';
import { applyBranding, savedBranding } from './branding/brand.ts';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');
trackUserActivity();
applyBranding(savedBranding());
createRoot(root).render(
  <StrictMode>
    <App client={createQueryClient()} />
  </StrictMode>,
);
