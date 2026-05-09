import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Route, Routes } from 'react-router-dom'

import ErrorBoundary from './components/ErrorBoundary'
import HomePage from './pages/HomePage'
import DebugPage from './pages/DebugPage'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/debug" element={<DebugPage />} />
          <Route path="/debug/:runName" element={<DebugPage />} />
        </Routes>
      </HashRouter>
    </ErrorBoundary>
  </StrictMode>
)
