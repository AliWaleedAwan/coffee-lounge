// The guest app (P3-2). Fonts are bundled: guest phones may have no internet.
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/fraunces/latin-600.css';
import '../styles/tokens.css';
import '../styles/base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyBranding, savedBranding } from '../branding/brand.ts';
import { createGuestQueryClient, GuestApp } from './GuestApp.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from guest.html');
applyBranding(savedBranding());
createRoot(root).render(
  <StrictMode>
    <GuestApp client={createGuestQueryClient()} />
  </StrictMode>,
);
