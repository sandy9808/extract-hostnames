import React, { useState, useEffect } from 'react';
import { SiteHostnameInfo } from './types';
import './App.css';

const App: React.FC = () => {
  const [siteData, setSiteData] = useState<SiteHostnameInfo[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    console.log("Component mounted, connecting to SSE.");
    const eventSource = new EventSource('http://localhost:3001/api/data');

    eventSource.onopen = () => {
      console.log("SSE connection opened.");
      setLoading(false); // Stop loading when connection is open
    };

    eventSource.onmessage = (event) => {
      const siteInfo = JSON.parse(event.data);
      console.log("Received site:", siteInfo);
      setSiteData((prevData) => [...prevData, siteInfo]);
    };

    eventSource.onerror = (error) => {
      console.error("EventSource failed:", error);
      eventSource.close();
    };

    return () => {
      console.log("Closing SSE connection.");
      eventSource.close();
    };
  }, []);

  return (
    <div className="App">
      <header className="App-header">
        <h1>Site Hostname Information</h1>
      </header>
      <main>
        {loading ? (
          <p>Loading...</p>
        ) : (
          <div className="site-list">
            {siteData.map((siteInfo) => (
              <div key={siteInfo.sitePath} className="site-card">
                <h2>{siteInfo.sitePath}</h2>
                <div className="card-content">
                  <p><strong>Hostnames:</strong> {siteInfo.hostnames.join(', ')}</p>
                  <p><strong>Files:</strong> {siteInfo.bmNodeFiles.join(', ')}</p>
                  {siteInfo.errors.length > 0 && (
                    <p className="errors"><strong>Errors:</strong> {siteInfo.errors.join(', ')}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

export default App;