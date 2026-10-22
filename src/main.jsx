import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// Props mirror the original design's tweakable options:
//   startScreen: 'app' | 'onboarding'   accent: 'orange' | 'indigo'
//   statusStyle: 'brand' | 'semantic'   dark: boolean
createRoot(document.getElementById('root')).render(<App />);
