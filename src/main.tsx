import React from 'react';
import ReactDOM from 'react-dom/client';
import { pickRoot } from './main-root';

/**
 * Entry point for the React application.
 *
 * Delegates root selection to `main-root.tsx` so the routing logic can be
 * tested in isolation without triggering `createRoot` as a module side-effect.
 */
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{pickRoot(window.location.search)}</React.StrictMode>,
);
