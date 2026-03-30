import { useEffect, useRef, useState } from 'react';
import { mountCanvas, unmountCanvas } from './engine/threeEngine.js';
import { loadPage, setLoadingCallback, resetPhysicsScene } from './engine/sceneManager.js';
import NavMenu from './components/NavMenu.jsx';
import HelpPage from './components/HelpPage.jsx';
import DaePlayer from './components/DaePlayer.jsx';
import './App.css';

const PAGES_JSON  = '/models/pages.json';
const MODELS_JSON = '/models/models.json';

// Promise mise en cache au niveau module : un seul fetch quelle que soit
// le nombre de montages React (StrictMode monte deux fois en développement).
let configPromise = null;
function fetchConfig() {
  if (!configPromise) {
    configPromise = Promise.all([
      fetch(PAGES_JSON).then((r) => r.json()),
      fetch(MODELS_JSON).then((r) => r.json()),
    ]).then(([pagesData, modelsData]) => {
      // Construire un index id → config modèle
      const modelsMap = Object.fromEntries(modelsData.map((m) => [m.id, m]));

      // Résoudre les IDs de modèles et de marqueurs dans chaque page
      return pagesData.map((page) => ({
        ...page,
        // models : string ID → config complète (rétrocompatible si déjà un objet)
        models: (page.models ?? [])
          .map((ref) => (typeof ref === 'string' ? modelsMap[ref] : ref))
          .filter(Boolean),
        // markers : string ID → { path, …model.marker }
        //           objet { id, … } → fusion model.marker + overrides locaux (rétrocompat)
        //           objet { path, … } → utilisé tel quel
        markers: page.markers?.map((marker) => {
          if (typeof marker === 'string') {
            const model = modelsMap[marker];
            return model?.marker ? { ...model.marker, path: model.path } : null;
          }
          if (marker.id && !marker.path) {
            const model = modelsMap[marker.id];
            if (model) return { ...(model.marker ?? {}), ...marker, path: model.path };
          }
          return marker;
        }).filter(Boolean),
      }));
    });
  }
  return configPromise;
}

export default function App() {
  const mountRef = useRef(null);
  const [pages, setPages] = useState([]);
  const [currentPageId, setCurrentPageId] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  // ── Chargement du JSON de config ────────────────────────────────────────
  useEffect(() => {
    fetchConfig()
      .then((data) => {
        setPages(data);
        setCurrentPageId(data[0]?.id ?? null);
      })
      .catch((err) => console.error('[App] Impossible de charger pages.json :', err));
  }, []);

  // ── Montage du canvas Three.js (une seule fois par session) ─────────────
  useEffect(() => {
    mountCanvas(mountRef.current);
    setLoadingCallback(setIsLoading);

    return () => {
      unmountCanvas();
    };
  }, []);

  // ── Chargement de la scène à chaque changement de page ──────────────────
  useEffect(() => {
    if (!currentPageId || pages.length === 0) return;
    const page = pages.find((p) => p.id === currentPageId);
    if (page) loadPage(page);
  }, [currentPageId, pages]);

  const currentPage = pages.find((p) => p.id === currentPageId);

  return (
    <div style={{ width: '100vw', height: '100vh', overflow: 'hidden', position: 'relative' }}>
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />
      {currentPage?.controls === 'help' && <HelpPage />}
      {currentPage?.controls === 'physics' && (
        <button className="physics-reset-btn" onClick={resetPhysicsScene}>
          ↺ Réinitialiser
        </button>
      )}
      {currentPage?.controls === 'dae' && <DaePlayer key={currentPageId} />}
      <NavMenu
        pages={pages}
        currentPageId={currentPageId}
        onNavigate={setCurrentPageId}
        isLoading={isLoading}
      />
    </div>
  );
}
