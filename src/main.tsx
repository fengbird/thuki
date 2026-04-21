import React from 'react';
import ReactDOM from 'react-dom/client';
import { pickRoot } from './main-root';
import { installGlobalErrorReporter } from './utils/crashReporter';

/**
 * Entry point for the React application.
 *
 * Delegates root selection to `main-root.tsx` so the routing logic can be
 * tested in isolation without triggering `createRoot` as a module side-effect.
 */

// Uncaught JS errors + promise rejections are forwarded to the Rust
// crash reporter so the user has a single folder to share with us.
// Installed before the render so boot-time exceptions are also caught.
installGlobalErrorReporter();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{pickRoot(window.location.search)}</React.StrictMode>,
);
