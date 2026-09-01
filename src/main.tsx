import React from 'react';
import ReactDOM from 'react-dom/client';

export function App(): React.JSX.Element {
  return (
    <main style={{ padding: '2rem', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <h1>Madhurita</h1>
      <p>Phase P01 Bootstrap Scaffold Active</p>
    </main>
  );
}

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
