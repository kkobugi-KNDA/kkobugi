import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import WorkspaceErrorBoundary from './components/WorkspaceErrorBoundary';
import './styles.css';
import './theme.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WorkspaceErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </WorkspaceErrorBoundary>
  </React.StrictMode>,
);
